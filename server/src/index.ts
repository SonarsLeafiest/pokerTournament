import { createServer } from 'http'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, type WebSocket } from 'ws'
import { Tournament } from './engine/tournament.js'
import type { ActionRequestor, TournamentConfig } from './engine/tournament.js'
import { WebSocketHub } from './server/websocket.js'
import { ActionType, type GameState } from './engine/game.js'
import type { ActionRequiredMsg, AgentActionMsg, TournamentUpdateMsg, HandResultMsg } from './server/protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ───────────────────────────────────────────────────────────────────

const PORT                   = parseInt(process.env.PORT                    ?? '3000')
const MIN_PLAYERS            = parseInt(process.env.MIN_PLAYERS             ?? '2')
const MAX_PLAYERS            = parseInt(process.env.MAX_PLAYERS             ?? '8')
const STARTING_STACK         = parseInt(process.env.STARTING_STACK          ?? '1000')
const ACTION_TIMEOUT         = parseInt(process.env.ACTION_TIMEOUT          ?? '5000')
const TABLE_SIZE             = parseInt(process.env.TABLE_SIZE              ?? '6')
const TOURNAMENT_START_DELAY = parseInt(process.env.TOURNAMENT_START_DELAY  ?? '30')

const BLIND_LEVELS: TournamentConfig['blindLevels'] = [
  { smallBlind: 10,  bigBlind: 20,  handsPerLevel: 10 },
  { smallBlind: 25,  bigBlind: 50,  handsPerLevel: 10 },
  { smallBlind: 50,  bigBlind: 100, handsPerLevel: 10 },
  { smallBlind: 100, bigBlind: 200, handsPerLevel: 10 },
  { smallBlind: 200, bigBlind: 400, handsPerLevel: 999 },
]

// ── HTTP server (serves dashboard + routes WebSocket upgrades) ───────────────

const dashboardHtml = readFileSync(
  join(__dirname, '../../../dashboard/index.html'),
  'utf-8'
)

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(dashboardHtml)
})

// ── Spectator WebSocket (/spectate) ──────────────────────────────────────────

const spectators = new Set<WebSocket>()
const spectatorWss = new WebSocketServer({ noServer: true })

spectatorWss.on('connection', (ws) => {
  spectators.add(ws)
  ws.on('close', () => spectators.delete(ws))
})

function broadcast(msg: TournamentUpdateMsg | HandResultMsg): void {
  const raw = JSON.stringify(msg)
  for (const ws of spectators) {
    if (ws.readyState === ws.OPEN) ws.send(raw)
  }
}

// ── Agent WebSocket (all other paths) ────────────────────────────────────────

const hub = new WebSocketHub({
  noServer: true,
  actionTimeoutMs: ACTION_TIMEOUT,
  onAgentConnect: (agent) => {
    console.log(`[+] ${agent.name} (${agent.id}) connected  (${hub.agentCount}/${MAX_PLAYERS})`)
    maybeScheduleStart()
  },
  onAgentDisconnect: (id) => console.log(`[-] ${id} disconnected`),
})

// Route WebSocket upgrades by path
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/spectate') {
    spectatorWss.handleUpgrade(req, socket, head, (ws) => {
      spectatorWss.emit('connection', ws, req)
    })
  } else {
    hub.handleUpgrade(req, socket, head)
  }
})

// ── Tournament start countdown ────────────────────────────────────────────────

let started = false
let countdownTimer: ReturnType<typeof setTimeout> | null = null

function maybeScheduleStart(): void {
  if (started || hub.agentCount < MIN_PLAYERS) return
  if (countdownTimer) return  // already counting down

  console.log(`\n${MIN_PLAYERS} agents connected — starting in ${TOURNAMENT_START_DELAY}s (waiting for more players...)\n`)

  let remaining = TOURNAMENT_START_DELAY
  const tick = setInterval(() => {
    remaining--
    if (hub.agentCount >= MAX_PLAYERS || remaining <= 0) {
      clearInterval(tick)
      countdownTimer = null
      start()
    } else if (remaining % 10 === 0) {
      console.log(`  ${remaining}s until start  (${hub.agentCount} agents connected)`)
    }
  }, 1000)

  countdownTimer = tick
}

function start(): void {
  if (started) return
  started = true

  const agentIds = hub.getConnectedAgentIds().slice(0, MAX_PLAYERS)
  console.log(`\nStarting tournament with ${agentIds.length} agents: ${agentIds.join(', ')}\n`)

  const config: TournamentConfig = {
    players: agentIds.map(id => ({ id, name: id })),
    startingStack: STARTING_STACK,
    blindLevels: BLIND_LEVELS,
    tableSizes: TABLE_SIZE,
    actionTimeoutMs: ACTION_TIMEOUT,
  }

  runTournament(config).catch(console.error)
}

