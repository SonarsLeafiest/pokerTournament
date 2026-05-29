"""
Shared Claude Code poker agent core.

Import this from a personality script — it handles the WebSocket loop,
Claude CLI calls, and all protocol message types.  The personality script
sets AGENT_ID, AGENT_NAME, and AGENT_PERSONALITY before importing.
"""

import asyncio
import json
import os
import shutil
import subprocess
import websockets
from dotenv import load_dotenv

load_dotenv()

SERVER_URL   = os.environ.get("POKER_SERVER",       "ws://localhost:3000")
AGENT_ID     = os.environ.get("AGENT_ID",           "agent-1")
AGENT_NAME   = os.environ.get("AGENT_NAME",         "Agent")
MODEL        = os.environ.get("CLAUDE_MODEL",       "sonnet")
PERSONALITY  = os.environ.get("AGENT_PERSONALITY",  "")

ACTION_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "action":    {"type": "string", "enum": ["FOLD", "CHECK", "CALL", "RAISE"]},
        "amount":    {"type": "integer"},
        "reasoning": {"type": "string"},
    },
    "required": ["action", "reasoning"],
})

RANK_LABELS = {14: "A", 13: "K", 12: "Q", 11: "J", 10: "T"}
SUIT_LABELS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}


def fmt_card(c: dict) -> str:
    return f"{RANK_LABELS.get(c['rank'], c['rank'])}{SUIT_LABELS.get(c['suit'], c['suit'])}"


def fmt_cards(cards: list) -> str:
    return " ".join(fmt_card(c) for c in cards) if cards else "none"


def build_bounty_section(state: dict) -> str:
    b = state.get("activeBounty")
    if not b:
        return ""
    r, exp = b["reward"], b["expiresAfterHand"]
    tid, tname = b["targetId"], b["targetName"]
    if tid == AGENT_ID:
        return (f"\n⚠️  BOUNTY ON YOU: Opponents earn {r:,} chips if they eliminate you before "
                f"hand {exp}. Play defensively — avoid marginal all-ins.\n")
    at_table = any(p["id"] == tid for p in state.get("players", []))
    if at_table:
        return (f"\n💰 BOUNTY TARGET HERE: {tname} is worth {r:,} chips if eliminated before "
                f"hand {exp}. Widen your range against them.\n")
    return f"\n💰 ACTIVE BOUNTY: {tname} at another table ({r:,} chips, exp. h.{exp}).\n"


def build_prompt(state: dict) -> str:
    valid = state["validActions"]
    raise_info = (f"\n  Raise range: {state['minRaise']} – {state['maxRaise']}"
                  if "RAISE" in valid else "")
    opponents = "\n".join(
        f"  - {p['id']}: stack={p['stack']:,}, bet={p['bet']}, "
        f"{'folded' if p['folded'] else 'all-in' if p['allIn'] else 'active'}"
        for p in state.get("players", [])
    )
    bounty   = build_bounty_section(state)
    hand_num = state.get("handNumber", "?")
    style    = f"\nYour playing style: {PERSONALITY}\n" if PERSONALITY else ""

    return f"""You are playing Texas Hold'em in a poker tournament. Make the best play.
{style}{bounty}
YOUR HAND:    {fmt_cards(state['holeCards'])}
COMMUNITY:    {fmt_cards(state['communityCards'])}
STAGE:        {state.get('stage', '?')}   (hand #{hand_num})
POSITION:     {state.get('position', '?')}
POT:          {state['pot']:,}
MY STACK:     {state['myStack']:,}
MY BET:       {state['myBet']:,}
CURRENT BET:  {state['currentBet']:,}
OPPONENTS:
{opponents if opponents else '  (none visible)'}

VALID ACTIONS: {', '.join(valid)}{raise_info}

Choose the best action. If raising, pick a strategically sound bet size."""


async def decide(state: dict) -> dict:
    if not shutil.which("claude"):
        print(f"  [{AGENT_NAME}] ⚠ claude CLI not found — folding")
        return {"action": "FOLD"}
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["claude", "-p", build_prompt(state), "--model", MODEL,
             "--output-format", "json", "--json-schema", ACTION_SCHEMA],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip())
        data = json.loads(result.stdout)
        decision = (data.get("structured_output") or
                    json.loads(data.get("result", "").strip().lstrip("```json").rstrip("`")))
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
    except subprocess.TimeoutExpired:
        print(f"  [{AGENT_NAME}] timeout — folding")
        return {"action": "FOLD"}
    except Exception as e:
        print(f"  [{AGENT_NAME}] error: {e} — folding")
        return {"action": "FOLD"}


async def run() -> None:
    if not shutil.which("claude"):
        print("  ⚠  WARNING: claude CLI not found. Install Claude Code first.")

    print(f"Connecting to {SERVER_URL} as {AGENT_NAME} ({AGENT_ID})")
    if PERSONALITY:
        print(f"  Style: {PERSONALITY[:80]}{'…' if len(PERSONALITY) > 80 else ''}")

    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({"type": "register", "agentId": AGENT_ID, "agentName": AGENT_NAME}))

        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "register_ack":
                print(f"  [{AGENT_NAME}] registered. Action timeout: {msg['timeLimitMs']}ms")

            elif msg["type"] == "action_required":
                action = await decide(msg)
                await ws.send(json.dumps({"type": "action", "gameId": msg["gameId"], **action}))

            elif msg["type"] == "hand_result":
                delta = msg.get("deltas", {}).get(AGENT_ID)
                if delta is not None and delta != 0:
                    print(f"  [{AGENT_NAME}] hand #{msg['handNumber']}  {'+' if delta > 0 else ''}{delta}")
                if msg.get("showdown"):
                    cards = ", ".join(
                        f"{s['playerId']} {fmt_cards(s['holeCards'])}" for s in msg["showdown"]
                    )
                    print(f"  [{AGENT_NAME}] showdown: {cards}")

            elif msg["type"] == "bounty_announced":
                if msg["targetId"] == AGENT_ID:
                    print(f"\n  [{AGENT_NAME}] ⚠️  BOUNTY ON ME! +{msg['reward']} to whoever eliminates me before h.{msg['expiresAfterHand']}\n")
                else:
                    print(f"  [{AGENT_NAME}] 💰 Bounty: {msg['targetName']} +{msg['reward']}, exp. h.{msg['expiresAfterHand']}")

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
                    print(f"  [{AGENT_NAME}] Stack: {me['stack']:,}  |  Blinds {msg['smallBlind']}/{msg['bigBlind']}")

            elif msg["type"] == "tournament_end":
                if msg["result"] == "won":
                    print(f"\n  [{AGENT_NAME}] 🏆 TOURNAMENT WINNER!  Final stack: {msg['finalStack']:,}\n")
                else:
                    print(f"\n  [{AGENT_NAME}] Finished #{msg['place']}  Final stack: {msg['finalStack']:,}\n")
                break

            elif msg["type"] == "error":
                print(f"  [{AGENT_NAME}] server error: {msg['message']}")


if __name__ == "__main__":
    asyncio.run(run())
