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

// All game-progress message types that are delayed for authenticated viewers.
// Public (unauthenticated) connections receive these immediately since they
// cannot see hole cards and have no unfair-advantage incentive to cheat.
const DELAYED_FOR_AUTH = new Set<string>([
  'hand_result', 'table_winner', 'tournament_complete',  // round outcomes
  'tournament_update',                                   // standings, blind level, player counts
  'bounty_announced', 'bounty_claimed', 'bounty_expired', // in-game events
  'countdown',                                           // tournament start timing
])

/**
 * Owns all spectator WebSocket state: the WS server, connected clients,
 * replay buffers, and the broadcast/catch-up logic.
 *
 * Authentication:
 *   Connections that supply the correct spectator key via `?key=` receive
 *   full holeCards in table_state messages.  All others see card backs.
 *
 * Broadcast delay:
 *   When delayMs > 0, messages are held in a queue and released after that
 *   many milliseconds.  Catch-up buffers are only updated when messages are
 *   actually released, so new spectators joining mid-game also see the
 *   delayed feed — preventing agents from reading the spectator stream.
 */
export class SpectatorState {
  readonly wss: WebSocketServer

  private spectators    = new Set<WebSocket>()
  private spectatorAuth = new Map<WebSocket, boolean>()   // ws → isAdmin

  // Catch-up buffers — updated at release time (not enqueue time)
  private lastStandings:          TournamentUpdateMsg   | null = null
  private lastTableStates         = new Map<string, TableStateMsg>()
  private lastCountdown:          CountdownMsg          | null = null
  private lastLobbySnapshot:      LobbySnapshotMsg      | null = null
  private lastTournamentComplete: TournamentCompleteMsg | null = null
  private handHistory:            HandResultMsg[]              = []

  // Delay queue — only used when delayMs > 0
  private queue: { deliverAt: number; msg: ServerMessage }[] = []

