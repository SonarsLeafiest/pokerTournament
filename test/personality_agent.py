#!/usr/bin/env python3
"""
Personality-aware Claude Code poker agent.

Drop-in replacement for examples/python/claude/agent.py that reads
AGENT_PERSONALITY from the environment and injects it into every prompt,
giving each instance a distinct strategic identity.

Usage:
  AGENT_ID=ace-hunter AGENT_NAME=AceHunter \
  AGENT_PERSONALITY="Play tight-aggressive. Only open premium hands." \
  POKER_SERVER=ws://localhost:3001 python3 test/personality_agent.py
"""

import asyncio
import json
import os
import shutil
import subprocess
import websockets
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', 'server', '.env'))

SERVER_URL   = os.environ.get("POKER_SERVER",       "ws://localhost:3001")
AGENT_ID     = os.environ.get("AGENT_ID",           "agent-1")
AGENT_NAME   = os.environ.get("AGENT_NAME",         "Agent1")
MODEL        = os.environ.get("CLAUDE_MODEL",       "sonnet")
PERSONALITY  = os.environ.get("AGENT_PERSONALITY",  "")

ACTION_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "action":    {"type": "string", "enum": ["FOLD", "CHECK", "CALL", "RAISE"]},
        "amount":    {"type": "integer", "description": "Chips to raise (only when action=RAISE)"},
        "reasoning": {"type": "string",  "description": "One sentence explaining the decision"},
    },
    "required": ["action", "reasoning"],
})

RANK_LABELS = {14: "A", 13: "K", 12: "Q", 11: "J", 10: "T"}
SUIT_LABELS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}

def fmt_card(card: dict) -> str:
    r = RANK_LABELS.get(card["rank"], str(card["rank"]))
    s = SUIT_LABELS.get(card["suit"], card["suit"])
    return f"{r}{s}"

def fmt_cards(cards: list) -> str:
    return " ".join(fmt_card(c) for c in cards) if cards else "none"

def build_bounty_section(state: dict) -> str:
    b = state.get("activeBounty")
    if not b:
        return ""
    reward, expires = b["reward"], b["expiresAfterHand"]
    tid, tname = b["targetId"], b["targetName"]
    if tid == AGENT_ID:
        return (f"\n⚠️  BOUNTY ON YOU: Opponents earn {reward:,} bonus chips if they "
                f"eliminate you before hand {expires}. Play conservatively.\n")
    at_table = any(p["id"] == tid for p in state.get("players", []))
    if at_table:
        return (f"\n💰 BOUNTY TARGET HERE: {tname} is worth {reward:,} bonus chips "
                f"if eliminated before hand {expires}. Widen your range against them.\n")
    return f"\n💰 ACTIVE BOUNTY: {tname} at another table ({reward:,} chips, exp. h.{expires}).\n"

def build_prompt(state: dict) -> str:
    valid = state["validActions"]
    raise_info = (f"\n  Raise range: {state['minRaise']} – {state['maxRaise']}"
                  if "RAISE" in valid else "")
    opponents = "\n".join(
        f"  - {p['id']}: stack={p['stack']:,}, bet={p['bet']}, "
        f"{'folded' if p['folded'] else 'all-in' if p['allIn'] else 'active'}"
        for p in state.get("players", [])
    )
    bounty = build_bounty_section(state)
    hand_num = state.get("handNumber", "?")

    personality_block = ""
    if PERSONALITY:
        personality_block = f"\nYour playing style: {PERSONALITY}\n"

    return f"""You are playing Texas Hold'em in a poker tournament. Make the best play.
{personality_block}{bounty}
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

def decide(state: dict) -> dict:
    if not shutil.which("claude"):
        print(f"  [{AGENT_NAME}] ⚠ claude CLI not found — folding")
        return {"action": "FOLD"}
    prompt = build_prompt(state)
    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--model", MODEL,
             "--output-format", "json", "--json-schema", ACTION_SCHEMA],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip())
        data = json.loads(result.stdout)
        if data.get("structured_output"):
            decision = data["structured_output"]
        else:
            text = data.get("result", "").strip()
            if text.startswith("```"):
                text = text.split("```")[1].lstrip("json").strip()
            decision = json.loads(text)
        action    = decision.get("action", "FOLD").upper()
        reasoning = decision.get("reasoning", "")
        if reasoning:
            amt = f" {decision.get('amount')}" if action == "RAISE" else ""
            print(f"  [{AGENT_NAME}] {action}{amt} — {reasoning}")
        if action not in state["validActions"]:
            return {"action": "FOLD"}
        out = {"action": action}
        if action == "RAISE" and "amount" in decision:
            amt = int(decision["amount"])
            amt = max(state["minRaise"], min(state["maxRaise"], amt))
            out["amount"] = amt
        return out
    except subprocess.TimeoutExpired:
        print(f"  [{AGENT_NAME}] timeout — folding")
        return {"action": "FOLD"}
    except Exception as e:
        print(f"  [{AGENT_NAME}] error: {e} — folding")
        return {"action": "FOLD"}

async def run() -> None:
    style_note = f" [{PERSONALITY[:40]}…]" if PERSONALITY else ""
    print(f"Connecting {AGENT_NAME} ({AGENT_ID}){style_note}")
    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({"type": "register", "agentId": AGENT_ID, "agentName": AGENT_NAME}))
        print(f"  [{AGENT_NAME}] registered")
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "action_required":
                action = decide(msg)
                await ws.send(json.dumps({"type": "action", "gameId": msg["gameId"], **action}))
            elif msg["type"] == "hand_result":
                delta = msg.get("deltas", {}).get(AGENT_ID)
                if delta is not None and delta != 0:
                    print(f"  [{AGENT_NAME}] hand #{msg['handNumber']}  "
                          f"{'+' if delta > 0 else ''}{delta}")
                if msg.get("showdown"):
                    cards_str = ", ".join(
                        f"{s['playerId']} {fmt_cards(s['holeCards'])}"
                        for s in msg["showdown"]
                    )
                    print(f"  [{AGENT_NAME}] showdown → {cards_str}")
            elif msg["type"] == "tournament_end":
                result = "🏆 WINNER" if msg["result"] == "won" else f"place #{msg['place']}"
                print(f"\n  [{AGENT_NAME}] {result}  stack: {msg['finalStack']:,}\n")
                break
            elif msg["type"] == "error":
                print(f"  [{AGENT_NAME}] server: {msg['message']}")

if __name__ == "__main__":
    asyncio.run(run())
