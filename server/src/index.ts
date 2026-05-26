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

const AGENT_PORT       = parseInt(process.env.AGENT_PORT       ?? '3000')
const SPECTATOR_PORT   = parseInt(process.env.SPECTATOR_PORT   ?? '3001')
const MIN_PLAYERS      = parseInt(process.env.MIN_PLAYERS      ?? '2')
const MAX_PLAYERS      = parseInt(process.env.MAX_PLAYERS      ?? '8')
const STARTING_STACK   = parseInt(process.env.STARTING_STACK   ?? '1000')
const ACTION_TIMEOUT   = parseInt(process.env.ACTION_TIMEOUT   ?? '5000')
const TABLE_SIZE       = parseInt(process.env.TABLE_SIZE       ?? '6')

const BLIND_LEVELS: TournamentConfig['blindLevels'] = [
  { smallBlind: 10,  bigBlind: 20,  handsPerLevel: 10 },
  { smallBlind: 25,  bigBlind: 50,  handsPerLevel: 10 },
  { smallBlind: 50,  bigBlind: 100, handsPerLevel: 10 },
  { smallBlind: 100, bigBlind: 200, handsPerLevel: 10 },
  { smallBlind: 200, bigBlind: 400, handsPerLevel: 999 },
]

// ── Spectator server ─────────────────────────────────────────────────────────

const spectators = new Set<WebSocket>()

const dashboardHtml = readFileSync(
  join(__dirname, '../../../dashboard/index.html'),
  'utf-8'
)

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(dashboardHtml)
})

const spectatorWss = new WebSocketServer({ server: httpServer })
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

// ── Agent hub ────────────────────────────────────────────────────────────────

const hub = new WebSocketHub({
  port: AGENT_PORT,
  actionTimeoutMs: ACTION_TIMEOUT,
  onAgentConnect: (agent) => {
    console.log(`[+] ${agent.name} (${agent.id}) connected  (${hub.agentCount} total)`)
    if (hub.agentCount >= MIN_PLAYERS) maybeStart()
  },
  onAgentDisconnect: (id) => console.log(`[-] ${id} disconnected`),
})

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Tournament ───────────────────────────────────────────────────────────────

let started = false

function maybeStart(): void {
  if (started) return
  if (hub.agentCount < MIN_PLAYERS) return
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

async function runTournament(config: TournamentConfig): Promise<void> {
  const tournament = new Tournament(config)
  tournament.seatTables()

  let handNumber = 0

  while (!tournament.isFinished()) {
    // Play one hand on each active table concurrently
    const tables = [...tournament['tables'].keys()]
    await Promise.all(tables.map(tableId => playHand(tournament, tableId, ++handNumber)))

    // Rebalance: remove empty tables and redistribute players
    rebalanceTables(tournament)

    broadcastStandings(tournament, handNumber)
  }

  const winner = tournament.standings[0]
  console.log(`\n🏆 Tournament over! Winner: ${winner.name} (${winner.id}) with ${winner.stack} chips`)
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

// ── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(SPECTATOR_PORT, () => {
  console.log(`Dashboard: http://localhost:${SPECTATOR_PORT}`)
  console.log(`Spectator WS: ws://localhost:${SPECTATOR_PORT}`)
})

console.log(`Agent WS: ws://localhost:${AGENT_PORT}`)
console.log(`Waiting for ${MIN_PLAYERS}–${MAX_PLAYERS} agents to connect...\n`)
