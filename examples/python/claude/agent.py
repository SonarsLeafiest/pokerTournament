"""
Claude Code Poker Agent

Uses the `claude` CLI (Claude Code) instead of the Anthropic SDK — no API key
config needed beyond what Claude Code already has set up.

Setup:
  cp .env.example .env   # set POKER_SERVER and a unique AGENT_ID
  pip install -r requirements.txt
  python agent.py

Requires: Claude Code CLI installed and authenticated (`claude --version` should work)
"""

import asyncio
import json
import os
import shutil
import subprocess
import websockets
from dotenv import load_dotenv

load_dotenv()

SERVER_URL = os.environ.get("POKER_SERVER", "ws://localhost:3000")
AGENT_ID   = os.environ.get("AGENT_ID",    "cc-agent-1")
AGENT_NAME = os.environ.get("AGENT_NAME",  "ClaudeCodeBot")
MODEL      = os.environ.get("CLAUDE_MODEL", "sonnet")  # sonnet | opus | haiku

# JSON schema that Claude Code will validate its response against
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


def fmt_cards(cards: list[dict]) -> str:
    return " ".join(fmt_card(c) for c in cards) if cards else "none"


def build_prompt(state: dict) -> str:
    valid = state["validActions"]
    raise_info = ""
    if "RAISE" in valid:
        raise_info = f"\n  Raise range: {state['minRaise']} – {state['maxRaise']}"

    opponents = "\n".join(
        f"  - {p['id']}: stack={p['stack']:,}, bet={p['bet']}, "
        f"{'folded' if p['folded'] else 'all-in' if p['allIn'] else 'active'}"
        for p in state.get("players", [])
    )

    return f"""You are playing Texas Hold'em in a poker tournament. Make the best play.

YOUR HAND:    {fmt_cards(state['holeCards'])}
COMMUNITY:    {fmt_cards(state['communityCards'])}
STAGE:        {state.get('stage', '?')}
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
            ["claude", "-p", prompt,
             "--model", MODEL,
             "--output-format", "json",
             "--json-schema", ACTION_SCHEMA],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip())

        data = json.loads(result.stdout)

        # --json-schema puts validated output in structured_output;
        # fall back to parsing result text if structured_output is absent
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
            print(f"  [{AGENT_NAME}] {action}"
                  + (f" {decision.get('amount')}" if action == "RAISE" else "")
                  + f" — {reasoning}")

        if action not in state["validActions"]:
            print(f"  [{AGENT_NAME}] invalid action {action!r}, folding")
            return {"action": "FOLD"}

        out = {"action": action}
        if action == "RAISE" and "amount" in decision:
            amt = int(decision["amount"])
            amt = max(state["minRaise"], min(state["maxRaise"], amt))
            out["amount"] = amt
        return out

    except subprocess.TimeoutExpired:
        print(f"  [{AGENT_NAME}] claude CLI timed out — folding")
        return {"action": "FOLD"}
    except Exception as e:
        print(f"  [{AGENT_NAME}] error: {e} — folding")
        return {"action": "FOLD"}


async def run() -> None:
    print(f"Connecting to {SERVER_URL} as {AGENT_NAME} ({AGENT_ID}) via claude CLI [{MODEL}]")
    if not shutil.which("claude"):
        print("  ⚠  WARNING: claude CLI not found. Install Claude Code first.")

    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "type":      "register",
            "agentId":   AGENT_ID,
            "agentName": AGENT_NAME,
        }))
        print("Registered. Waiting for hands…")

        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "action_required":
                action = decide(msg)
                await ws.send(json.dumps({
                    "type":   "action",
                    "gameId": msg["gameId"],
                    "action": action["action"],
                    "amount": action.get("amount"),
                }))

            elif msg["type"] == "hand_result":
                delta = msg.get("deltas", {}).get(AGENT_ID)
                if delta is not None:
                    if delta > 0:
                        print(f"Won  hand #{msg['handNumber']}  +{delta}")
                    else:
                        print(f"Lost hand #{msg['handNumber']}  {delta}")

            elif msg["type"] == "tournament_update":
                me = next((p for p in msg["standings"] if p["playerId"] == AGENT_ID), None)
                if me:
                    print(f"Stack: {me['stack']:,}  |  Blinds {msg['smallBlind']}/{msg['bigBlind']}")

            elif msg["type"] == "tournament_end":
                if msg["result"] == "won":
                    print(f"\n🏆  Tournament WINNER!  Place: #{msg['place']}  Final stack: {msg['finalStack']}\n")
                else:
                    print(f"\nTournament ended.  Place: #{msg['place']}  Final stack: {msg['finalStack']}\n")

            elif msg["type"] == "error":
                print(f"Server error: {msg['message']}")


if __name__ == "__main__":
    asyncio.run(run())
