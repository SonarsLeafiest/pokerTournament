#!/usr/bin/env python3
"""
Anthropic SDK Poker Agent

Uses the Anthropic Python SDK directly instead of the claude CLI subprocess,
enabling two major speedups:

  Prompt caching   — the static game context (rules + personality) is marked
                     with cache_control so Anthropic re-uses it for 5 minutes.
                     Only the changing hand state is processed fresh each action.

  Response prefill — the assistant turn starts with '{"action":' so the model
                     skips any preamble and continues straight to the JSON value.
                     This eliminates "Sure! Here is my decision:" style output.

Typical latency: 1-2 s (vs 10-15 s via CLI subprocess).

Setup:
  pip install -r requirements.txt
  ANTHROPIC_API_KEY=sk-ant-...  python3 agent.py
"""

import asyncio
import json
import os
import anthropic
import websockets
from dotenv import load_dotenv

load_dotenv()

SERVER_URL  = os.environ.get("POKER_SERVER",       "ws://localhost:3000")
AGENT_ID    = os.environ.get("AGENT_ID",           "sdk-agent-1")
AGENT_NAME  = os.environ.get("AGENT_NAME",         "SDKBot")
MODEL       = os.environ.get("CLAUDE_MODEL",       "claude-haiku-4-5-20251001")
PERSONALITY = os.environ.get("AGENT_PERSONALITY",  "")

client = anthropic.Anthropic()

RANK_LABELS = {14: "A", 13: "K", 12: "Q", 11: "J", 10: "T"}
SUIT_LABELS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}


def fmt_card(c: dict) -> str:
    return f"{RANK_LABELS.get(c['rank'], c['rank'])}{SUIT_LABELS.get(c['suit'], c['suit'])}"


def fmt_cards(cards: list) -> str:
    return " ".join(fmt_card(c) for c in cards) if cards else "none"


# ── Cached content ────────────────────────────────────────────────────────────
# Built once at startup.  The text block carrying cache_control is only
# re-processed when the cache expires (5 minutes) — saving input tokens and
# latency on every action in between.

def _build_static_context() -> str:
    style = f"\nYour playing style: {PERSONALITY}\n" if PERSONALITY else ""
    return f"""You are playing Texas Hold'em in a poker tournament.{style}
Rules:
- Valid actions: FOLD, CHECK, CALL, RAISE
- If you RAISE, include the total bet amount as "amount"
- Respond ONLY with a JSON object — no preamble, no explanation outside JSON
- Format: {{"action":"FOLD|CHECK|CALL|RAISE","amount":<int if RAISE>,"reasoning":"<one sentence>"}}"""

STATIC_CONTEXT = _build_static_context()


# ── Dynamic content ───────────────────────────────────────────────────────────
# Changes every hand — not cached.

def _bounty_section(state: dict) -> str:
    b = state.get("activeBounty")
    if not b:
        return ""
    r, exp, tid = b["reward"], b["expiresAfterHand"], b["targetId"]
    if tid == AGENT_ID:
        return (f"\n⚠️ BOUNTY ON YOU: Opponents earn {r:,} bonus chips if they eliminate you "
                f"before hand {exp}. Play conservatively.\n")
    at_table = any(p["id"] == tid for p in state.get("players", []))
    if at_table:
        return (f"\n💰 BOUNTY TARGET AT TABLE: {b['targetName']} worth {r:,} chips "
                f"if eliminated before hand {exp}. Widen your range against them.\n")
    return f"\n💰 ACTIVE BOUNTY: {b['targetName']} at another table ({r:,} chips, exp. h.{exp}).\n"


def build_hand_prompt(state: dict) -> str:
    valid    = state["validActions"]
    raise_rng = f"\n  Raise range: {state['minRaise']} – {state['maxRaise']}" if "RAISE" in valid else ""
    opponents = "\n".join(
        f"  - {p['id']}: stack={p['stack']:,}, bet={p['bet']}, "
        f"{'folded' if p['folded'] else 'all-in' if p['allIn'] else 'active'}"
        for p in state.get("players", [])
    )
    return f"""{_bounty_section(state)}
YOUR HAND:    {fmt_cards(state['holeCards'])}
COMMUNITY:    {fmt_cards(state['communityCards'])}
STAGE:        {state.get('stage','?')}  (hand #{state.get('handNumber','?')})
POSITION:     {state.get('position','?')}
POT:          {state['pot']:,}
MY STACK:     {state['myStack']:,}
MY BET:       {state['myBet']:,}
CURRENT BET:  {state['currentBet']:,}
OPPONENTS:
{opponents or '  (none visible)'}

VALID ACTIONS: {', '.join(valid)}{raise_rng}"""


# ── Decision logic ────────────────────────────────────────────────────────────

def _extract_json(prefill: str, continuation: str) -> dict:
    """Reconstruct and parse the JSON assembled from prefill + model continuation."""
    raw = prefill + continuation
    # Walk to the first complete balanced object in case model added trailing text
    depth = 0
    for i, ch in enumerate(raw):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(raw[: i + 1])
    return json.loads(raw)  # fallback — let json.loads raise a clear error


PREFILL = '{"action":'

