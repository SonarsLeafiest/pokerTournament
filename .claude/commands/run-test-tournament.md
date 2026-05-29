---
name: run-test-tournament
description: Launch the full test tournament — starts the server on port 3001, connects all 6 personality agents (AceHunter, CallStation, TheManiac, PotOddsPete, BountyHunter, BalancedBot), and runs until a winner is found. Use this to smoke-test server changes or to watch the personalities battle it out.
---

# Run Test Tournament

Launch the complete test tournament using the orchestration script.

## Steps

1. **Check for port conflicts** — make sure nothing is already running on port 3001:
   ```bash
   lsof -ti:3001 | xargs kill -9 2>/dev/null; echo "port 3001 clear"
   ```

2. **Install Python dependencies** if not already present:
   ```bash
   pip3 install websockets aiohttp python-dotenv --break-system-packages -q
   ```

3. **Launch the tournament** from the repo root:
   ```bash
   python3 test/run_tournament.py
   ```

4. **Monitor output** — the script prints:
   - URLs for the dashboard and admin panel
   - Each agent's actions and reasoning as they play
   - Hand results with chip deltas
   - Showdown cards when players go to the river
   - Bounty announcements, claims, and curses (💀) if bounties fire
   - Final standings when the tournament ends

## What to watch for

| Sign | Meaning |
|------|---------|
| `[AgentName] timeout — folding` | Agent took > 8 s to respond; Claude CLI was too slow |
| `[AgentName] error: … — folding` | Claude CLI returned an error or bad JSON |
| `💰 Bounty: X +400` | A bounty fired — see if BountyHunter hunts them down |
| `💀 X cursing Y` | A bounty was claimed and the winner picked a rival to curse |

## Dashboard

While the tournament runs, open the public dashboard in a browser:

```
http://localhost:3001/
```

Or the keyed view (hole cards visible):

```
http://localhost:3001/?key=test-spectator-2025
```

Admin panel (force bounties, reset):

```
http://localhost:3001/admin?key=test-tournament-2025
```

## Troubleshooting

- **"Server failed to start"** — check `server/src/index.ts` compiles: `cd server && npx tsc --noEmit`
- **All agents timing out** — Claude CLI may need auth: run `claude --version` to verify
- **Port already in use** — run step 1 above to clear it
