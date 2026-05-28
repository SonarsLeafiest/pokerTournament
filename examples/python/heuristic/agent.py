#!/usr/bin/env python3
"""
Heuristic Poker Agent

A fast, self-contained agent that makes decisions using hand-strength math and
pot-odds calculations — no external API or LLM required.  Useful for load
testing, developing server features, and as a baseline benchmark for AI agents.

Playing style is controlled by the AGENT_STYLE environment variable:

  tight_aggressive  Only opens premium hands, raises big (default)
  loose_passive     Calls almost everything, rarely raises
  loose_aggressive  Wide range, bets and raises constantly
  tight_passive     Strong hands only, prefers calling to raising
  balanced          Solid balanced play with pot-odds awareness

Setup:
  pip install websockets python-dotenv
  AGENT_ID=h1 AGENT_NAME=HeuristicBot AGENT_STYLE=balanced python3 agent.py
"""

import asyncio
import itertools
import json
import os
import random
from collections import Counter
from dotenv import load_dotenv

load_dotenv()

SERVER_URL  = os.environ.get("POKER_SERVER",  "ws://localhost:3000")
AGENT_ID    = os.environ.get("AGENT_ID",      "heuristic-1")
AGENT_NAME  = os.environ.get("AGENT_NAME",    "HeuristicBot")
STYLE_NAME  = os.environ.get("AGENT_STYLE",   "tight_aggressive")

# ── Style configs ─────────────────────────────────────────────────────────────
#   fold_thr:    fold if hand strength < this (when facing a bet)
#   raise_thr:   raise/bet if hand strength > this
#   raise_size:  raise amount as a multiple of the pot

STYLES: dict[str, dict] = {
    "tight_aggressive": {"fold": 0.36, "raise": 0.60, "raise_size": 2.5},
    "loose_passive":    {"fold": 0.12, "raise": 0.88, "raise_size": 1.0},
    "loose_aggressive": {"fold": 0.18, "raise": 0.44, "raise_size": 3.2},
    "tight_passive":    {"fold": 0.42, "raise": 0.92, "raise_size": 1.4},
    "balanced":         {"fold": 0.27, "raise": 0.64, "raise_size": 2.0},
}

# ── Hand evaluation ───────────────────────────────────────────────────────────

def _eval5(cards: list[dict]) -> float:
    """Score a 5-card hand 0.0–9.0 (higher = stronger)."""
    ranks = sorted([c["rank"] for c in cards], reverse=True)
    suits = [c["suit"] for c in cards]

    flush  = len(set(suits)) == 1
    rank_s = set(ranks)
    straight = (max(ranks) - min(ranks) == 4 and len(rank_s) == 5)
    if not straight and rank_s == {14, 2, 3, 4, 5}:
        straight, ranks = True, [5, 4, 3, 2, 1]

    freq = sorted(Counter(ranks).values(), reverse=True)
    hi   = ranks[0] / 14.0 * 0.09  # tiebreaker within category

    if straight and flush:  return 8.0 + hi
    if freq[0] == 4:        return 7.0 + hi
    if freq[:2] == [3, 2]:  return 6.0 + hi
    if flush:               return 5.0 + hi
    if straight:            return 4.0 + hi
    if freq[0] == 3:        return 3.0 + hi
    if freq[:2] == [2, 2]:  return 2.0 + hi
    if freq[0] == 2:        return 1.0 + hi
    return hi

def _preflop(hole: list[dict]) -> float:
    """Pre-flop hand strength 0.0–1.0."""
    if len(hole) < 2:
        return 0.3
    r = sorted([c["rank"] for c in hole], reverse=True)
    s = [c["suit"] for c in hole]
    hi, lo = r[0], r[1]
    if hi == lo:                         # pair
        return 0.50 + (hi / 14.0) * 0.50
    score = (hi / 14.0) * 0.38 + (lo / 14.0) * 0.18
    if s[0] == s[1]:  score += 0.10     # suited
    gap = hi - lo
    if gap == 1:      score += 0.10     # connector
    elif gap == 2:    score += 0.05
    return min(1.0, score)

def hand_strength(hole: list[dict], community: list[dict]) -> float:
    """0.0–1.0 best-hand strength from all available cards."""
    all_cards = hole + community
    if len(all_cards) < 5:
        return _preflop(hole)
    best = max(_eval5(list(c)) for c in itertools.combinations(all_cards, 5))
    return best / 9.0

# ── Decision logic ────────────────────────────────────────────────────────────

