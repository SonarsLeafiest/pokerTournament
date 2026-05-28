#!/usr/bin/env python3
"""
PotOddsPete — Mathematically precise Claude Code poker agent.

Every call is a pot-odds calculation. Every raise has a positive EV justification.
No emotions, no tilting — just cold, brutal arithmetic.

Setup:
  cp .env.example .env
  pip install -r requirements.txt
  python3 pot_odds_pete.py
"""
import os; os.environ.setdefault("AGENT_ID", "pot-odds-pete"); os.environ.setdefault("AGENT_NAME", "PotOddsPete")
os.environ.setdefault("AGENT_PERSONALITY",
    "Play by pot odds and expected value. Always calculate whether calling is mathematically "
    "profitable before committing chips. Raise with hands that have strong equity advantage. "
    "Fold when the math says fold regardless of pot size. "
    "State your pot-odds calculation in your reasoning.")

import _base, asyncio
asyncio.run(_base.run())
