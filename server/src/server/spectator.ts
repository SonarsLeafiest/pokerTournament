import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { checkAdminKey } from './http.js'
import type {
  ServerMessage,
  TournamentUpdateMsg,
  HandResultMsg,
  CountdownMsg,
  TableStateMsg,
  LobbySnapshotMsg,
  TournamentCompleteMsg,
} from './protocol.js'

const MAX_HAND_HISTORY = 200

/**
 * Owns all spectator WebSocket state: the WS server, connected clients,
 * replay buffers, and the broadcast/catch-up logic.
 *
 * Connections that supply the correct admin key via `?key=` receive full
 * hole cards in every table_state message.  Unauthenticated connections
 * see card backs (holeCards: []) so agents can't cheat by subscribing here.
 */
export class SpectatorState {
  readonly wss: WebSocketServer

  private spectators             = new Set<WebSocket>()
  private spectatorAuth          = new Map<WebSocket, boolean>()   // ws → isAdmin
  private lastStandings:          TournamentUpdateMsg   | null = null
  private lastTableStates         = new Map<string, TableStateMsg>()  // tableId → full msg
  private lastCountdown:          CountdownMsg          | null = null
  private lastLobbySnapshot:      LobbySnapshotMsg      | null = null
  private lastTournamentComplete: TournamentCompleteMsg | null = null
  private handHistory:            HandResultMsg[]              = []

  constructor(private readonly adminKey: string) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1_024 })
    this.wss.on('connection', (ws, req) => this._handleConnection(ws, req as IncomingMessage))
  }

  private _handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url    = new URL(req.url ?? '/', 'http://localhost')
    const isAdmin = checkAdminKey(url.searchParams.get('key'), this.adminKey)

    this.spectators.add(ws)
    this.spectatorAuth.set(ws, isAdmin)

    // Replay buffered state in original message order
    if (this.lastLobbySnapshot)      this._send(ws, this.lastLobbySnapshot)
    if (this.lastCountdown)          this._send(ws, this.lastCountdown)
    if (this.lastStandings)          this._send(ws, this.lastStandings)
    for (const h of this.handHistory) this._send(ws, h)
    for (const ts of this.lastTableStates.values()) this._send(ws, ts)
    if (this.lastTournamentComplete) this._send(ws, this.lastTournamentComplete)

    ws.on('error', (err) => {
      console.error('[ws] spectator socket error:', err.message)
    })
    ws.on('close', () => {
      this.spectators.delete(ws)
      this.spectatorAuth.delete(ws)
    })
  }

  /**
   * Send a message to a single spectator, stripping hole cards if the
   * connection is unauthenticated.
   */
  private _send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return
    const isAdmin = this.spectatorAuth.get(ws) ?? false
    const payload = (msg.type === 'table_state' && !isAdmin)
      ? this._stripHoleCards(msg)
      : msg
    ws.send(JSON.stringify(payload))
  }

  private _stripHoleCards(msg: TableStateMsg): TableStateMsg {
    return {
      ...msg,
      players: msg.players.map(p => ({ ...p, holeCards: [] })),
    }
  }

  /** Buffer the message then fan it out to every connected spectator. */
  broadcast(msg: ServerMessage): void {
    switch (msg.type) {
      case 'tournament_update':   this.lastStandings = msg; break
      case 'table_state':         this.lastTableStates.set(msg.tableId, msg); break
      case 'lobby_snapshot':      this.lastLobbySnapshot = msg; break
      case 'tournament_complete': this.lastTournamentComplete = msg; break
      case 'countdown':
        this.lastCountdown = msg.secondsRemaining > 0 ? msg : null
        break
      case 'hand_result':
        this.handHistory.push(msg)
        if (this.handHistory.length > MAX_HAND_HISTORY) this.handHistory.shift()
        break
    }

    for (const ws of this.spectators) this._send(ws, msg)
  }

  /**
   * Patches the connected/disconnected flag for a single player across
   * all table states and immediately re-broadcasts the affected table.
   */
  updatePlayerConnected(playerId: string, connected: boolean): void {
    for (const [tableId, ts] of this.lastTableStates) {
      if (!ts.players.some(p => p.id === playerId)) continue

      const updated: TableStateMsg = {
        ...ts,
        players: ts.players.map(p => p.id === playerId ? { ...p, connected } : p),
      }
      this.lastTableStates.set(tableId, updated)

      for (const ws of this.spectators) this._send(ws, updated)
      break  // a player can only be at one table
    }
  }

  /** Clear lobby snapshot only (used when lobby is closed). */
  clearLobbySnapshot(): void {
    this.lastLobbySnapshot = null
  }

  /** Reset all buffers at the start of a new tournament. */
  resetBuffers(): void {
    this.lastStandings          = null
    this.lastTableStates.clear()
    this.lastCountdown          = null
    this.lastLobbySnapshot      = null
    this.lastTournamentComplete = null
    this.handHistory.length     = 0
  }
}
