"""
GitHub Models Poker Agent

Uses the GitHub Models inference API (OpenAI-compatible) with your GITHUB_TOKEN.
No paid subscription needed — a free GitHub personal access token is enough.

Available models: gpt-4o, gpt-4o-mini, meta-llama-3.1-70b-instruct, mistral-large, and more.
Full list: https://github.com/marketplace/models

Setup:
  cp .env.example .env          # fill in GITHUB_TOKEN and a unique AGENT_ID
  pip install -r requirements.txt
  python agent.py
"""

import asyncio
import json
import os
import websockets
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

SERVER_URL   = os.environ.get("POKER_SERVER",  "ws://localhost:3000")
AGENT_ID     = os.environ.get("AGENT_ID",      "gh-agent-1")
AGENT_NAME   = os.environ.get("AGENT_NAME",    "GitHubBot")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN",  "")
MODEL        = os.environ.get("GITHUB_MODEL",  "gpt-4o-mini")

client = OpenAI(
    base_url="https://models.inference.ai.azure.com",
    api_key=GITHUB_TOKEN,
)

RANK_LABELS = {14: "A", 13: "K", 12: "Q", 11: "J", 10: "T"}
SUIT_LABELS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}


def fmt_card(card: dict) -> str:
    r = RANK_LABELS.get(card["rank"], str(card["rank"]))
    s = SUIT_LABELS.get(card["suit"], card["suit"])
    return f"{r}{s}"


def fmt_cards(cards: list[dict]) -> str:
    return " ".join(fmt_card(c) for c in cards) if cards else "none"


def build_bounty_section(state: dict) -> str:
    b = state.get("activeBounty")
    if not b:
        return ""

    reward      = b["reward"]
    expires     = b["expiresAfterHand"]
    target_id   = b["targetId"]
    target_name = b["targetName"]

    if target_id == AGENT_ID:
        return (
            f"\n⚠️  BOUNTY ON YOU: You are the current bounty target! "
            f"Opponents earn {reward:,} bonus chips if they eliminate you before hand {expires}. "
            f"Play conservatively — avoid large all-in confrontations unless you have a very strong hand.\n"
        )

    at_table = any(p["id"] == target_id for p in state.get("players", []))
    if at_table:
        return (
            f"\n💰 BOUNTY TARGET HERE: {target_name} is the bounty target at this table. "
            f"You earn {reward:,} bonus chips if you eliminate them before hand {expires}. "
            f"Widen your calling/raising range against {target_name} to pressure them out of chips.\n"
        )

    return (
        f"\n💰 ACTIVE BOUNTY: {target_name} has a bounty at another table "
        f"({reward:,} chips, expires hand {expires}). Focus on standard play.\n"
    )


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

    bounty_section = build_bounty_section(state)
    hand_num = state.get("handNumber", "?")

    return f"""You are playing Texas Hold'em in a poker tournament. Make the best play.
{bounty_section}
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

Respond with JSON only:
{{"action": "FOLD|CHECK|CALL|RAISE", "amount": <chips if RAISE>, "reasoning": "<one sentence>"}}"""


async def decide(state: dict) -> dict:
    if not GITHUB_TOKEN:
        print(f"  [{AGENT_NAME}] ⚠ GITHUB_TOKEN not set — folding")
        return {"action": "FOLD"}

    try:
        # json_object mode is supported on gpt-4o family; other models parse from text
        kwargs: dict = {}
        if "gpt" in MODEL.lower():
            kwargs["response_format"] = {"type": "json_object"}

        response = await asyncio.to_thread(
            client.chat.completions.create,
            model=MODEL,
            messages=[
                {"role": "system", "content": "You are a poker expert. Always respond with valid JSON."},
                {"role": "user",   "content": build_prompt(state)},
            ],
            temperature=0.7,
            max_tokens=150,
            **kwargs,
        )

        text = response.choices[0].message.content.strip()
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

    except Exception as e:
        print(f"  [{AGENT_NAME}] error: {e} — folding")
        return {"action": "FOLD"}


async def run() -> None:
    print(f"Connecting to {SERVER_URL} as {AGENT_NAME} ({AGENT_ID}) via GitHub Models [{MODEL}]")
    if not GITHUB_TOKEN:
        print("  ⚠  WARNING: GITHUB_TOKEN not set.")
        print("  Get a free token at https://github.com/settings/tokens (no scopes needed for public models)")

    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "type":      "register",
            "agentId":   AGENT_ID,
            "agentName": AGENT_NAME,
        }))
        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "register_ack":
                print(f"Registered as {msg['agentName']}. "
                      f"Send action_ack immediately, then reason within {msg['timeLimitMs']}ms. Setup window: {msg.get('setupMs', '?')}ms.")
                print("Waiting for hands…")

            elif msg["type"] == "action_required":
                await ws.send(json.dumps({"type": "action_ack", "gameId": msg["gameId"]}))
                action = await decide(msg)
                await ws.send(json.dumps({
                    "type":   "action",
                    "gameId": msg["gameId"],
                    "action": action["action"],
                    "amount": action.get("amount"),
                }))

            elif msg["type"] == "hand_result":
                delta = msg.get("deltas", {}).get(AGENT_ID)
                if delta is not None:
                    print(f"{'Won ' if delta > 0 else 'Lost'} hand #{msg['handNumber']}  "
                          f"{'+' if delta > 0 else ''}{delta}")

            elif msg["type"] == "bounty_announced":
                if msg["targetId"] == AGENT_ID:
                    print(f"\n⚠️  BOUNTY ON ME! {msg['reward']} chips to whoever eliminates me before hand {msg['expiresAfterHand']}\n")
                else:
                    print(f"💰 Bounty on {msg['targetName']} — {msg['reward']} chips, expires hand {msg['expiresAfterHand']}")

            elif msg["type"] == "bounty_claimed":
                if msg["claimedById"] == AGENT_ID:
                    print(f"\n🎯 I claimed the bounty! Eliminated {msg['targetName']} for +{msg['reward']} bonus chips\n")
                else:
                    print(f"💰 Bounty claimed: {msg['claimedByName']} eliminated {msg['targetName']} (+{msg['reward']})")

            elif msg["type"] == "bounty_expired":
                print(f"⌛ Bounty on {msg['targetName']} expired unclaimed")

            elif msg["type"] == "bounty_curse_required":
                target = max(msg["availableTargets"], key=lambda t: t["stack"])
                await ws.send(json.dumps({"type": "bounty_curse", "targetId": target["id"]}))
                print(f"  [{AGENT_NAME}] 💀 Cursing {target['name']} (-{msg['curseAmount']} chips)")

            elif msg["type"] == "tournament_update":
                me = next((p for p in msg["standings"] if p["playerId"] == AGENT_ID), None)
                if me:
                    print(f"Stack: {me['stack']:,}  |  Blinds {msg['smallBlind']}/{msg['bigBlind']}")

            elif msg["type"] == "tournament_end":
                if msg["result"] == "won":
                    print(f"\n🏆  Tournament WINNER!  Place: #{msg['place']}  Final stack: {msg['finalStack']}\n")
                else:
                    print(f"\nTournament ended.  Place: #{msg['place']}  Final stack: {msg['finalStack']}\n")
                break

            elif msg["type"] == "error":
                print(f"Server error: {msg['message']}")


if __name__ == "__main__":
    asyncio.run(run())
