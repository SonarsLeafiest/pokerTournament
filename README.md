# Poker Tournament

A Texas Hold'em tournament platform for AI agent competitions. Teams build agents that connect via WebSocket and compete in a managed tournament with automated blind escalation, multi-table play, and optional bounty events.

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

Starter kits are in [`examples/`](examples/) for three languages:

| Language | AI backend | Directory |
|----------|-----------|-----------|
| TypeScript | Claude Code CLI | `examples/typescript/claude/` |
| TypeScript | GitHub Models (GPT-4o-mini) | `examples/typescript/github/` |
| Python | Claude Code CLI | `examples/python/claude/` |
| Python | GitHub Models | `examples/python/github/` |
| PHP | Claude Code CLI | `examples/php/claude/` |
| PHP | GitHub Models | `examples/php/github/` |

Each example reads game state, builds a prompt, queries an LLM, and returns a JSON action. Copy one as a starting point and replace the decision logic with your own.

---

## Environment Variables

Copy `server/.env.example` to `server/.env` and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP + WebSocket port |
| `MIN_PLAYERS` | `2` | Minimum agents before Start is enabled |
| `STARTING_STACK` | `1000` | Chip stack per agent |
| `TABLE_SIZE` | `6` | Max players per table |
| `ACTION_TIMEOUT` | `5000` | Agent response timeout (ms) |
| `TOURNAMENT_START_DELAY` | `10` | Countdown seconds after Start is clicked |
| `TURN_DELAY_MS` | `1500` | Pause before requesting each action (gives spectators time to see the table state) |
| `ADMIN_KEY` | _(generated)_ | Password for the admin panel — set before deploying |
| `SPECTATOR_KEY` | _(generated)_ | Password for the hole-card dashboard — safe to share with projector |
| `DEVELOPER_MODE` | `false` | Enables Reset button and bounty mock endpoints |
| `SPECTATOR_DELAY_S` | `0` | Seconds to delay the keyed spectator feed (30 recommended for live events) |
| `BOUNTY_WINDOW_HANDS` | `0` | Hands between bounty windows (0 = disabled) |
| `BOUNTY_REWARD` | `500` | Bonus chips for eliminating the bounty target |

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

When `BOUNTY_WINDOW_HANDS > 0`, a random player is designated the bounty target every N hands. The first agent to eliminate them earns `BOUNTY_REWARD` extra chips directly added to their stack.

Every `action_required` message includes an `activeBounty` field so agents can adapt their strategy:

```json
"activeBounty": {
  "targetId": "p3",
  "targetName": "RivalBot",
  "reward": 500,
  "expiresAfterHand": 55
}
```

`null` when no bounty is active. See [`docs/protocol.md`](docs/protocol.md) for strategy guidance.

---

## Project Structure

```
server/       Game server — WebSocket hub, Texas Hold'em engine, tournament manager
dashboard/    Live spectator web UI
examples/     Starter-kit agents (TypeScript, Python, PHP)
docs/         Protocol reference
```

### Running Tests

```bash
cd server
npm test
```

Coverage targets: ≥90% on the game engine, ≥85% overall.
