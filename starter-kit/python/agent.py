"""
Poker Tournament — Python Starter Agent

Connects to the game server via WebSocket and plays random legal actions.
Replace the `decide()` function with your own logic.

Setup: cp .env.example .env  then edit .env
Run:   python agent.py
"""

import asyncio
import json
import os
import random
import websockets
from dotenv import load_dotenv

load_dotenv()

SERVER_URL = os.environ.get("POKER_SERVER", "ws://localhost:3000")
AGENT_ID   = os.environ.get("AGENT_ID", "python-agent-1")
AGENT_NAME = os.environ.get("AGENT_NAME", "PythonBot")


def decide(state: dict) -> dict:
    """
    Return an action given the current game state.

    state keys:
      holeCards       – list of 2 cards [{"rank": int, "suit": str}]
      communityCards  – list of 0–5 cards
      pot             – int
      myStack         – int
      currentBet      – int
      myBet           – int
      validActions    – list of "FOLD" | "CHECK" | "CALL" | "RAISE"
      minRaise        – int
      maxRaise        – int

    Return one of:
      {"action": "FOLD"}
      {"action": "CHECK"}
      {"action": "CALL"}
      {"action": "RAISE", "amount": <int>}
    """
    valid = state["validActions"]

    # Example: never fold if check is available; otherwise call; raise 20% of the time
    if "CHECK" in valid:
        return {"action": "CHECK"}

    if "RAISE" in valid and random.random() < 0.2:
        amount = random.randint(state["minRaise"], min(state["minRaise"] * 3, state["maxRaise"]))
        return {"action": "RAISE", "amount": amount}

    if "CALL" in valid:
        return {"action": "CALL"}

    return {"action": "FOLD"}


async def run():
    print(f"Connecting to {SERVER_URL} as {AGENT_NAME} ({AGENT_ID})")
    async with websockets.connect(SERVER_URL) as ws:
        # Register with the server
        await ws.send(json.dumps({
            "type": "register",
            "agentId": AGENT_ID,
            "agentName": AGENT_NAME,
        }))
        print("Registered. Waiting for hands...")

        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "action_required":
                action = decide(msg)
                await ws.send(json.dumps({
                    "type": "action",
                    "gameId": msg["gameId"],
                    "action": action["action"],
                    "amount": action.get("amount"),
                }))

            elif msg["type"] == "hand_result":
                for w in msg.get("winners", []):
                    if w["playerId"] == AGENT_ID:
                        print(f"Won hand #{msg['handNumber']}! +{w['amount']}")

            elif msg["type"] == "tournament_update":
                me = next((p for p in msg["standings"] if p["playerId"] == AGENT_ID), None)
                if me:
                    print(f"Stack: {me['stack']:,}  |  Blind level {msg['blindLevel']}: {msg['smallBlind']}/{msg['bigBlind']}")

            elif msg["type"] == "error":
                print(f"Server error: {msg['message']}")


if __name__ == "__main__":
    asyncio.run(run())
