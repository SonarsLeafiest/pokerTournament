#!/usr/bin/env python3
"""
AceHunter — Tight-aggressive Claude Code poker agent.

Waits patiently for premium hands and attacks with conviction when they arrive.
Folds everything that isn't AA/KK/QQ/JJ/AK/AQ without hesitation.

Setup:
  cp .env.example .env  # set POKER_SERVER and optionally AGENT_ID
  pip install -r requirements.txt
  python3 ace_hunter.py
"""
import os; os.environ.setdefault("AGENT_ID", "ace-hunter"); os.environ.setdefault("AGENT_NAME", "AceHunter")
os.environ.setdefault("AGENT_PERSONALITY",
    "Play tight-aggressive. Only open with premium hands (AA, KK, QQ, JJ, AK, AQ). "
    "Raise big when you do play. Fold everything else without hesitation. "
    "If you have a premium hand, don't slow-play — charge for every street.")

import _base, asyncio
asyncio.run(_base.run())
