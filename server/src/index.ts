import 'dotenv/config'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, type WebSocket } from 'ws'
import { Tournament } from './engine/tournament.js'
import type { ActionRequestor, TournamentConfig } from './engine/tournament.js'
import { WebSocketHub } from './server/websocket.js'
import { ActionType, type GameState } from './engine/game.js'
import type { ActionRequiredMsg, AgentActionMsg, CountdownMsg, TournamentUpdateMsg, HandResultMsg, TableStateMsg, TournamentEndMsg, TournamentCompleteMsg, LobbySnapshotMsg } from './server/protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000')
const MIN_PLAYERS = parseInt(process.env.MIN_PLAYERS ?? '2')
const STARTING_STACK = parseInt(process.env.STARTING_STACK ?? '1000')
const ACTION_TIMEOUT = parseInt(process.env.ACTION_TIMEOUT ?? '5000')
const TABLE_SIZE = parseInt(process.env.TABLE_SIZE ?? '6')
const TOURNAMENT_START_DELAY = parseInt(process.env.TOURNAMENT_START_DELAY ?? '10')
const TURN_DELAY_MS = parseInt(process.env.TURN_DELAY_MS ?? '1500')
const DEVELOPER_MODE = process.env.DEVELOPER_MODE === 'true'

// Generate a random key at startup if ADMIN_KEY is not set
const ADMIN_KEY = process.env.ADMIN_KEY ?? Math.random().toString(36).slice(2).toUpperCase()

const BLIND_LEVELS: TournamentConfig['blindLevels'] = [
  { smallBlind: 10, bigBlind: 20, handsPerLevel: 10 },
  { smallBlind: 25, bigBlind: 50, handsPerLevel: 10 },
  { smallBlind: 50, bigBlind: 100, handsPerLevel: 10 },
  { smallBlind: 100, bigBlind: 200, handsPerLevel: 10 },
  { smallBlind: 200, bigBlind: 400, handsPerLevel: 999 },
]

// ── Static HTML ───────────────────────────────────────────────────────────────

const dashboardHtml = readFileSync(join(__dirname, '../../dashboard/index.html'), 'utf-8')

