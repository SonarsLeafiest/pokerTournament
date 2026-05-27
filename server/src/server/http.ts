import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { WebSocketHub } from './websocket.js'
import type { SpectatorState } from './spectator.js'

function checkAdminKey(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const maxLen = Math.max(provided.length, expected.length)
  const a = Buffer.from(provided.padEnd(maxLen).slice(0, maxLen))
  const b = Buffer.from(expected.padEnd(maxLen).slice(0, maxLen))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b) && provided.length === expected.length
}

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEV_SECTION_HTML = `
  <div class="section">
    <h2>Developer Mode</h2>
    <button class="btn-danger" onclick="resetTournament()">↺ RESET TOURNAMENT</button>
    <p class="status" id="reset-status"></p>
  </div>`

const DEV_SCRIPT = `
    async function resetTournament() {
      if (!confirm('Reset the tournament? All agents will be disconnected.')) return
      const r = await fetch('/api/reset?key=' + KEY, { method: 'POST' })
      const status = document.getElementById('reset-status')
      status.textContent = r.ok ? 'Reset! Open the lobby when ready.' : 'Error: ' + await r.text()
      status.className = 'status ' + (r.ok ? 'ok' : 'err')
    }`

export type LobbyState = 'closed' | 'open' | 'starting' | 'in_progress'

export interface HttpHandlerOptions {
  dashboardHtml:   string
  adminKey:        string
  minPlayers:      number
  developerMode:   boolean
  hub:             WebSocketHub
  spectator:       SpectatorState
  getLobbyState:   () => LobbyState
  setLobbyState:   (s: LobbyState) => void
  setAbort:        (v: boolean) => void
  onTriggerCountdown: () => void
}

/** Loads and stamps the admin HTML template with runtime values. */
export function loadAdminHtml(minPlayers: number, developerMode: boolean): string {
  const template = readFileSync(join(__dirname, '../admin/index.html'), 'utf-8')
  return template
    .replace(/__MIN_PLAYERS__/g, String(minPlayers))
    .replace('__DEV_SECTION__', developerMode ? DEV_SECTION_HTML : '')
    .replace('__DEV_SCRIPT__',  developerMode ? DEV_SCRIPT       : '')
}

/** Returns the HTTP request handler. All mutable state is accessed via closures. */
export function createHttpHandler(opts: HttpHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const {
    dashboardHtml, adminKey, minPlayers, developerMode,
    hub, spectator, getLobbyState, setLobbyState, setAbort, onTriggerCountdown,
  } = opts

  const adminHtml = loadAdminHtml(minPlayers, developerMode)

  return function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://localhost`)

    // Admin panel
    if (url.pathname === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(adminHtml)
      return
    }

    // Agent list + lobby state (polled by admin panel)
    if (url.pathname === '/api/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        agents:     hub.getConnectedAgents(),
        count:      hub.agentCount,
        lobbyState: getLobbyState(),
        minPlayers,
      }))
      return
    }

    // Open lobby
    if (url.pathname === '/api/open' && req.method === 'POST') {
      if (!checkAdminKey(url.searchParams.get('key'), adminKey)) { res.writeHead(401); res.end('Unauthorized'); return }
      if (getLobbyState() === 'in_progress') { res.writeHead(409); res.end('Tournament is in progress'); return }
      setLobbyState('open')
      console.log('\nLobby opened — agents may now connect\n')
      spectator.broadcast({ type: 'lobby_snapshot', agents: hub.getConnectedAgents() })
      res.writeHead(200); res.end('OK')
      return
    }

    // Close lobby
    if (url.pathname === '/api/close' && req.method === 'POST') {
      if (!checkAdminKey(url.searchParams.get('key'), adminKey)) { res.writeHead(401); res.end('Unauthorized'); return }
      setLobbyState('closed')
      spectator.resetBuffers()
      hub.disconnectAll()
      console.log('\nLobby closed — all agents disconnected\n')
      res.writeHead(200); res.end('OK')
      return
    }

    // Reset tournament (developer mode only)
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (!developerMode)                                         { res.writeHead(404); res.end('Not found'); return }
      if (url.searchParams.get('key') !== adminKey)               { res.writeHead(401); res.end('Unauthorized'); return }
      setAbort(true)
      setLobbyState('closed')
      hub.disconnectAll()
      console.log('\n[DEV] Tournament reset by admin\n')
      res.writeHead(200); res.end('Reset')
      return
    }

    // Start tournament
    if (url.pathname === '/api/start' && req.method === 'POST') {
      if (!checkAdminKey(url.searchParams.get('key'), adminKey)) { res.writeHead(401); res.end('Unauthorized'); return }
      if (getLobbyState() === 'in_progress') { res.writeHead(409); res.end('Tournament already in progress'); return }
      if (getLobbyState() === 'starting')    { res.writeHead(409); res.end('Countdown already in progress'); return }
      if (getLobbyState() === 'closed')      { res.writeHead(409); res.end('Lobby is closed — open it first'); return }
      if (hub.agentCount < minPlayers) {
        res.writeHead(400); res.end(`Not enough players (need ${minPlayers}, have ${hub.agentCount})`); return
      }
      onTriggerCountdown()
      res.writeHead(200); res.end('OK')
      return
    }

    // Default: spectator dashboard
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(dashboardHtml)
  }
}
