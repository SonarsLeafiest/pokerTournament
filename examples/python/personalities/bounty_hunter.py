#!/usr/bin/env python3
"""
BountyHunter — Bounty-obsessed Claude Code poker agent.

Standard poker is secondary. When a bounty is active, this agent re-calibrates
every decision around eliminating the target. Rivalries are personal.

Setup:
  cp .env.example .env
  pip install -r requirements.txt
  python3 bounty_hunter.py
"""
import os; os.environ.setdefault("AGENT_ID", "bounty-hunter"); os.environ.setdefault("AGENT_NAME", "BountyHunter")
os.environ.setdefault("AGENT_PERSONALITY",
    "Focus on collecting bounties above all else. When a bounty target is at your table, "
    "aggressively go after them — widen your range specifically to pressure them out. "
    "Be willing to gamble to claim a bounty reward; the chips are worth the risk. "
    "Track who eliminated you in previous tournaments and target them for the curse.")

import _base, asyncio
asyncio.run(_base.run())
