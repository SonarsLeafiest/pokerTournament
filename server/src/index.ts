import 'dotenv/config'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { WebSocketHub } from './server/websocket.js'
import { SpectatorState } from './server/spectator.js'
import { Orchestrator } from './server/orchestrator.js'
import { createHttpHandler, type LobbyState } from './server/http.js'
import type { TournamentConfig } from './engine/tournament.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────────────────

const PORT                  = parseInt(process.env.PORT                   ?? '3000')
const MIN_PLAYERS           = parseInt(process.env.MIN_PLAYERS            ?? '2')
const STARTING_STACK        = parseInt(process.env.STARTING_STACK         ?? '1000')
const ACTION_TIMEOUT        = parseInt(process.env.ACTION_TIMEOUT         ?? '5000')
const TABLE_SIZE            = parseInt(process.env.TABLE_SIZE             ?? '6')
const TOURNAMENT_START_DELAY = parseInt(process.env.TOURNAMENT_START_DELAY ?? '10')
const TURN_DELAY_MS         = parseInt(process.env.TURN_DELAY_MS          ?? '1500')
const SPECTATOR_DELAY_MS    = parseInt(process.env.SPECTATOR_DELAY_S      ?? '0') * 1000
const BOUNTY_WINDOW_HANDS   = parseInt(process.env.BOUNTY_WINDOW_HANDS    ?? '0')
const BOUNTY_FIRE_EVERY     = parseInt(process.env.BOUNTY_FIRE_EVERY      ?? '0')
const BOUNTY_REWARD         = parseInt(process.env.BOUNTY_REWARD          ?? '500')
const BOUNTY_CURSE_AMOUNT   = parseInt(process.env.BOUNTY_CURSE_AMOUNT    ?? '0')
const RECONNECT_TIMEOUT_MS  = parseInt(process.env.RECONNECT_TIMEOUT_MS   ?? '60000')
const DEVELOPER_MODE        = process.env.DEVELOPER_MODE === 'true'
const ADMIN_KEY = process.env.ADMIN_KEY ?? (() => {
  const generated = randomBytes(16).toString('hex').toUpperCase()
  console.warn(`\n  WARNING  ADMIN_KEY not set — generated key: ${generated}\n  Set ADMIN_KEY in .env to make it permanent.\n`)
  return generated
})()

// Separate lower-privilege key: lets spectators see hole cards, but cannot
// control the tournament.  Safe to share on a projector URL.
const SPECTATOR_KEY = process.env.SPECTATOR_KEY ?? (() => {
  const generated = randomBytes(16).toString('hex').toUpperCase()
  console.warn(`  WARNING  SPECTATOR_KEY not set — generated key: ${generated}\n  Set SPECTATOR_KEY in .env to make it permanent.\n`)
  return generated
})()

const BLIND_LEVELS: TournamentConfig['blindLevels'] = [
  { smallBlind: 10,  bigBlind: 20,  handsPerLevel: 10  },
  { smallBlind: 25,  bigBlind: 50,  handsPerLevel: 10  },
  { smallBlind: 50,  bigBlind: 100, handsPerLevel: 10  },
  { smallBlind: 100, bigBlind: 200, handsPerLevel: 10  },
  { smallBlind: 200, bigBlind: 400, handsPerLevel: 999 },
]

// ── Mutable lobby state ───────────────────────────────────────────────────────

let lobbyState:      LobbyState = 'closed'
let tournamentAbort: boolean    = false

// ── Core instances ────────────────────────────────────────────────────────────

const spectator = new SpectatorState(SPECTATOR_KEY, SPECTATOR_DELAY_MS)

const hub = new WebSocketHub({
  noServer:           true,
  actionTimeoutMs:    ACTION_TIMEOUT,
  // 4× the reasoning window as the overhead budget — generous enough for slow
  // LLM clients (CLI subprocess, slow networks) without hanging forever.
  ackWindowMs:        ACTION_TIMEOUT * 4,
  reconnectTimeoutMs: RECONNECT_TIMEOUT_MS,
  // Only allow new registrations while the lobby is open; reconnects always pass.
  canRegister: () => lobbyState === 'open',

  onAgentConnect(agent) {
    console.log(`[hub] ${agent.name} (${agent.id}) connected`)
    broadcastLobbySnapshot()
  },

  onAgentDisconnect(agentId) {
    console.log(`[hub] ${agentId} disconnected`)
    spectator.updatePlayerConnected(agentId, false)
    broadcastLobbySnapshot()
  },

  onAgentReconnect(agent) {
    console.log(`[hub] ${agent.name} (${agent.id}) reconnected`)
    spectator.updatePlayerConnected(agent.id, true)
    broadcastLobbySnapshot()
    const pending = orchestrator.getPendingAction(agent.id)
    if (pending) hub.sendToAgent(agent.id, pending)
  },
})

