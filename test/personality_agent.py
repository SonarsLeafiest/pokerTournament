#!/usr/bin/env python3
"""
Personality-aware poker agent with automatic SDK / CLI selection.

Used by the test tournament runner.

  If ANTHROPIC_API_KEY is set → Anthropic SDK (fast, ~1-2 s per decision)
    • Prompt caching: personality + rules cached 5 min, only hand state
      is reprocessed each action.
    • Response prefill: model continues straight from '{"action":'.

  Otherwise → Claude CLI subprocess (uses OAuth session, ~10-15 s per decision)

Usage:
  AGENT_ID=ace-hunter AGENT_NAME=AceHunter \
  AGENT_PERSONALITY="Play tight-aggressive." \
  POKER_SERVER=ws://localhost:3001 python3 test/personality_agent.py
"""

import asyncio
import json
import os
import shutil
import subprocess
import time
import websockets
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', 'server', '.env'))

SERVER_URL  = os.environ.get("POKER_SERVER",       "ws://localhost:3001")
AGENT_ID    = os.environ.get("AGENT_ID",           "agent-1")
AGENT_NAME  = os.environ.get("AGENT_NAME",         "Agent1")
MODEL       = os.environ.get("CLAUDE_MODEL",       "claude-haiku-4-5-20251001")
PERSONALITY = os.environ.get("AGENT_PERSONALITY",  "")

# ── Auth detection ────────────────────────────────────────────────────────────
USE_SDK = bool(os.environ.get("ANTHROPIC_API_KEY"))

if USE_SDK:
    import anthropic as _anthropic
    sdk_client = _anthropic.Anthropic()
    print(f"  Using Anthropic SDK (prompt caching + prefill) [{MODEL}]")
else:
    sdk_client = None
    CLI_MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")  # CLI uses short names
    print(f"  Using Claude CLI fallback [{CLI_MODEL}] — set ANTHROPIC_API_KEY for SDK speed")

# ── Rate-limit handling ───────────────────────────────────────────────────────

class _RateLimitError(Exception):
    """Raised by either backend when a usage/rate limit is detected."""
    def __init__(self, backoff_s: float, detail: str = ""):
        self.backoff_s = backoff_s
        super().__init__(detail)


_rate_limited_until: float = 0.0


def _is_rate_limited() -> bool:
    return time.monotonic() < _rate_limited_until


def _set_rate_limit(err: _RateLimitError) -> None:
    global _rate_limited_until
    _rate_limited_until = time.monotonic() + err.backoff_s
    print(f"  [{AGENT_NAME}] ⏸ rate-limited ({err}) — heuristic for {err.backoff_s:.0f}s")


def heuristic_decide(state: dict) -> dict:
    """Pot-odds fallback used when the LLM is unavailable."""
    valid = state["validActions"]
    if "CHECK" in valid:
        return {"action": "CHECK"}
    call_amt = state["currentBet"] - state["myBet"]
    pot = state["pot"]
    if "CALL" in valid and pot > 0 and call_amt <= pot * 0.33:
        return {"action": "CALL"}
    return {"action": "FOLD"}


RANK_LABELS = {14: "A", 13: "K", 12: "Q", 11: "J", 10: "T"}
SUIT_LABELS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}


def fmt_card(c: dict) -> str:
    return f"{RANK_LABELS.get(c['rank'], c['rank'])}{SUIT_LABELS.get(c['suit'], c['suit'])}"


def fmt_cards(cards: list) -> str:
    return " ".join(fmt_card(c) for c in cards) if cards else "none"


# ── Cached static context (personality + rules) ───────────────────────────────

def _build_static() -> str:
    style = f"\nYour playing style: {PERSONALITY}\n" if PERSONALITY else ""
    return f"""You are playing Texas Hold'em in a poker tournament.{style}
Respond ONLY with a JSON object — no preamble, no text outside JSON.
Format: {{"action":"FOLD|CHECK|CALL|RAISE","amount":<int if RAISE>,"reasoning":"<one sentence>"}}"""


STATIC_CONTEXT = _build_static()
PREFILL        = '{"action":'


# ── Dynamic prompt (hand state) ───────────────────────────────────────────────

