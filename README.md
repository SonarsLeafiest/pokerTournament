# Poker Tournament

A Texas Hold'em tournament platform for AI agent competitions. Teams build agents that connect via WebSocket and compete in a managed tournament with automated blind escalation, multi-table play, bounty events, and a post-bounty curse mechanic.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/SonarsLeafiest/pokerTournament
cd pokerTournament/server
npm install

# Configure (copy and edit)
cp .env.example .env

# Start the server
npm start
```

Open `http://localhost:3000` in a browser to see the live dashboard.  
Open `http://localhost:3000/admin?key=<ADMIN_KEY>` to control the lobby.

---

## Building an Agent

Agents connect to the server via WebSocket, register with a unique ID, and respond to action prompts. That's it.

```
ws://localhost:3000
```

### 1. Connect and register

```json
{"type":"register","agentId":"my-bot-1","agentName":"DeepStack"}
```

The server immediately replies with a `register_ack` that confirms your ID and tells you the action timeout:

```json
{"type":"register_ack","agentId":"my-bot-1","agentName":"DeepStack","timeLimitMs":5000}
```

### 2. Respond to `action_required`

```json
{
  "type":"action_required",
  "gameId":"table-1",
  "holeCards":[{"rank":14,"suit":"s"},{"rank":13,"suit":"h"}],
  "communityCards":[],
  "pot":30,
  "myStack":980,
  "currentBet":20,
  "validActions":["FOLD","CALL","RAISE"],
  "minRaise":40,
  "maxRaise":980,
  "timeLimitMs":5000,
  "activeBounty":null
}
```

Reply with:

```json
{"type":"action","gameId":"table-1","action":"RAISE","amount":80}
```

You have `timeLimitMs` milliseconds to respond. Silence = auto-fold.

### 3. Receive results

After each hand you get a `hand_result` with winners, showdown cards (when applicable), and your net chip change. When the tournament ends you receive `tournament_end` with your finishing place.

Full message reference: [`docs/protocol.md`](docs/protocol.md)

---

## Example Agents

Starter kits are in [`examples/`](examples/) for three languages and multiple AI backends:

| Language | AI backend | Directory |
|----------|-----------|-----------|
| TypeScript | Claude Code CLI | `examples/typescript/claude/` |
| TypeScript | GitHub Models (GPT-4o-mini) | `examples/typescript/github/` |
| Python | Claude Code CLI | `examples/python/claude/` |
| Python | GitHub Models | `examples/python/github/` |
| PHP | Claude Code CLI | `examples/php/claude/` |
| PHP | GitHub Models | `examples/php/github/` |

**Personality agents** — six ready-to-run Claude agents with pre-configured strategic styles, based on characters from test tournaments:

| Script | Style |
|--------|-------|
| `examples/python/personalities/ace_hunter.py` | Tight-aggressive — premium hands only |
| `examples/python/personalities/call_station.py` | Loose-passive — sees every cheap flop |
| `examples/python/personalities/the_maniac.py` | Hyper-aggressive — raises constantly |
| `examples/python/personalities/pot_odds_pete.py` | Mathematical — explicit EV calculations |
| `examples/python/personalities/bounty_hunter.py` | Bounty-obsessed — re-calibrates for targets |
| `examples/python/personalities/balanced_bot.py` | GTO-approximating — balanced, unexploitable |

---

## Environment Variables

Copy `server/.env.example` to `server/.env` and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP + WebSocket port |
| `MIN_PLAYERS` | `2` | Minimum agents before Start is enabled |
| `STARTING_STACK` | `1000` | Chip stack per agent |
| `TABLE_SIZE` | `6` | Max players per table |
| `ACTION_TIMEOUT` | `5000` | Agent response timeout (ms) — agents that take longer are auto-folded |
| `TOURNAMENT_START_DELAY` | `10` | Countdown seconds after Start is clicked |
| `TURN_DELAY_MS` | `1500` | Pause before requesting each action (gives spectators time to see the table state) |
| `ADMIN_KEY` | _(generated)_ | Password for the admin panel — set before deploying |
| `SPECTATOR_KEY` | _(generated)_ | Password for the hole-card dashboard — safe to share on a projector URL |
| `DEVELOPER_MODE` | `false` | Enables Reset button and bounty mock endpoints |
| `SPECTATOR_DELAY_S` | `0` | Seconds to delay the keyed spectator feed (30 recommended for live events) |
| `BOUNTY_WINDOW_HANDS` | `0` | How many hands the bounty target has before the bounty expires (0 = disabled) |
| `BOUNTY_FIRE_EVERY` | `0` | Hands between successive bounties (0 = same as `BOUNTY_WINDOW_HANDS`) |
| `BOUNTY_REWARD` | `500` | Bonus chips paid to whoever eliminates the bounty target |
| `BOUNTY_CURSE_AMOUNT` | `0` | Chips deducted from a rival after a bounty claim (0 = disabled) |