const orchestrator = new Orchestrator({
  hub,
  spectator,
  turnDelayMs:       TURN_DELAY_MS,
  actionTimeout:     ACTION_TIMEOUT,
  getLobbyState:     () => lobbyState,
  setLobbyState:     (s) => { lobbyState = s },
  isAborted:         () => tournamentAbort,
  bountyWindowHands:  BOUNTY_WINDOW_HANDS,
  bountyFireEvery:    BOUNTY_FIRE_EVERY,
  bountyReward:       BOUNTY_REWARD,
  bountyCurseAmount:  BOUNTY_CURSE_AMOUNT,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function broadcastLobbySnapshot(): void {
  if (lobbyState !== 'open' && lobbyState !== 'starting') return
  spectator.broadcast({ type: 'lobby_snapshot', agents: hub.getConnectedAgents() })
}

function triggerCountdown(): void {
  lobbyState = 'starting'
  let remaining = TOURNAMENT_START_DELAY
  const tick = (): void => {
    const msg = { type: 'countdown' as const, secondsRemaining: remaining, agentCount: hub.agentCount }
    spectator.broadcast(msg)
    if (remaining-- > 0) setTimeout(tick, 1000)
    else startTournament()
  }
  tick()
}

function startTournament(): void {
  if (lobbyState !== 'starting') return
  lobbyState      = 'in_progress'
  tournamentAbort = false

  const config: TournamentConfig = {
    players:        hub.getConnectedAgents(),
    startingStack:  STARTING_STACK,
    blindLevels:    BLIND_LEVELS,
    tableSizes:     TABLE_SIZE,
    actionTimeoutMs: ACTION_TIMEOUT,
  }

  orchestrator.runTournament(config).catch(console.error)
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const dashboardHtml = readFileSync(join(__dirname, '../../dashboard/index.html'), 'utf-8')

const handleHttp = createHttpHandler({
  dashboardHtml,
  adminKey:    ADMIN_KEY,
  minPlayers:  MIN_PLAYERS,
  developerMode: DEVELOPER_MODE,
  hub,
  spectator,
  getLobbyState:       () => lobbyState,
  setLobbyState:       (s) => { lobbyState = s },
  setAbort:            (v) => { tournamentAbort = v },
  onTriggerCountdown:  triggerCountdown,
  onForceBounty:       () => orchestrator.forceNextBounty(),
})

const httpServer = createServer(handleHttp)

httpServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname === '/spectate') {
    spectator.wss.handleUpgrade(req, socket, head, (ws) => {
      spectator.wss.emit('connection', ws, req)
    })
    return
  }
  // Agent WebSocket — gate on lobby state
  if (lobbyState === 'open' || lobbyState === 'starting' || lobbyState === 'in_progress') {
    hub.handleUpgrade(req, socket, head)
  } else {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    socket.destroy()
  }
})

httpServer.listen(PORT, () => {
  console.log(`\nPoker server on port ${PORT}`)
  const delayNote = SPECTATOR_DELAY_MS > 0 ? ` (${SPECTATOR_DELAY_MS / 1000}s delay)` : ''
  console.log(`  Dashboard (with cards): http://localhost:${PORT}/?key=${SPECTATOR_KEY}${delayNote}`)
  console.log(`  Dashboard (public):     http://localhost:${PORT}/${delayNote}`)
  console.log(`  Admin panel:  http://localhost:${PORT}/admin?key=${ADMIN_KEY}`)
  console.log(`  Agent WS:     ws://localhost:${PORT}`)
  console.log(`  Spectator WS: ws://localhost:${PORT}/spectate`)
  if (!process.env.ADMIN_KEY) {
    console.log(`\n  ⚠  ADMIN_KEY not set — using generated key above. Set ADMIN_KEY in .env to make it permanent.\n`)
  }
  console.log(`\nLobby is closed. Open it from the admin panel when ready.\n`)
})