def build_bounty_section(state: dict) -> str:
    b = state.get("activeBounty")
    if not b:
        return ""
    r, exp, tid = b["reward"], b["expiresAfterHand"], b["targetId"]
    if tid == AGENT_ID:
        return (f"\n⚠️ BOUNTY ON YOU: Opponents earn {r:,} chips if they eliminate you "
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
STAGE:        {state.get('stage', '?')}   (hand #{state.get('handNumber', '?')})
POSITION:     {state.get('position', '?')}
POT:          {state['pot']:,}
MY STACK:     {state['myStack']:,}
MY BET:       {state['myBet']:,}
CURRENT BET:  {state['currentBet']:,}
OPPONENTS:
{opponents if opponents else '  (none visible)'}

VALID ACTIONS: {', '.join(valid)}{raise_rng}"""


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


async def _decide_sdk(state: dict) -> dict:
    """Fast path: Anthropic SDK with caching + prefill."""
    try:
        resp = await asyncio.to_thread(
            sdk_client.messages.create,
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
        return _extract_json(resp.content[0].text)
    except _anthropic.RateLimitError as e:
        raise _RateLimitError(60.0, f"API 429 – {e}") from e


ACTION_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "action":    {"type": "string", "enum": ["FOLD", "CHECK", "CALL", "RAISE"]},
        "amount":    {"type": "integer"},
        "reasoning": {"type": "string"},
    },
    "required": ["action", "reasoning"],
})


_CLI_RATE_LIMIT_KEYWORDS = ("rate limit", "usage limit", "limit reached", "exceeded your", "monthly limit")

async def _decide_cli(state: dict) -> dict:
    """Fallback path: Claude CLI subprocess (uses OAuth session)."""
    if not shutil.which("claude"):
        print(f"  [{AGENT_NAME}] ⚠ claude CLI not found — folding")
        return {"action": "FOLD"}
    result = await asyncio.to_thread(
        subprocess.run,
        ["claude", "-p", build_prompt(state),
         "--model", CLI_MODEL,
         "--output-format", "json", "--json-schema", ACTION_SCHEMA],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        combined = (result.stderr + result.stdout).lower()
        if any(kw in combined for kw in _CLI_RATE_LIMIT_KEYWORDS):
            raise _RateLimitError(600.0, "Claude CLI usage limit reached")
        raise RuntimeError(result.stderr.strip())
    data = json.loads(result.stdout)
    decision = (data.get("structured_output") or
                json.loads(data.get("result", "{}").strip().lstrip("```json").rstrip("`")))
    return decision


async def decide(state: dict) -> dict:
    if _is_rate_limited():
        action = heuristic_decide(state)
        print(f"  [{AGENT_NAME}] ⏸ heuristic → {action['action']}")
        return action
    try:
        decision = await (_decide_sdk(state) if USE_SDK else _decide_cli(state))
        action    = decision.get("action", "FOLD").upper()
        reasoning = decision.get("reasoning", "")
        if reasoning:
            amt = f" {decision.get('amount')}" if action == "RAISE" else ""
            print(f"  [{AGENT_NAME}] {action}{amt} — {reasoning}")
        if action not in state["validActions"]:
            print(f"  [{AGENT_NAME}] invalid action {action!r}, folding")
            return {"action": "FOLD"}
        out = {"action": action}
        if action == "RAISE" and "amount" in decision:
            amt = int(decision["amount"])
            amt = max(state["minRaise"], min(state["maxRaise"], amt))
            out["amount"] = amt
        return out
    except _RateLimitError as e:
        _set_rate_limit(e)
        return heuristic_decide(state)
    except Exception as e:
        print(f"  [{AGENT_NAME}] error: {e} — folding")
        return {"action": "FOLD"}


# ── WebSocket loop ────────────────────────────────────────────────────────────

async def run() -> None:
    style_note = f" [{PERSONALITY[:40]}…]" if PERSONALITY else ""
    print(f"Connecting {AGENT_NAME} ({AGENT_ID}){style_note}")

    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({"type": "register", "agentId": AGENT_ID, "agentName": AGENT_NAME}))

        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "register_ack":
                print(f"  [{AGENT_NAME}] registered. "
                      f"Reasoning: {msg['timeLimitMs']}ms  Setup: {msg.get('setupMs','?')}ms")

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
                    board = fmt_cards(msg["communityCards"])
                    hands = ", ".join(
                        f"{s['playerId']} {fmt_cards(s['holeCards'])}"
                        + (f" ({s['handRank']})" if s.get("handRank") else "")
                        for s in msg["showdown"]
                    )
                    print(f"  [{AGENT_NAME}] Board: {board}  ·  {hands}")

            elif msg["type"] == "bounty_announced":
                if msg["targetId"] == AGENT_ID:
                    print(f"\n  [{AGENT_NAME}] ⚠️ BOUNTY ON ME! "
                          f"+{msg['reward']} chips, exp. h.{msg['expiresAfterHand']}\n")
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

            elif msg["type"] == "tournament_end":
                result = "🏆 WINNER" if msg["result"] == "won" else f"place #{msg['place']}"
                print(f"\n  [{AGENT_NAME}] {result}  stack: {msg['finalStack']:,}\n")
                break

            elif msg["type"] == "error":
                print(f"  [{AGENT_NAME}] server: {msg['message']}")


if __name__ == "__main__":
    asyncio.run(run())