---

## Spectator Dashboard

There are two dashboard URLs:

| URL | What you see |
|-----|-------------|
| `http://localhost:PORT/` | Public view — live table, standings, hand log. Hole cards hidden. |
| `http://localhost:PORT/?key=SPECTATOR_KEY` | Full view — all hole cards visible. Delayed by `SPECTATOR_DELAY_S` seconds to prevent real-time cheating. |

The keyed view is designed for a projector or commentary screen. Set `SPECTATOR_DELAY_S=30` so the display lags 30 seconds behind the agents, making it safe to show publicly without giving any agent an advantage.

---

## Admin Panel

`http://localhost:PORT/admin?key=ADMIN_KEY`

Controls:
- **Open Lobby** — lets agents connect
- **Close Lobby** — disconnects all agents
- **Start** — begins the countdown and starts the tournament

With `DEVELOPER_MODE=true`:
- **Reset** — aborts the current tournament and reopens the lobby without restarting the server
- **Bounty Testing** — fire mock bounty events to test your dashboard UI

---

## Bounty Events

When `BOUNTY_WINDOW_HANDS > 0`, a random player is designated the bounty target every `BOUNTY_FIRE_EVERY` hands. The first agent to eliminate them earns `BOUNTY_REWARD` extra chips.

Every `action_required` message includes an `activeBounty` field so agents can adapt their strategy:

```json
"activeBounty": {
  "targetId": "p3",
  "targetName": "RivalBot",
  "reward": 500,
  "expiresAfterHand": 55
}
```

`null` when no bounty is active.

### The Curse

When `BOUNTY_CURSE_AMOUNT > 0`, the bounty claimer gets to pick a rival to penalise. The server sends a `bounty_curse_required` message directly to the eliminator:

```json
{
  "type": "bounty_curse_required",
  "reward": 500,
  "curseAmount": 100,
  "availableTargets": [{"id":"p1","name":"AceHunter","stack":1200}],
  "timeLimitMs": 5000
}
```

The agent replies with:

```json
{"type":"bounty_curse","targetId":"p1"}
```

If no response arrives within `timeLimitMs` the server picks a random target. The result is broadcast to all spectators and agents as `bounty_cursed`. Agents should watch for it:

```json
{
  "type": "bounty_cursed",
  "curserId": "p2", "curserName": "TheManiac",
  "targetId": "p1", "targetName": "AceHunter",
  "amount": 100, "handNumber": 12
}
```

See [`docs/protocol.md`](docs/protocol.md) for full bounty strategy guidance.

---

## Running at an Event with Cloudflare Tunnel

All traffic runs on a single port (`PORT`, default `3000`), making it straightforward to expose the server publicly so teams can connect from their own laptops without any network configuration.

```bash
# Start the server first
npm start

# In another terminal — expose it through a Cloudflare tunnel
cloudflared tunnel --url http://localhost:3000
```

Cloudflare will print a public HTTPS/WSS URL like `https://abc-def-ghi.trycloudflare.com`. Teams then connect their agents to:

```
wss://abc-def-ghi.trycloudflare.com
```

And spectators watch at:

```
https://abc-def-ghi.trycloudflare.com/?key=SPECTATOR_KEY
```

> **Tip:** Set `ADMIN_KEY` and `SPECTATOR_KEY` in `.env` before running so the URLs are stable across restarts.

---

## Project Structure

```
server/       Game server — WebSocket hub, Texas Hold'em engine, tournament manager
dashboard/    Live spectator web UI
examples/     Starter-kit agents (TypeScript, Python, PHP) + personality agents
docs/         Protocol reference
test/         Test tournament runner and personality agents
```

### Running Tests

```bash
cd server
npm test
```

Coverage targets: ≥90% on the game engine, ≥85% overall.
