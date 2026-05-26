import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, type WebSocket } from 'ws'
import { Tournament } from './engine/tournament.js'
import type { ActionRequestor, TournamentConfig } from './engine/tournament.js'
import { WebSocketHub } from './server/websocket.js'
import { ActionType, type GameState } from './engine/game.js'
import type { ActionRequiredMsg, AgentActionMsg, CountdownMsg, TournamentUpdateMsg, HandResultMsg } from './server/protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ───────────────────────────────────────────────────────────────────

const PORT                   = parseInt(process.env.PORT                   ?? '3000')
const MIN_PLAYERS            = parseInt(process.env.MIN_PLAYERS            ?? '2')
const STARTING_STACK         = parseInt(process.env.STARTING_STACK         ?? '1000')
const ACTION_TIMEOUT         = parseInt(process.env.ACTION_TIMEOUT         ?? '5000')
const TABLE_SIZE             = parseInt(process.env.TABLE_SIZE             ?? '6')
const TOURNAMENT_START_DELAY = parseInt(process.env.TOURNAMENT_START_DELAY ?? '10')

// Generate a random key at startup if ADMIN_KEY is not set
const ADMIN_KEY = process.env.ADMIN_KEY ?? Math.random().toString(36).slice(2).toUpperCase()

const BLIND_LEVELS: TournamentConfig['blindLevels'] = [
  { smallBlind: 10,  bigBlind: 20,  handsPerLevel: 10 },
  { smallBlind: 25,  bigBlind: 50,  handsPerLevel: 10 },
  { smallBlind: 50,  bigBlind: 100, handsPerLevel: 10 },
  { smallBlind: 100, bigBlind: 200, handsPerLevel: 10 },
  { smallBlind: 200, bigBlind: 400, handsPerLevel: 999 },
]

// ── Static HTML ───────────────────────────────────────────────────────────────

const dashboardHtml = readFileSync(join(__dirname, '../../../dashboard/index.html'), 'utf-8')

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
    .status { font-size: 0.85rem; color: #888; margin-top: 8px; min-height: 20px; }
    .status.ok { color: #4c4; }
    .status.err { color: #c44; }
    .countdown { font-size: 3rem; font-weight: bold; color: #f0c040; text-align: center; padding: 16px 0; display: none; }
    .need { font-size: 0.8rem; color: #666; margin-top: 6px; }
  </style>
</head>
<body>
  <h1>♠ TOURNAMENT ADMIN</h1>
  <p class="sub">Refresh every second — start when your teams are ready.</p>

  <div class="section">
    <h2>Connected Agents</h2>
    <p class="count" id="count">0 <span>/ need ${MIN_PLAYERS} to start</span></p>
    <ul id="agentList"><li class="empty">none yet</li></ul>
  </div>

  <div class="section">
    <h2>Start Tournament</h2>
    <div class="countdown" id="countdown"></div>
    <button id="startBtn" disabled onclick="startTournament()">▶ START TOURNAMENT</button>
    <p class="status" id="status"></p>
    <p class="need" id="need"></p>
  </div>

  <script>
    const KEY = new URLSearchParams(location.search).get('key') || ''
    let lastCount = 0

    async function refresh() {
      try {
        const r = await fetch('/api/agents')
        const data = await r.json()
        const list = document.getElementById('agentList')
        const btn  = document.getElementById('startBtn')
        const need = document.getElementById('need')

        document.getElementById('count').innerHTML =
          data.count + ' <span>/ need ${MIN_PLAYERS} to start</span>'

        if (data.agents.length === 0) {
          list.innerHTML = '<li class="empty">none yet</li>'
        } else {
          list.innerHTML = data.agents.map(a =>
            '<li>● ' + a.name + ' <span style="color:#555">(' + a.id + ')</span></li>'
          ).join('')
        }

        if (data.started) {
          btn.disabled = true
          document.getElementById('status').textContent = 'Tournament in progress.'
          document.getElementById('status').className = 'status ok'
        } else {
          btn.disabled = data.count < ${MIN_PLAYERS}
          need.textContent = data.count < ${MIN_PLAYERS}
            ? 'Need ' + (${MIN_PLAYERS} - data.count) + ' more agent(s) to enable start'
            : ''
        }
      } catch (e) {
        document.getElementById('status').textContent = 'Connection error'
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
          const msg = await r.text()
          document.getElementById('status').textContent = 'Error: ' + msg
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

    // Show countdown via spectator WebSocket
    const wsUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/spectate'
    const ws = new WebSocket(wsUrl)
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'countdown') {
        const el = document.getElementById('countdown')
        el.style.display = 'block'
        el.textContent = msg.secondsRemaining + 's'
        if (msg.secondsRemaining <= 0) el.textContent = 'GO!'
      }
    }

    setInterval(refresh, 1000)
    refresh()
  </script>
</body>
</html>`

// ── Spectator WebSocket (/spectate) ───────────────────────────────────────────

const spectators = new Set<WebSocket>()
const spectatorWss = new WebSocketServer({ noServer: true })

spectatorWss.on('connection', (ws) => {
  spectators.add(ws)
  ws.on('close', () => spectators.delete(ws))
})

function broadcastToSpectators(msg: TournamentUpdateMsg | HandResultMsg | CountdownMsg): void {
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
    console.log(`[+] ${agent.name} (${agent.id}) connected  (${hub.agentCount} agents total)`)
  },
  onAgentDisconnect: (id) => console.log(`[-] ${id} disconnected`),
})

// ── HTTP routing ──────────────────────────────────────────────────────────────

let tournamentStarted = false

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
      started: tournamentStarted,
      minPlayers: MIN_PLAYERS,
    }))
    return
  }

  // Start tournament (admin POST)
  if (url.pathname === '/api/start' && req.method === 'POST') {
    if (url.searchParams.get('key') !== ADMIN_KEY) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    if (tournamentStarted) {
      res.writeHead(409)
      res.end('Tournament already started')
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
  } else {
    hub.handleUpgrade(req, socket, head)
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
  if (tournamentStarted) return
  tournamentStarted = true

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
  console.log(`\nWaiting for agents to connect. Admin starts the tournament when ready.\n`)
})