  constructor(
    private readonly adminKey: string,
    private readonly delayMs: number = 0,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1_024 })
    this.wss.on('connection', (ws, req) => this._handleConnection(ws, req as IncomingMessage))

    if (delayMs > 0) {
      const interval = setInterval(() => this._flush(), 250)
      interval.unref()
    }
  }

  private _handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url     = new URL(req.url ?? '/', 'http://localhost')
    const isAdmin = checkAdminKey(url.searchParams.get('key'), this.adminKey)

    this.spectators.add(ws)
    this.spectatorAuth.set(ws, isAdmin)

    // Replay already-released catch-up state
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

  /** Send one message to a spectator, stripping hole cards when unauthenticated. */
  private _send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return
    const isAdmin = this.spectatorAuth.get(ws) ?? false
    const payload = (msg.type === 'table_state' && !isAdmin)
      ? this._stripHoleCards(msg)
      : msg
    ws.send(JSON.stringify(payload))
  }

  private _stripHoleCards(msg: TableStateMsg): TableStateMsg {
    return { ...msg, players: msg.players.map(p => ({ ...p, holeCards: [] })) }
  }

  /**
   * Seat-position skeleton: keeps only player identity and table topology.
   * Sent immediately to authenticated viewers so the felt looks populated,
   * while all financial and game-state data is held until the delayed release.
   */
  private _skeletonTableState(msg: TableStateMsg): TableStateMsg {
    return {
      ...msg,
      players: msg.players.map(p => ({
        id:         p.id,
        isDealer:   p.isDealer,
        connected:  p.connected,
        stack:      0,
        bet:        0,
        folded:     false,
        allIn:      false,
        isActing:   false,
        holeCards:  [],
      })),
      communityCards: [],
      pot: 0,
    }
  }

  /** Update the catch-up buffers when a message is actually released. */
  private _applyToBuffers(msg: ServerMessage): void {
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
  }

  /** Release queued card-data messages whose delivery time has passed. */
  private _flush(): void {
    const now = Date.now()
    let i = 0
    while (i < this.queue.length && this.queue[i].deliverAt <= now) i++
    if (i === 0) return
    const toSend = this.queue.splice(0, i)
    for (const { msg } of toSend) {
      // Buffers were already updated at broadcast time; only send to authenticated
      // connections — unauthenticated already received the stripped version immediately.
      for (const ws of this.spectators) {
        const isAdmin = this.spectatorAuth.get(ws) ?? false
        if (isAdmin) this._send(ws, msg)
      }
    }
  }

  /** Buffer then fan out a message (honouring delay if configured).
   *
   * When delayMs > 0, game-outcome data is delayed for authenticated viewers:
   *   - Lobby / standings / countdown → immediate for everyone (no secrets).
   *   - table_state → stripped version immediate for everyone (table appears
   *     populated right away); full version (hole cards) queued for authenticated
   *     connections only, released after delayMs.
   *   - hand_result / table_winner / tournament_complete → immediate for
   *     unauthenticated; queued for authenticated (keeps their view in sync with
   *     the delayed table_state stream so round outcomes are revealed together).
   */
  broadcast(msg: ServerMessage): void {
    // Catch-up buffers always reflect the latest state so new connections join
    // into a populated view regardless of the delay setting.
    this._applyToBuffers(msg)

    if (this.delayMs > 0) {
      if (msg.type === 'table_state') {
        // Public: stripped (all data except hole cards) — they can't cheat with cards.
        // Keyed auth: skeleton only (seat positions, no financial/game state data).
        // Full version queued for keyed auth and released after the delay.
        const stripped = this._stripHoleCards(msg)
        const skeleton = this._skeletonTableState(msg)
        for (const ws of this.spectators) {
          if (ws.readyState !== ws.OPEN) continue
          const isAdmin = this.spectatorAuth.get(ws) ?? false
          ws.send(JSON.stringify(isAdmin ? skeleton : stripped))
        }
        this.queue.push({ deliverAt: Date.now() + this.delayMs, msg })
      } else if (DELAYED_FOR_AUTH.has(msg.type)) {
        // Game-progress messages: immediate for public, delayed for keyed auth.
        for (const ws of this.spectators) {
          const isAdmin = this.spectatorAuth.get(ws) ?? false
          if (!isAdmin) this._send(ws, msg)
        }
        this.queue.push({ deliverAt: Date.now() + this.delayMs, msg })
      } else {
        // Pre-game only (countdown, lobby_snapshot): immediate for all
        for (const ws of this.spectators) this._send(ws, msg)
      }
    } else {
      // No delay configured: send everything immediately
      for (const ws of this.spectators) this._send(ws, msg)
    }
  }

  /**
   * Patches the connected flag for one player and immediately re-broadcasts
   * the affected table state.  Skipped in delay mode — the next queued
   * table_state already carries the correct status.
   */
  updatePlayerConnected(playerId: string, connected: boolean): void {
    if (this.delayMs > 0) return   // connection patches are implicit in the delayed feed

    for (const [tableId, ts] of this.lastTableStates) {
      if (!ts.players.some(p => p.id === playerId)) continue

      const updated: TableStateMsg = {
        ...ts,
        players: ts.players.map(p => p.id === playerId ? { ...p, connected } : p),
      }
      this.lastTableStates.set(tableId, updated)
      for (const ws of this.spectators) this._send(ws, updated)
      break
    }
  }

  clearLobbySnapshot(): void { this.lastLobbySnapshot = null }

  /** Reset all buffers and discard any queued delay messages. */
  resetBuffers(): void {
    this.lastStandings          = null
    this.lastTableStates.clear()
    this.lastCountdown          = null
    this.lastLobbySnapshot      = null
    this.lastTournamentComplete = null
    this.handHistory.length     = 0
    this.queue.length           = 0  // drop in-flight messages from the previous tournament
  }
}
