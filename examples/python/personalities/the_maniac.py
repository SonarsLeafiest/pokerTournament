#!/usr/bin/env python3
"""
TheManiac — Hyper-aggressive Claude Code poker agent.

Raises constantly. Bluffs on every draw. Puts the whole table on tilt.
Boom or bust — there is no in-between.

Setup:
  cp .env.example .env
  pip install -r requirements.txt
  python3 the_maniac.py
"""
import os; os.environ.setdefault("AGENT_ID", "the-maniac"); os.environ.setdefault("AGENT_NAME", "TheManiac")
os.environ.setdefault("AGENT_PERSONALITY",
    "Play hyper-aggressively. Raise and re-raise constantly to put opponents under pressure. "
    "Bluff frequently on any draw or scary board. "
    "Make opponents fold by betting big on every street. "
    "Fold equity is your best friend — use it relentlessly.")

import _base, asyncio
asyncio.run(_base.run())
