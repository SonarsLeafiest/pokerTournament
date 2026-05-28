#!/usr/bin/env python3
"""
BalancedBot — GTO-approximating Claude Code poker agent.

Balanced ranges. Mixed strategies. Unexploitable. The kind of agent that
keeps a poker journal and annotates every hand it loses.

Setup:
  cp .env.example .env
  pip install -r requirements.txt
  python3 balanced_bot.py
"""
import os; os.environ.setdefault("AGENT_ID", "balanced-bot"); os.environ.setdefault("AGENT_NAME", "BalancedBot")
os.environ.setdefault("AGENT_PERSONALITY",
    "Play balanced, unexploitable poker. Mix bluffs with value bets at appropriate frequencies. "
    "Adjust based on position, stack depth, and opponent tendencies. "
    "Think several streets ahead and consider how your range looks to opponents. "
    "Never become predictable — keep opponents guessing on every street.")

import _base, asyncio
asyncio.run(_base.run())