async def decide(state: dict) -> dict:
    try:
        resp = await asyncio.to_thread(
            client.messages.create,
            model=MODEL,
            max_tokens=120,
            messages=[
                {
                    "role": "user",
                    "content": [
                        # Cached block — rules + personality, reused across hands
                        {"type": "text", "text": STATIC_CONTEXT,
                         "cache_control": {"type": "ephemeral"}},
                        # Fresh block — current hand state
                        {"type": "text", "text": build_hand_prompt(state)},
                    ],
                },
                # Prefill: model continues from here, skipping any preamble
                {"role": "assistant", "content": PREFILL},
            ],
        )

        decision  = _extract_json(PREFILL, resp.content[0].text)
        action    = decision.get("action", "FOLD").upper()
        reasoning = decision.get("reasoning", "")

        if reasoning:
            amt = f" {decision.get('amount')}" if action == "RAISE" else ""
            print(f"  [{AGENT_NAME}] {action}{amt} — {reasoning}")

        if action not in state["validActions"]:
            return {"action": "FOLD"}

        out = {"action": action}
        if action == "RAISE" and "amount" in decision:
            amt = max(state["minRaise"], min(state["maxRaise"], int(decision["amount"])))
            out["amount"] = amt
        return out

    except Exception as e:
        print(f"  [{AGENT_NAME}] error: {e} — folding")
        return {"action": "FOLD"}


# ── WebSocket loop ────────────────────────────────────────────────────────────

async def run() -> None:
    print(f"Connecting to {SERVER_URL} as {AGENT_NAME} ({AGENT_ID}) via Anthropic SDK [{MODEL}]")

    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({"type": "register", "agentId": AGENT_ID, "agentName": AGENT_NAME}))

        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "register_ack":
                print(f"  [{AGENT_NAME}] registered. "
                      f"Reasoning window: {msg['timeLimitMs']}ms  "
                      f"Setup window: {msg.get('setupMs','?')}ms")

            elif msg["type"] == "action_required":
                await ws.send(json.dumps({"type": "action_ack", "gameId": msg["gameId"]}))
                action = await decide(msg)
                await ws.send(json.dumps({"type": "action", "gameId": msg["gameId"], **action}))

            elif msg["type"] == "hand_result":
                delta = msg.get("deltas", {}).get(AGENT_ID)
                if delta is not None and delta != 0:
                    print(f"  [{AGENT_NAME}] hand #{msg['handNumber']}  "
                          f"{'+' if delta > 0 else ''}{delta}")
                if msg.get("showdown") and msg.get("communityCards"):
                    board  = fmt_cards(msg["communityCards"])
                    hands  = ", ".join(
                        f"{s['playerId']} {fmt_cards(s['holeCards'])}"
                        + (f" ({s['handRank']})" if s.get("handRank") else "")
                        for s in msg["showdown"]
                    )
                    print(f"  [{AGENT_NAME}] Board: {board}  ·  {hands}")

            elif msg["type"] == "bounty_announced":
                if msg["targetId"] == AGENT_ID:
                    print(f"\n  [{AGENT_NAME}] ⚠️ BOUNTY ON ME! "
                          f"+{msg['reward']} chips, expires h.{msg['expiresAfterHand']}\n")
                else:
                    print(f"  [{AGENT_NAME}] 💰 Bounty: {msg['targetName']} "
                          f"+{msg['reward']}, exp. h.{msg['expiresAfterHand']}")

            elif msg["type"] == "bounty_claimed":
                if msg["claimedById"] == AGENT_ID:
                    print(f"  [{AGENT_NAME}] 🎯 Claimed bounty on {msg['targetName']}! +{msg['reward']}")
                else:
                    print(f"  [{AGENT_NAME}] 💰 {msg['claimedByName']} claimed bounty on {msg['targetName']}")

            elif msg["type"] == "bounty_expired":
                print(f"  [{AGENT_NAME}] ⌛ Bounty on {msg['targetName']} expired")

            elif msg["type"] == "bounty_curse_required":
                target = max(msg["availableTargets"], key=lambda t: t["stack"])
                await ws.send(json.dumps({"type": "bounty_curse", "targetId": target["id"]}))
                print(f"  [{AGENT_NAME}] 💀 Cursing {target['name']} (-{msg['curseAmount']} chips)")

            elif msg["type"] == "bounty_cursed":
                if msg["targetId"] == AGENT_ID:
                    print(f"  [{AGENT_NAME}] 😤 Cursed by {msg['curserName']} — -{msg['amount']} chips!")

            elif msg["type"] == "tournament_update":
                me = next((p for p in msg["standings"] if p["playerId"] == AGENT_ID), None)
                if me:
                    print(f"  [{AGENT_NAME}] Stack: {me['stack']:,}  |  "
                          f"Blinds {msg['smallBlind']}/{msg['bigBlind']}")

            elif msg["type"] == "tournament_end":
                if msg["result"] == "won":
                    print(f"\n  [{AGENT_NAME}] 🏆 TOURNAMENT WINNER!  "
                          f"Final stack: {msg['finalStack']:,}\n")
                else:
                    print(f"\n  [{AGENT_NAME}] Finished #{msg['place']}  "
                          f"Final stack: {msg['finalStack']:,}\n")
                break

            elif msg["type"] == "error":
                print(f"  [{AGENT_NAME}] server error: {msg['message']}")


if __name__ == "__main__":
    asyncio.run(run())