def decide(state: dict, style: dict) -> dict:
    valid    = state["validActions"]
    strength = hand_strength(state.get("holeCards", []), state.get("communityCards", []))

    to_call = state["currentBet"] - state["myBet"]
    pot     = state["pot"] + to_call if to_call > 0 else state["pot"]
    pot_odds = to_call / pot if pot > 0 and to_call > 0 else 0

    # Bounty adjustments
    fold_thr  = style["fold"]
    raise_thr = style["raise"]
    bounty    = state.get("activeBounty")
    if bounty:
        if bounty["targetId"] == AGENT_ID:
            fold_thr  = min(0.58, fold_thr + 0.16)   # tighten when hunted
            raise_thr = min(0.96, raise_thr + 0.16)
        elif any(p["id"] == bounty["targetId"] for p in state.get("players", [])):
            fold_thr  = max(0.06, fold_thr - 0.09)   # loosen vs bounty target
            raise_thr = max(0.32, raise_thr - 0.09)

    # Small random noise so identical hands don't play identically every time
    noise = random.gauss(0, 0.03)
    strength = max(0.0, min(1.0, strength + noise))

    if strength >= raise_thr and "RAISE" in valid:
        raw    = int(state["pot"] * style["raise_size"])
        amount = max(state["minRaise"], min(state["maxRaise"], raw))
        return {"action": "RAISE", "amount": amount}

    if "CALL" in valid and strength > max(pot_odds, fold_thr):
        return {"action": "CALL"}

    if "CHECK" in valid:
        return {"action": "CHECK"}

    return {"action": "FOLD"}

# ── WebSocket loop ────────────────────────────────────────────────────────────

async def run() -> None:
    import websockets

    style = STYLES.get(STYLE_NAME, STYLES["balanced"])
    print(f"Connecting {AGENT_NAME} ({AGENT_ID}) — style: {STYLE_NAME}")

    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({"type": "register", "agentId": AGENT_ID, "agentName": AGENT_NAME}))
        print(f"  [{AGENT_NAME}] registered")

        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "action_required":
                action = decide(msg, style)
                await ws.send(json.dumps({"type": "action", "gameId": msg["gameId"], **action}))

            elif msg["type"] == "hand_result":
                delta = msg.get("deltas", {}).get(AGENT_ID)
                if delta is not None and delta != 0:
                    print(f"  [{AGENT_NAME}] hand #{msg['handNumber']}  "
                          f"{'+' if delta > 0 else ''}{delta}")
                if msg.get("showdown"):
                    RANK = {14:"A",13:"K",12:"Q",11:"J",10:"T"}
                    SUIT = {"s":"♠","h":"♥","d":"♦","c":"♣"}
                    fmt  = lambda c: f"{RANK.get(c['rank'], c['rank'])}{SUIT.get(c['suit'], c['suit'])}"
                    print(f"  [{AGENT_NAME}] showdown: " +
                          ", ".join(f"{s['playerId']} {' '.join(fmt(c) for c in s['holeCards'])}"
                                    for s in msg["showdown"]))

            elif msg["type"] == "bounty_announced":
                if msg["targetId"] == AGENT_ID:
                    print(f"  [{AGENT_NAME}] ⚠️  BOUNTY ON ME — {msg['reward']} chips, exp. h.{msg['expiresAfterHand']}")
                else:
                    print(f"  [{AGENT_NAME}] 💰 Bounty: {msg['targetName']} +{msg['reward']}")

            elif msg["type"] == "bounty_claimed":
                if msg["claimedById"] == AGENT_ID:
                    print(f"  [{AGENT_NAME}] 🎯 Claimed bounty on {msg['targetName']}! +{msg['reward']}")

            elif msg["type"] == "bounty_curse_required":
                target = max(msg["availableTargets"], key=lambda t: t["stack"])
                await ws.send(json.dumps({"type": "bounty_curse", "targetId": target["id"]}))
                print(f"  [{AGENT_NAME}] 💀 Cursing {target['name']} (-{msg['curseAmount']} chips)")

            elif msg["type"] == "bounty_cursed":
                if msg["targetId"] == AGENT_ID:
                    print(f"  [{AGENT_NAME}] 😤 Cursed by {msg['curserName']} — -{msg['amount']} chips!")

            elif msg["type"] == "tournament_end":
                result = "🏆 WINNER" if msg["result"] == "won" else f"place #{msg['place']}"
                print(f"\n  [{AGENT_NAME}] {result}  final stack: {msg['finalStack']:,}\n")
                break

            elif msg["type"] == "error":
                print(f"  [{AGENT_NAME}] error: {msg['message']}")

if __name__ == "__main__":
    asyncio.run(run())