const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Tournament Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: monospace; background: #0a0a0a; color: #e0e0e0; padding: 32px; max-width: 640px; margin: 0 auto; }
    h1 { color: #f0c040; margin-bottom: 8px; font-size: 1.3rem; letter-spacing: 2px; }
    .sub { color: #555; font-size: 0.75rem; margin-bottom: 32px; }
    .section { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
    h2 { color: #888; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .count { font-size: 2rem; font-weight: bold; color: #f0c040; }
    .count span { font-size: 0.9rem; color: #555; }
    ul { list-style: none; }
    li { padding: 4px 0; font-size: 0.85rem; border-bottom: 1px solid #1e1e1e; color: #ccc; }
    li:last-child { border-bottom: none; }
    .empty { color: #444; font-style: italic; font-size: 0.85rem; }
    button { background: #f0c040; color: #000; border: none; border-radius: 4px; padding: 12px 28px;
             font-size: 1rem; font-family: monospace; font-weight: bold; cursor: pointer; letter-spacing: 1px; }
    button:hover { background: #ffd060; }
    button:disabled { background: #333; color: #555; cursor: default; }
    .btn-secondary { background: #444; color: #ddd; }
    .btn-secondary:hover { background: #555; }
    .btn-danger { background: #8b1a1a; color: #fff; }
    .btn-danger:hover { background: #a02020; }
    .status { font-size: 0.85rem; color: #888; margin-top: 8px; min-height: 20px; }
    .status.ok { color: #4c4; }
    .status.err { color: #c44; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 10px; font-size: 0.75rem; font-weight: bold; letter-spacing: 1px; margin-bottom: 12px; }
    .badge-closed { background: #2a2a2a; color: #666; }
    .badge-open { background: #0d2b0d; color: #4c4; }
    .badge-progress { background: #2b2000; color: #f0c040; }
    .countdown { font-size: 3rem; font-weight: bold; color: #f0c040; text-align: center; padding: 16px 0; display: none; }
    .need { font-size: 0.8rem; color: #666; margin-top: 6px; }
    .hint { font-size: 0.85rem; color: #555; margin-bottom: 16px; }
    .btn-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  </style>
</head>
<body>
  <h1>♠ TOURNAMENT ADMIN</h1>
  <p class="sub">Refreshes every second.</p>

  <!-- Closed panel -->
  <div id="panel-closed" style="display:none">
    <div class="section">
      <h2>Lobby Status</h2>
      <span class="badge badge-closed">● CLOSED</span>
      <p class="hint">Open the lobby so agents can connect, then start the tournament when ready.</p>
      <button onclick="openLobby()">▶ OPEN LOBBY</button>
      <p class="status" id="open-status"></p>
    </div>
  </div>

  <!-- Open panel -->
  <div id="panel-open" style="display:none">
    <div class="section">
      <h2>Connected Agents</h2>
      <p class="count" id="count">0 <span>/ need ${MIN_PLAYERS} to start</span></p>
      <ul id="agentList"><li class="empty">none yet</li></ul>
    </div>
    <div class="section">
      <h2>Controls</h2>
      <span class="badge badge-open">● LOBBY OPEN</span>
      <div class="countdown" id="countdown"></div>
      <div class="btn-row">
        <button id="startBtn" disabled onclick="startTournament()">▶ START TOURNAMENT</button>
        <button class="btn-secondary" onclick="closeLobby()">✕ CLOSE LOBBY</button>
      </div>
      <p class="status" id="status"></p>
      <p class="need" id="need"></p>
    </div>
  </div>

  <!-- In-progress panel -->
  <div id="panel-inprogress" style="display:none">
    <div class="section">
      <h2>Lobby Status</h2>
      <span class="badge badge-progress">● IN PROGRESS</span>
      <p class="hint">Tournament is running. Disconnected agents may reconnect.</p>
    </div>
  </div>

  ${DEVELOPER_MODE ? `
  <div class="section">
    <h2>Developer Mode</h2>
    <button class="btn-danger" onclick="resetTournament()">↺ RESET TOURNAMENT</button>
    <p class="status" id="reset-status"></p>
  </div>` : ''}

  <script>
    const KEY = new URLSearchParams(location.search).get('key') || ''

    function showPanel(state) {
      document.getElementById('panel-closed').style.display     = state === 'closed'      ? '' : 'none'
      document.getElementById('panel-open').style.display       = state === 'open'        ? '' : 'none'
      document.getElementById('panel-inprogress').style.display = state === 'in_progress' ? '' : 'none'
    }

    async function refresh() {
      try {
        const r = await fetch('/api/agents')
        const data = await r.json()
        showPanel(data.lobbyState)

        if (data.lobbyState === 'open') {
          document.getElementById('count').innerHTML =
            data.count + ' <span>/ need ${MIN_PLAYERS} to start</span>'
          const list = document.getElementById('agentList')
          if (data.agents.length === 0) {
            list.innerHTML = '<li class="empty">none yet</li>'
          } else {
            list.innerHTML = data.agents.map(a =>
              '<li>● ' + a.name + ' <span style="color:#555">(' + a.id + ')</span></li>'
            ).join('')
          }
          const btn  = document.getElementById('startBtn')
          const need = document.getElementById('need')
          btn.disabled = data.count < ${MIN_PLAYERS}
          need.textContent = data.count < ${MIN_PLAYERS}
            ? 'Need ' + (${MIN_PLAYERS} - data.count) + ' more agent(s) to enable start'
            : ''
        }
      } catch (e) {
        showPanel('closed')
      }
    }

    async function openLobby() {
      const r = await fetch('/api/open?key=' + KEY, { method: 'POST' })
      const el = document.getElementById('open-status')
      if (r.ok) {
        el.textContent = 'Lobby opened!'
        el.className = 'status ok'
        refresh()
      } else {
        el.textContent = 'Error: ' + await r.text()
        el.className = 'status err'
      }
    }

    async function closeLobby() {
      if (!confirm('Close the lobby? All connected agents will be disconnected.')) return
      const r = await fetch('/api/close?key=' + KEY, { method: 'POST' })
      if (!r.ok) {
        document.getElementById('status').textContent = 'Error: ' + await r.text()
        document.getElementById('status').className = 'status err'
      }
    }

    async function startTournament() {
      const btn = document.getElementById('startBtn')
      btn.disabled = true
      document.getElementById('status').textContent = 'Starting countdown...'
      try {
        const r = await fetch('/api/start?key=' + KEY, { method: 'POST' })
        if (!r.ok) {
          document.getElementById('status').textContent = 'Error: ' + await r.text()
          document.getElementById('status').className = 'status err'
          btn.disabled = false
        } else {
          document.getElementById('status').textContent = 'Countdown started!'
          document.getElementById('status').className = 'status ok'
        }
      } catch (e) {
        document.getElementById('status').textContent = 'Request failed'
        document.getElementById('status').className = 'status err'
        btn.disabled = false
      }
    }

    // Show countdown via spectator WebSocket (reconnects automatically)
    function connectAdminWs() {
      const wsUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/spectate'
      const ws = new WebSocket(wsUrl)
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'countdown') {
          const el = document.getElementById('countdown')
          if (el) {
            el.style.display = 'block'
            el.textContent = msg.secondsRemaining > 0 ? msg.secondsRemaining + 's' : 'GO!'
            if (msg.secondsRemaining <= 0) setTimeout(() => { el.style.display = 'none' }, 2000)
          }
        }
      }
      ws.onclose = () => setTimeout(connectAdminWs, 2000)
      ws.onerror = () => ws.close()
    }
    connectAdminWs()

    setInterval(refresh, 1000)
    refresh()

    ${DEVELOPER_MODE ? `
    async function resetTournament() {
      if (!confirm('Reset the tournament? All agents will be disconnected.')) return
      const r = await fetch('/api/reset?key=' + KEY, { method: 'POST' })
      const status = document.getElementById('reset-status')
      status.textContent = r.ok ? 'Reset! Open the lobby when ready.' : 'Error: ' + await r.text()
      status.className = 'status ' + (r.ok ? 'ok' : 'err')
    }` : ''}
  </script>
</body>
</html>`

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ── Spectator WebSocket (/spectate) ───────────────────────────────────────────

const spectators = new Set<WebSocket>()
const spectatorWss = new WebSocketServer({ noServer: true })

// Buffers for catch-up replay when a spectator connects mid-tournament
let spectatorLastStandings: TournamentUpdateMsg | null = null
let spectatorLastTableState: TableStateMsg | null = null
let spectatorLastCountdown: CountdownMsg | null = null
let spectatorLastLobbySnapshot: LobbySnapshotMsg | null = null
let spectatorLastTournamentComplete: TournamentCompleteMsg | null = null
const spectatorHandHistory: HandResultMsg[] = []
const MAX_HAND_HISTORY = 200

spectatorWss.on('connection', (ws) => {
  spectators.add(ws)
  // Replay buffered state so late-joiners and refreshes see current game
  if (spectatorLastLobbySnapshot) ws.send(JSON.stringify(spectatorLastLobbySnapshot))
  if (spectatorLastCountdown) ws.send(JSON.stringify(spectatorLastCountdown))
  if (spectatorLastStandings) ws.send(JSON.stringify(spectatorLastStandings))
  for (const h of spectatorHandHistory) ws.send(JSON.stringify(h))
  if (spectatorLastTableState) ws.send(JSON.stringify(spectatorLastTableState))
  if (spectatorLastTournamentComplete) ws.send(JSON.stringify(spectatorLastTournamentComplete))
  ws.on('close', () => spectators.delete(ws))
})

function broadcastToSpectators(msg: TournamentUpdateMsg | HandResultMsg | CountdownMsg | TableStateMsg | TournamentEndMsg | TournamentCompleteMsg | LobbySnapshotMsg): void {
  if (msg.type === 'tournament_update')  spectatorLastStandings    = msg
  else if (msg.type === 'table_state')   spectatorLastTableState   = msg
  else if (msg.type === 'lobby_snapshot') spectatorLastLobbySnapshot = msg
  else if (msg.type === 'tournament_complete') spectatorLastTournamentComplete = msg
  else if (msg.type === 'countdown') {
    spectatorLastCountdown = msg.secondsRemaining > 0 ? msg : null
  } else if (msg.type === 'hand_result') {
    spectatorHandHistory.push(msg)
    if (spectatorHandHistory.length > MAX_HAND_HISTORY) spectatorHandHistory.shift()
  }
  const raw = JSON.stringify(msg)
  for (const ws of spectators) {
    if (ws.readyState === ws.OPEN) ws.send(raw)
  }
}

function broadcastTableState(
  tableId: string,
  handNumber: number,
  state: GameState,
  actingPlayerId: string,
  lastActions: Map<string, string>,
): void {
  const msg: TableStateMsg = {
    type: 'table_state',
    tableId,
    handNumber,
    stage: state.stage,
    players: state.players.map((p, i) => ({
      id: p.id,
      stack: p.stack,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      isActing: p.id === actingPlayerId,
      isDealer: i === state.dealerIndex,
      connected: hub.isAgentConnected(p.id),
      holeCards: p.holeCards,
      lastAction: lastActions.get(p.id),
    })),
    communityCards: state.communityCards,
    pot: state.pot,
    dealerIndex: state.dealerIndex,
  }
  broadcastToSpectators(msg)
}

// ── Agent WebSocket (all other paths) ────────────────────────────────────────

// Last action_required sent per player — re-sent on reconnect so the game resumes
const pendingActionMsgs = new Map<string, ActionRequiredMsg>()

function broadcastTableConnected(playerId: string, connected: boolean): void {
  if (!spectatorLastTableState) return
  const updated: TableStateMsg = {
    ...spectatorLastTableState,
    players: spectatorLastTableState.players.map(p =>
      p.id === playerId ? { ...p, connected } : p
    ),
  }
  spectatorLastTableState = updated
  const raw = JSON.stringify(updated)
  for (const ws of spectators) {
    if (ws.readyState === ws.OPEN) ws.send(raw)
  }
}

const hub = new WebSocketHub({
  noServer: true,
  actionTimeoutMs: ACTION_TIMEOUT,
  onAgentConnect: (agent) => {
    console.log(`[+] ${agent.name} (${agent.id}) connected  (${hub.agentCount} agents total)`)
    broadcastLobbySnapshot()
  },
  onAgentDisconnect: (id) => {
    console.log(`[-] ${id} disconnected — game paused until reconnect or admin reset`)
    broadcastTableConnected(id, false)
    broadcastLobbySnapshot()
  },
  onAgentReconnect: (agent) => {
    console.log(`[~] ${agent.name} (${agent.id}) reconnected`)
    broadcastTableConnected(agent.id, true)
    broadcastLobbySnapshot()
    const pending = pendingActionMsgs.get(agent.id)
    if (pending) hub.sendToAgent(agent.id, pending)
  },
})

function broadcastLobbySnapshot(): void {
  if (lobbyState !== 'open') return
  broadcastToSpectators({ type: 'lobby_snapshot', agents: hub.getConnectedAgents() })
}

// ── Lobby state ───────────────────────────────────────────────────────────────

type LobbyState = 'closed' | 'open' | 'in_progress'
let lobbyState: LobbyState = 'closed'
let tournamentAbort = false

// ── HTTP routing ──────────────────────────────────────────────────────────────

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://localhost`)

  // Admin panel
  if (url.pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(adminHtml)
    return
  }

  // Agent list API (polled by admin panel)
  if (url.pathname === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      agents: hub.getConnectedAgentIds().map(id => ({ id, name: id })),
      count: hub.agentCount,
      lobbyState,
      minPlayers: MIN_PLAYERS,
    }))
    return
  }

  // Open lobby
  if (url.pathname === '/api/open' && req.method === 'POST') {
    if (url.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(401); res.end('Unauthorized'); return }
    if (lobbyState === 'in_progress') { res.writeHead(409); res.end('Tournament is in progress'); return }
    lobbyState = 'open'
    console.log('\nLobby opened — agents may now connect\n')
    broadcastLobbySnapshot()
    res.writeHead(200); res.end('OK')
    return
  }

  // Close lobby
  if (url.pathname === '/api/close' && req.method === 'POST') {
    if (url.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(401); res.end('Unauthorized'); return }
    lobbyState = 'closed'
    spectatorLastLobbySnapshot = null
    hub.disconnectAll()
    console.log('\nLobby closed — all agents disconnected\n')
    res.writeHead(200); res.end('OK')
    return
  }

  // Reset tournament (developer mode only)
  if (url.pathname === '/api/reset' && req.method === 'POST') {
    if (!DEVELOPER_MODE) { res.writeHead(404); res.end('Not found'); return }
    if (url.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(401); res.end('Unauthorized'); return }
    tournamentAbort = true
    lobbyState = 'closed'
    hub.disconnectAll()
    console.log('\n[DEV] Tournament reset by admin\n')
    res.writeHead(200)
    res.end('Reset')
    return
  }

  // Start tournament (admin POST)
  if (url.pathname === '/api/start' && req.method === 'POST') {
    if (url.searchParams.get('key') !== ADMIN_KEY) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    if (lobbyState === 'in_progress') {
      res.writeHead(409)
      res.end('Tournament already in progress')
      return
    }
    if (lobbyState === 'closed') {
      res.writeHead(409)
      res.end('Lobby is closed — open it first')
      return
    }
    if (hub.agentCount < MIN_PLAYERS) {
      res.writeHead(400)
      res.end(`Not enough players (need ${MIN_PLAYERS}, have ${hub.agentCount})`)
      return
    }
    triggerCountdown()
    res.writeHead(200)
    res.end('OK')
    return
  }

  // Default: spectator dashboard
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(dashboardHtml)
}

const httpServer = createServer(handleHttp)

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/spectate') {
    spectatorWss.handleUpgrade(req, socket, head, (ws) => {
      spectatorWss.emit('connection', ws, req)
    })
  } else if (lobbyState === 'open' || lobbyState === 'in_progress') {
    hub.handleUpgrade(req, socket, head)
  } else {
    socket.write('HTTP/1.1 503 Lobby Closed\r\n\r\n')
    socket.destroy()
  }
})

// ── Countdown & start ─────────────────────────────────────────────────────────

function triggerCountdown(): void {
  let remaining = TOURNAMENT_START_DELAY

  const broadcastCountdown = (s: number) => {
    const msg: CountdownMsg = { type: 'countdown', secondsRemaining: s, agentCount: hub.agentCount }
    broadcastToSpectators(msg)
    hub.broadcast(msg)
  }

  console.log(`\nCountdown started: ${remaining}s until tournament begins\n`)
  broadcastCountdown(remaining)

  const tick = setInterval(() => {
    remaining--
    broadcastCountdown(remaining)
    if (remaining <= 0) {
      clearInterval(tick)
      startTournament()
    }
  }, 1000)
}

function startTournament(): void {
  if (lobbyState !== 'open') return
  lobbyState = 'in_progress'

  const agentIds = hub.getConnectedAgentIds()
  console.log(`\nStarting tournament with ${agentIds.length} agents across ${Math.ceil(agentIds.length / TABLE_SIZE)} table(s): ${agentIds.join(', ')}\n`)

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
  tournamentAbort = false
  spectatorLastStandings          = null
  spectatorLastTableState         = null
  spectatorLastLobbySnapshot      = null
  spectatorLastCountdown          = null
  spectatorLastTournamentComplete = null
  spectatorHandHistory.length = 0
  const tournament = new Tournament(config)
  tournament.seatTables()

  let handNumber = 0

  while (!tournament.isFinished() && !tournamentAbort) {
    const tables = [...(tournament as any).tables.keys()] as string[]
    await Promise.all(tables.map(tableId => playHand(tournament, tableId, ++handNumber)))

    rebalanceTables(tournament)
    broadcastStandings(tournament, handNumber)
  }

  if (tournamentAbort) {
    console.log('\nTournament aborted — ready for reset')
    return
  }

  const standings = tournament.standings
  const winner = standings[0]
  console.log(`\nTournament over! Winner: ${winner.name} (${winner.id}) with ${winner.stack} chips`)

  // Notify each agent of their final placement
  for (const [i, player] of standings.entries()) {
    const endMsg: TournamentEndMsg = {
      type: 'tournament_end',
      place: i + 1,
      result: i === 0 ? 'won' : 'lost',
      finalStack: player.stack,
    }
    hub.sendToAgent(player.id, endMsg)
  }

  // Broadcast final result to spectators
  const completeMsg: TournamentCompleteMsg = {
    type: 'tournament_complete',
    winnerId:   winner.id,
    winnerName: winner.name,
    finalStack: winner.stack,
    standings:  standings.map((p, i) => ({
      playerId: p.id,
      name:     p.name,
      place:    i + 1,
      stack:    p.stack,
    })),
  }
  broadcastToSpectators(completeMsg)

  await sleep(2000)
  hub.disconnectAll()
  lobbyState = 'closed'
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
  const lastActions = new Map<string, string>()

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

    broadcastTableState(tId, handNumber, state, playerId, lastActions)
    if (!tournamentAbort) await sleep(TURN_DELAY_MS)

    pendingActionMsgs.set(playerId, msg)
    hub.sendToAgent(playerId, msg)

    const response = await hub.waitForAction(playerId) as AgentActionMsg
    pendingActionMsgs.delete(playerId)
    const action = response.action ?? ActionType.FOLD
    const amount = response.amount

    if (!validActions.includes(action as ActionType)) {
      hub.sendToAgent(playerId, { type: 'error', message: `Invalid action: ${action}` })
      lastActions.set(playerId, ActionType.FOLD)
      return { type: ActionType.FOLD }
    }

    lastActions.set(playerId,
      action === ActionType.RAISE && amount != null ? `${action} ${amount}` : action)

    return { type: action as ActionType, amount }
  }

  const stacksBefore = new Map(tournament.standings.map(p => [p.id, p.stack]))
  const winners = await tournament.playHand(tableId, requestAction)
  const stacksAfter = new Map(tournament.standings.map(p => [p.id, p.stack]))

  const deltas: Record<string, number> = {}
  for (const [id, before] of stacksBefore) {
    const after = stacksAfter.get(id) ?? before
    if (after !== before) deltas[id] = after - before
  }

  const resultMsg: HandResultMsg = {
    type: 'hand_result',
    gameId: tableId,
    handNumber,
    winners: winners.map(w => ({ playerId: w.playerId, amount: w.amount })),
    showdown: [],
    deltas,
  }
  broadcastToSpectators(resultMsg)
  hub.broadcast(resultMsg)
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
  broadcastToSpectators(msg)
  console.log(`Hand ${handNumber} | ${tournament.activePlayers.length} players remaining | Blinds ${msg.smallBlind}/${msg.bigBlind}`)
}

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\nPoker server on port ${PORT}`)
  console.log(`  Dashboard:    http://localhost:${PORT}`)
  console.log(`  Admin panel:  http://localhost:${PORT}/admin?key=${ADMIN_KEY}`)
  console.log(`  Agent WS:     ws://localhost:${PORT}`)
  console.log(`  Spectator WS: ws://localhost:${PORT}/spectate`)
  if (!process.env.ADMIN_KEY) {
    console.log(`\n  ⚠  ADMIN_KEY not set — using generated key above. Set ADMIN_KEY in .env to make it permanent.\n`)
  }
  console.log(`\nLobby is closed. Open it from the admin panel when ready.\n`)
})
