#!/usr/bin/env python3
"""
test-agents.py — Spin up simple test bots for local development.

Each bot plays a straightforward (but not completely brainless) strategy:
  - Never fold when it can check
  - Call ~70% of the time rather than folding
  - Raise ~15% of the time with a min-raise

Usage examples:
  python scripts/test-agents.py                              # 3 bots, no disconnects
  python scripts/test-agents.py --count 6                   # 6 bots
  python scripts/test-agents.py --count 4 --disconnect 2    # 2 bots disconnect after 5 hands
  python scripts/test-agents.py --count 4 --disconnect 2 --reconnect          # and reconnect
  python scripts/test-agents.py --count 4 --disconnect 2 --disconnect-after 3 # after 3 hands
  python scripts/test-agents.py --server ws://myserver:3000 --count 8

Requirements:
  pip install websockets
"""

import argparse
import asyncio
import json
import os
import random
import signal
from typing import Optional

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:
    print("Missing dependency: pip install websockets")
    raise SystemExit(1)

DEFAULT_SERVER = os.environ.get("POKER_SERVER", "ws://localhost:3000")


# ── Decision logic ────────────────────────────────────────────────────────────

def decide(state: dict) -> dict:
    valid = state["validActions"]
    if "CHECK" in valid:
        if "RAISE" in valid and random.random() < 0.15:
            amt = min(state["minRaise"] * 2, state["maxRaise"])
            return {"action": "RAISE", "amount": amt}
        return {"action": "CHECK"}
    if "RAISE" in valid and random.random() < 0.10:
        return {"action": "RAISE", "amount": state["minRaise"]}
    if "CALL" in valid and random.random() < 0.70:
        return {"action": "CALL"}
    return {"action": "FOLD"}


# ── Agent ─────────────────────────────────────────────────────────────────────

class TestAgent:
    def __init__(
        self,
        agent_id: str,
        server_url: str,
        disconnect_after: Optional[int],
        reconnect: bool,
    ):
        self.agent_id         = agent_id
        self.agent_name       = f"TestBot-{agent_id}"
        self.server_url       = server_url
        self.disconnect_after = disconnect_after   # None = never disconnect
        self.reconnect        = reconnect
        self.hands_played     = 0
        self.stack            = 0
        self.done             = False

    async def run(self) -> None:
        while not self.done:
            try:
                await self._session()
            except asyncio.CancelledError:
                return
            except Exception as e:
                if not self.done:
                    _log(self.agent_id, f"connection error ({e}), retrying in 2s")
                    await asyncio.sleep(2)

    async def _session(self) -> None:
        async with websockets.connect(self.server_url) as ws:
            await ws.send(json.dumps({
                "type":      "register",
                "agentId":   self.agent_id,
                "agentName": self.agent_name,
            }))
            _log(self.agent_id, "connected")

            async for raw in ws:
                msg = json.loads(raw)

                if msg["type"] == "action_required":
                    if (
                        self.disconnect_after is not None
                        and self.hands_played >= self.disconnect_after
                    ):
                        _log(self.agent_id,
                             f"disconnecting after {self.hands_played} hands"
                             + (" (will reconnect)" if self.reconnect else ""))
                        self.disconnect_after = None  # disconnect once only
                        if not self.reconnect:
                            self.done = True
                        await ws.close()
                        return

                    action = decide(msg)
                    await ws.send(json.dumps({
                        "type":   "action",
                        "gameId": msg["gameId"],
                        **action,
                    }))

                elif msg["type"] == "hand_result":
                    self.hands_played += 1
                    delta = msg.get("deltas", {}).get(self.agent_id)
                    if delta:
                        _log(self.agent_id,
                             f"hand #{msg['handNumber']}  "
                             f"{'+' if delta > 0 else ''}{delta}  "
                             f"stack: {self.stack:,}")

                elif msg["type"] == "tournament_update":
                    me = next(
                        (p for p in msg["standings"] if p["playerId"] == self.agent_id),
                        None,
                    )
                    if me:
                        self.stack = me["stack"]

                elif msg["type"] == "tournament_end":
                    place  = msg["place"]
                    result = "🏆 WON" if msg["result"] == "won" else f"place #{place}"
                    _log(self.agent_id, f"tournament ended — {result}  final stack: {msg['finalStack']:,}")
                    self.done = True
                    return

                elif msg["type"] == "error":
                    _log(self.agent_id, f"server error: {msg['message']}")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _log(agent_id: str, msg: str) -> None:
    print(f"  [{agent_id}] {msg}", flush=True)


# ── Entry point ───────────────────────────────────────────────────────────────

async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Spin up simple test agents for local development.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.strip(),
    )
    parser.add_argument("--count",            type=int, default=3,
                        metavar="N",      help="number of agents to start (default: 3)")
    parser.add_argument("--server",           type=str, default=DEFAULT_SERVER,
                        metavar="URL",    help=f"WebSocket server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--disconnect",       type=int, default=0,
                        metavar="N",      help="number of agents that will disconnect mid-game (default: 0)")
    parser.add_argument("--disconnect-after", type=int, default=5,
                        metavar="HANDS",  help="disconnect after N hands have been played (default: 5)")
    parser.add_argument("--reconnect",        action="store_true",
                        help="disconnected agents automatically reconnect")
    args = parser.parse_args()

    print(f"\nStarting {args.count} test agent(s) → {args.server}")
    if args.disconnect:
        suffix = "then reconnect" if args.reconnect else "permanently"
        print(f"  {args.disconnect} agent(s) will disconnect after {args.disconnect_after} hands ({suffix})")
    print("  Ctrl-C to stop\n")

    agents: list[TestAgent] = []
    for i in range(args.count):
        disc = args.disconnect_after if i < args.disconnect else None
        agents.append(TestAgent(
            agent_id=f"test-{i + 1}",
            server_url=args.server,
            disconnect_after=disc,
            reconnect=args.reconnect,
        ))

    tasks = [asyncio.create_task(a.run(), name=a.agent_id) for a in agents]

    loop = asyncio.get_running_loop()

    def _shutdown(*_: object) -> None:
        print("\nShutting down…")
        for a in agents:
            a.done = True
        for t in tasks:
            t.cancel()

    try:
        loop.add_signal_handler(signal.SIGINT,  _shutdown)
        loop.add_signal_handler(signal.SIGTERM, _shutdown)
    except NotImplementedError:
        pass  # Windows

    await asyncio.gather(*tasks, return_exceptions=True)
    print("All agents finished.")


if __name__ == "__main__":
    asyncio.run(main())
