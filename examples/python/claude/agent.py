"""
Anthropic SDK Poker Agent  (examples/python/claude/)

Uses the Anthropic Python SDK with prompt caching and response prefilling
for fast, low-latency decisions.

  Prompt caching   — static context (rules) cached 5 min; only hand state is
                     reprocessed each action.
  Response prefill — assistant turn starts with '{"action":' so the model
                     skips preamble and continues straight to the JSON value.

Typical latency: 1-2 s with Haiku; well inside the 8 s reasoning window.

Setup:
  cp .env.example .env   # set ANTHROPIC_API_KEY, POKER_SERVER, AGENT_ID
  pip install -r requirements.txt
  python agent.py
"""

import asyncio
import json
import os
import anthropic
import websockets
from dotenv import load_dotenv

load_dotenv()

SERVER_URL = os.environ.get("POKER_SERVER",  "ws://localhost:3000")
AGENT_ID   = os.environ.get("AGENT_ID",     "claude-agent-1")
AGENT_NAME = os.environ.get("AGENT_NAME",   "ClaudeBot")
MODEL      = os.environ.get("CLAUDE_MODEL", "claude-haiku-4-5-20251001")

client = anthropic.Anthropic()

RANK_LABELS = {14: "A", 13: "K", 12: "Q", 11: "J", 10: "T"}
SUIT_LABELS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}


def fmt_card(c: dict) -> str:
    return f"{RANK_LABELS.get(c['rank'], c['rank'])}{SUIT_LABELS.get(c['suit'], c['suit'])}"


def fmt_cards(cards: list) -> str:
    return " ".join(fmt_card(c) for c in cards) if cards else "none"


# ── Cached static context ────────────────────────────────────────────────────
STATIC_CONTEXT = """You are playing Texas Hold'em in a poker tournament. Make the best play.
Respond ONLY with a JSON object — no preamble, no explanation outside JSON.
Format: {"action":"FOLD|CHECK|CALL|RAISE","amount":<int if RAISE>,"reasoning":"<one sentence>"}"""


def build_bounty_section(state: dict) -> str:
    b = state.get("activeBounty")
    if not b:
        return ""
    r, exp, tid = b["reward"], b["expiresAfterHand"], b["targetId"]
    if tid == AGENT_ID:
        return (f"\n⚠️ BOUNTY ON YOU: Opponents earn {r:,} bonus chips if they eliminate you "
                f"before hand {exp}. Play conservatively.\n")
    at_table = any(p["id"] == tid for p in state.get("players", []))
    if at_table:
        return (f"\n💰 BOUNTY TARGET HERE: {b['targetName']} worth {r:,} chips "
                f"if eliminated before hand {exp}. Widen your range against them.\n")
    return f"\n💰 ACTIVE BOUNTY: {b['targetName']} at another table ({r:,} chips, exp. h.{exp}).\n"


def build_prompt(state: dict) -> str:
    valid    = state["validActions"]
    raise_rng = f"\n  Raise range: {state['minRaise']} – {state['maxRaise']}" if "RAISE" in valid else ""
    opponents = "\n".join(
        f"  - {p['id']}: stack={p['stack']:,}, bet={p['bet']}, "
        f"{'folded' if p['folded'] else 'all-in' if p['allIn'] else 'active'}"
        for p in state.get("players", [])
    )
    return f"""{build_bounty_section(state)}
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


PREFILL = '{"action":'


def _extract_json(continuation: str) -> dict:
    raw = PREFILL + continuation
    depth = 0
    for i, ch in enumerate(raw):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(raw[: i + 1])
    return json.loads(raw)


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
                        {"type": "text", "text": STATIC_CONTEXT,
                         "cache_control": {"type": "ephemeral"}},
                        {"type": "text", "text": build_prompt(state)},
                    ],
                },
                {"role": "assistant", "content": PREFILL},
            ],
        )
        decision  = _extract_json(resp.content[0].text)
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


async def run() -> None:
    print(f"Connecting to {SERVER_URL} as {AGENT_NAME} ({AGENT_ID}) via Anthropic SDK [{MODEL}]")

    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({"type": "register", "agentId": AGENT_ID, "agentName": AGENT_NAME}))

        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "register_ack":
                print(f"Registered as {msg['agentName']}. "
                      f"Reasoning window: {msg['timeLimitMs']}ms  "
                      f"Setup window: {msg.get('setupMs','?')}ms")
                print("Waiting for hands…")

            elif msg["type"] == "action_required":
                await ws.send(json.dumps({"type": "action_ack", "gameId": msg["gameId"]}))
                action = await decide(msg)
                await ws.send(json.dumps({"type": "action", "gameId": msg["gameId"],
                                          "action": action["action"],
                                          "amount": action.get("amount")}))

            elif msg["type"] == "hand_result":
                delta = msg.get("deltas", {}).get(AGENT_ID)
                if delta is not None:
                    print(f"{'Won ' if delta > 0 else 'Lost'} hand #{msg['handNumber']}  "
                          f"{'+' if delta > 0 else ''}{delta}")
                if msg.get("showdown") and msg.get("communityCards"):
                    board = fmt_cards(msg["communityCards"])
                    hands = ", ".join(
                        f"{s['playerId']} {fmt_cards(s['holeCards'])}"
                        + (f" ({s['handRank']})" if s.get("handRank") else "")
                        for s in msg["showdown"]
                    )
                    print(f"  Showdown — Board: {board}  ·  {hands}")

            elif msg["type"] == "bounty_announced":
                if msg["targetId"] == AGENT_ID:
                    print(f"\n⚠️ BOUNTY ON ME! +{msg['reward']} chips, exp. h.{msg['expiresAfterHand']}\n")
                else:
                    print(f"💰 Bounty: {msg['targetName']} +{msg['reward']}, exp. h.{msg['expiresAfterHand']}")

            elif msg["type"] == "bounty_claimed":
                if msg["claimedById"] == AGENT_ID:
                    print(f"🎯 Claimed bounty on {msg['targetName']}! +{msg['reward']}")

            elif msg["type"] == "bounty_expired":
                print(f"⌛ Bounty on {msg['targetName']} expired")

            elif msg["type"] == "bounty_curse_required":
                target = max(msg["availableTargets"], key=lambda t: t["stack"])
                await ws.send(json.dumps({"type": "bounty_curse", "targetId": target["id"]}))
                print(f"💀 Cursing {target['name']} (-{msg['curseAmount']} chips)")

            elif msg["type"] == "bounty_cursed":
                if msg["targetId"] == AGENT_ID:
                    print(f"😤 Cursed by {msg['curserName']} — -{msg['amount']} chips!")

            elif msg["type"] == "tournament_update":
                me = next((p for p in msg["standings"] if p["playerId"] == AGENT_ID), None)
                if me:
                    print(f"Stack: {me['stack']:,}  |  Blinds {msg['smallBlind']}/{msg['bigBlind']}")

            elif msg["type"] == "tournament_end":
                if msg["result"] == "won":
                    print(f"\n🏆 Tournament WINNER!  Final stack: {msg['finalStack']:,}\n")
                else:
                    print(f"\nTournament ended.  Place: #{msg['place']}  Final stack: {msg['finalStack']:,}\n")
                break

            elif msg["type"] == "error":
                print(f"Server error: {msg['message']}")


if __name__ == "__main__":
    asyncio.run(run())
