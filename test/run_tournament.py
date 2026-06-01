#!/usr/bin/env python3
"""
Tournament test runner.

Starts the server on port 3001, opens the lobby, launches 6 Sonnet agents
with distinct personalities, kicks off the tournament, and reports standings.

Usage:  python3 test/run_tournament.py
"""

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import aiohttp

ROOT       = Path(__file__).parent.parent
SERVER_DIR = ROOT / "server"
AGENT_PY   = ROOT / "test" / "personality_agent.py"

PORT           = 3001
ADMIN_KEY      = "test-tournament-2025"
SPECTATOR_KEY  = "test-spectator-2025"

# ── Agent roster ──────────────────────────────────────────────────────────────
AGENTS = [
    {
        "id":   "ace-hunter",
        "name": "AceHunter",
        "personality": (
            "Play tight-aggressive. Only open with premium hands (AA, KK, QQ, JJ, AK, AQ). "
            "Raise big when you do play. Fold everything else without hesitation."
        ),
    },
    {
        "id":   "call-station",
        "name": "CallStation",
        "personality": (
            "Play loose-passive. Call almost every bet to see cheap cards. "
            "Rarely raise unless you have the absolute nuts. See as many flops as possible."
        ),
    },
    {
        "id":   "the-maniac",
        "name": "TheManiac",
        "personality": (
            "Play hyper-aggressively. Raise and re-raise constantly to put opponents under pressure. "
            "Bluff frequently on any draw. Make your opponents fold by betting big on every street."
        ),
    },
    {
        "id":   "pot-odds-pete",
        "name": "PotOddsPete",
        "personality": (
            "Play by pot odds and expected value. Calculate whether calling is mathematically "
            "profitable. Raise with hands that have strong equity. Fold when the math says fold."
        ),
    },
    {
        "id":   "bounty-hunter",
        "name": "BountyHunter",
        "personality": (
            "Focus on collecting bounties. When a bounty target is at your table, aggressively "
            "go after them. Adjust your range to pressure bounty targets specifically. "
            "Be willing to gamble to claim a bounty reward."
        ),
    },
    {
        "id":   "balanced-bot",
        "name": "BalancedBot",
        "personality": (
            "Play balanced, unexploitable poker. Mix bluffs with value bets at appropriate "
            "frequencies. Adjust based on position and stack depth. Think several streets ahead."
        ),
    },
]

# ── Server management ─────────────────────────────────────────────────────────

async def wait_for_server(timeout: int = 30) -> bool:
    deadline = time.time() + timeout
    async with aiohttp.ClientSession() as s:
        while time.time() < deadline:
            try:
                async with s.get(f"http://localhost:{PORT}/api/agents") as r:
                    if r.status == 200:
                        return True
            except Exception:
                pass
            await asyncio.sleep(0.4)
    return False

async def api_post(session: aiohttp.ClientSession, path: str) -> int:
    url = f"http://localhost:{PORT}{path}"
    async with session.post(url) as r:
        return r.status

async def agent_count(session: aiohttp.ClientSession) -> int:
    try:
        async with session.get(f"http://localhost:{PORT}/api/agents") as r:
            d = await r.json()
            return d.get("count", 0)
    except Exception:
        return 0

# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    env = {
        **os.environ,
        "ADMIN_KEY":               ADMIN_KEY,
        "SPECTATOR_KEY":           SPECTATOR_KEY,
        "PORT":                    str(PORT),
        "MIN_PLAYERS":             str(len(AGENTS)),
        "STARTING_STACK":          "1500",
        "TABLE_SIZE":              "3",     # 2 tables of 3 — multi-table play
        "ACTION_TIMEOUT":          "20000", # 20s reasoning window (after action_ack); ackWindowMs=80s covers CLI startup
        "TOURNAMENT_START_DELAY":  "5",
        "TURN_DELAY_MS":           "300",
        "BOUNTY_WINDOW_HANDS":     "10",   # target has 10 hands to be eliminated
        "BOUNTY_FIRE_EVERY":       "5",    # new bounty every 5 hands after last resolved
        "BOUNTY_REWARD":           "400",  # meaningful but not game-breaking
        "BOUNTY_CURSE_AMOUNT":     "100",  # curse the rival!
        "SPECTATOR_DELAY_S":       "0",
        "DEVELOPER_MODE":          "true",
    }

    print("=" * 60)
    print("  POKER TOURNAMENT — Sonnet vs Sonnet")
    print("=" * 60)
    print(f"\nAgents ({len(AGENTS)}):")
    for a in AGENTS:
        print(f"  {a['name']:<16} — {a['personality'][:55]}…")

    # Clear any process holding the port before starting
    subprocess.run(["bash", "-c", f"lsof -ti:{PORT} | xargs kill -9 2>/dev/null; sleep 0.5"],
                   check=False)

    print(f"\nStarting server on port {PORT}…")
    proc = subprocess.Popen(
        ["npx", "tsx", "src/index.ts"],
        cwd=SERVER_DIR, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    agent_procs: list = []  # initialised here so finally block is always safe
    try:
        if not await wait_for_server():
            print("Server failed to start — aborting.")
            return

        print("Server ready.")
        print(f"\n  Public dashboard:  http://localhost:{PORT}/")
        print(f"  Keyed dashboard:   http://localhost:{PORT}/?key={SPECTATOR_KEY}  (hole cards visible)")
        print(f"  Admin panel:       http://localhost:{PORT}/admin?key={ADMIN_KEY}\n")

        async with aiohttp.ClientSession() as session:
            status = await api_post(session, f"/api/open?key={ADMIN_KEY}")
            if status != 200:
                print(f"Could not open lobby (HTTP {status})")
                return
            print("Lobby open — launching agents…\n")

        # Start each agent as a subprocess
        agent_procs.clear()
        for a in AGENTS:
            agent_env = {
                **os.environ,
                "POKER_SERVER":      f"ws://localhost:{PORT}",
                "AGENT_ID":          a["id"],
                "AGENT_NAME":        a["name"],
                "AGENT_PERSONALITY": a["personality"],
                "CLAUDE_MODEL":      "claude-haiku-4-5-20251001",  # SDK model id
                # CLI_MODEL env used automatically when ANTHROPIC_API_KEY not set
            }
            log_path = ROOT / "test" / f"agent_{a['id']}.log"
            p = subprocess.Popen(
                [sys.executable, str(AGENT_PY)],
                env=agent_env,
                stdout=open(log_path, 'w'),
                stderr=subprocess.STDOUT,
            )
            agent_procs.append(p)
            await asyncio.sleep(0.2)  # stagger connections slightly

        # Wait for all agents to connect
        print(f"Waiting for {len(AGENTS)} agents to connect…")
        async with aiohttp.ClientSession() as session:
            for _ in range(60):
                await asyncio.sleep(0.5)
                n = await agent_count(session)
                print(f"  {n}/{len(AGENTS)} connected\r", end="", flush=True)
                if n >= len(AGENTS):
                    break
        print(f"\n\nAll {len(AGENTS)} connected — starting tournament in 5s…\n")

        async with aiohttp.ClientSession() as session:
            await api_post(session, f"/api/start?key={ADMIN_KEY}")

        # Wait for all agents to finish
        for p in agent_procs:
            p.wait()

        print("\n" + "=" * 60)
        print("  TOURNAMENT COMPLETE")
        print("=" * 60)

        # ── Highlights from agent logs ────────────────────────────────────────
        print("\n📋 HIGHLIGHTS\n")
        notable = []
        for a in AGENTS:
            log_path = ROOT / "test" / f"agent_{a['id']}.log"
            try:
                lines = open(log_path).readlines()
            except FileNotFoundError:
                continue
            wins = losses = timeouts = net = 0
            for line in lines:
                low = line.lower()
                if "hand #" in low:
                    for tok in line.split():
                        if tok.startswith('+'):
                            try: net += int(tok[1:]); wins += 1
                            except: pass
                        elif tok.startswith('-') and tok[1:].isdigit():
                            try: net += int(tok); losses += 1
                            except: pass
                if "timeout" in low:
                    timeouts += 1
                for marker in ("🏆", "WINNER"):
                    if marker in line:
                        notable.append(f"🏆  {a['name']} won the tournament!")
                if "💀" in line and "Cursing" in line:
                    notable.append(f"  {line.strip()}")
                if "🎯" in line:
                    notable.append(f"  {line.strip()}")
                if "BOUNTY ON ME" in line:
                    notable.append(f"  [{a['name']}] had a bounty on their head")
            timeout_note = f"  ⚠ {timeouts} timeout(s)" if timeouts else ""
            print(f"  {a['name']:<16}  net: {'+' if net >= 0 else ''}{net:,}{timeout_note}")

        if notable:
            print("\n🎲 KEY MOMENTS")
            for n in dict.fromkeys(notable)[:10]:   # deduplicate, cap at 10
                print(f"  {n}")
        print()

    finally:
        for p in agent_procs:
            try:
                p.terminate()
            except Exception:
                pass
        proc.terminate()
        proc.wait()
        print("\nServer stopped.")

if __name__ == "__main__":
    asyncio.run(main())