// ── Tournament loop ───────────────────────────────────────────────────────────

async function runTournament(config: TournamentConfig): Promise<void> {
  const tournament = new Tournament(config)
  tournament.seatTables()

  let handNumber = 0

  while (!tournament.isFinished()) {
    const tables = [...(tournament as any).tables.keys()] as string[]
    await Promise.all(tables.map(tableId => playHand(tournament, tableId, ++handNumber)))

    rebalanceTables(tournament)
    broadcastStandings(tournament, handNumber)
  }

  const winner = tournament.standings[0]
  console.log(`\nTournament over! Winner: ${winner.name} (${winner.id}) with ${winner.stack} chips`)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'HJ', 'CO', 'MP']

function labelPosition(dealerIdx: number, playerIdx: number, total: number): string {
  const offset = (playerIdx - dealerIdx + total) % total
  return POSITIONS[offset] ?? `P${offset}`
}

function validActionsFor(state: GameState, playerIdx: number): ActionType[] {
  const p = state.players[playerIdx]
  const actions: ActionType[] = [ActionType.FOLD]
  if (p.bet >= state.currentBet) {
    actions.push(ActionType.CHECK)
  } else {
    actions.push(ActionType.CALL)
  }
  if (p.stack > state.currentBet - p.bet) actions.push(ActionType.RAISE)
  return actions
}

async function playHand(tournament: Tournament, tableId: string, handNumber: number): Promise<void> {
  const requestAction: ActionRequestor = async (tId, playerId, state) => {
    const playerIdx = state.players.findIndex(p => p.id === playerId)
    const player = state.players[playerIdx]
    const validActions = validActionsFor(state, playerIdx)

    const msg: ActionRequiredMsg = {
      type: 'action_required',
      gameId: tId,
      handNumber,
      stage: state.stage,
      position: labelPosition(state.dealerIndex, playerIdx, state.players.length),
      holeCards: player.holeCards as ActionRequiredMsg['holeCards'],
      communityCards: state.communityCards,
      pot: state.pot,
      myStack: player.stack,
      myBet: player.bet,
      currentBet: state.currentBet,
      players: state.players
        .filter(p => p.id !== playerId)
        .map(p => ({ id: p.id, stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn })),
      validActions,
      minRaise: state.currentBet + state.lastRaiseSize,
      maxRaise: player.stack,
      timeLimitMs: ACTION_TIMEOUT,
    }

    hub.sendToAgent(playerId, msg)

    const response = await hub.waitForAction(playerId) as AgentActionMsg
    const action = response.action ?? ActionType.FOLD
    const amount = response.amount

    if (!validActions.includes(action as ActionType)) {
      hub.sendToAgent(playerId, { type: 'error', message: `Invalid action: ${action}` })
      return { type: ActionType.FOLD }
    }

    return { type: action as ActionType, amount }
  }

  await tournament.playHand(tableId, requestAction)
}

function rebalanceTables(tournament: Tournament): void {
  const internalTables: Map<string, { playerIds: string[] }> = (tournament as any).tables
  let hasActiveTables = false
  for (const table of internalTables.values()) {
    const activeSeatCount = table.playerIds.filter(
      (pid: string) => tournament.activePlayers.some(p => p.id === pid)
    ).length
    if (activeSeatCount > 1) hasActiveTables = true
  }
  if (!hasActiveTables && tournament.activePlayers.length > 1) {
    tournament.seatTables()
  }
}

function broadcastStandings(tournament: Tournament, handNumber: number): void {
  const msg: TournamentUpdateMsg = {
    type: 'tournament_update',
    standings: tournament.standings.map(p => ({
      playerId: p.id,
      stack: p.stack,
      eliminated: p.eliminated,
    })),
    blindLevel: (tournament as any).blindLevelIndex + 1,
    smallBlind: tournament.currentBlinds.smallBlind,
    bigBlind: tournament.currentBlinds.bigBlind,
  }
  broadcast(msg)
  console.log(`Hand ${handNumber} | ${tournament.activePlayers.length} players remaining | Blinds ${msg.smallBlind}/${msg.bigBlind}`)
}

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`Poker server listening on port ${PORT}`)
  console.log(`  Dashboard:    http://localhost:${PORT}`)
  console.log(`  Agent WS:     ws://localhost:${PORT}`)
  console.log(`  Spectator WS: ws://localhost:${PORT}/spectate`)
  console.log(`\nWaiting for ${MIN_PLAYERS}–${MAX_PLAYERS} agents...`)
  console.log(`Tournament starts ${TOURNAMENT_START_DELAY}s after MIN_PLAYERS connects\n`)
})
