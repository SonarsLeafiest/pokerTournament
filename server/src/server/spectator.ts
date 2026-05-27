import { WebSocketServer, type WebSocket } from 'ws'
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
 */
export class SpectatorState {
  readonly wss: WebSocketServer

  private spectators             = new Set<WebSocket>()
  private lastStandings:          TournamentUpdateMsg   | null = null
  private lastTableStates         = new Map<string, TableStateMsg>()  // tableId → msg
  private lastCountdown:          CountdownMsg          | null = null
  private lastLobbySnapshot:      LobbySnapshotMsg      | null = null
  private lastTournamentComplete: TournamentCompleteMsg | null = null
  private handHistory:            HandResultMsg[]              = []

  constructor() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1_024 })
    this.wss.on('connection', (ws) => this._handleConnection(ws))
  }

  private _handleConnection(ws: WebSocket): void {
    this.spectators.add(ws)

    // Replay buffered state in original message order
    if (this.lastLobbySnapshot)      ws.send(JSON.stringify(this.lastLobbySnapshot))
    if (this.lastCountdown)          ws.send(JSON.stringify(this.lastCountdown))
    if (this.lastStandings)          ws.send(JSON.stringify(this.lastStandings))
    for (const h of this.handHistory) ws.send(JSON.stringify(h))
    for (const ts of this.lastTableStates.values()) ws.send(JSON.stringify(ts))
    if (this.lastTournamentComplete) ws.send(JSON.stringify(this.lastTournamentComplete))

    ws.on('error', (err) => {
      console.error('[ws] spectator socket error:', err.message)
    })
    ws.on('close', () => this.spectators.delete(ws))
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

    const raw = JSON.stringify(msg)
    for (const ws of this.spectators) {
      if (ws.readyState === ws.OPEN) ws.send(raw)
    }
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

      const raw = JSON.stringify(updated)
      for (const ws of this.spectators) {
        if (ws.readyState === ws.OPEN) ws.send(raw)
      }
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
