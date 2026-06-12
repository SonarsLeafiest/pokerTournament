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
  SpectatorSyncMsg,
} from './protocol.js'

const MAX_HAND_HISTORY = 200

// Message types that are delayed for authenticated (keyed) viewers.
// Public connections always receive these immediately — they can't see hole
// cards so they have no incentive to cheat via the spectator stream.
//
// Everything NOT in this set (i.e. lobby_snapshot) is immediate for all.
const DELAYED_FOR_AUTH = new Set<string>([
  'table_state',                                         // full game state with hole cards
  'hand_result', 'table_winner', 'tournament_complete',  // round outcomes
  'tournament_update',                                   // standings, blind levels, counts
  'bounty_announced', 'bounty_claimed', 'bounty_expired', 'bounty_cursed', // in-game events
  'countdown',                                           // tournament start timing
  'agent_timeout',                                       // LLM missed its action window
])

/**
 * Owns all spectator WebSocket state.
 *
 * Two-tier broadcast model (when delayMs > 0):
 *
 *   Public (no key):
 *     All messages immediate. table_state has hole cards stripped.
 *     Full catch-up sent on connect.
 *
 *   Keyed (authenticated):
 *     Every message in DELAYED_FOR_AUTH is queued and released after delayMs.
 *     table_state is sent with full hole-card data once released.
 *     NO game-state catch-up on connect — the felt starts empty and fills in
 *     as the delayed feed arrives. This prevents any real-time information leak.
 *     Only lobby_snapshot is sent immediately so they see who's registered.
 *
 * When delayMs === 0 both viewers behave identically (public path for all).
 */
export class SpectatorState {
  readonly wss: WebSocketServer

  private spectators    = new Set<WebSocket>()
  private spectatorAuth = new Map<WebSocket, boolean>()   // ws → isAdmin

  // Catch-up buffers — updated immediately at broadcast time so public viewers
  // joining mid-game see current state. Keyed auth viewers skip game-state
  // catch-up entirely and wait for the delayed queue to deliver data.
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

    // Lobby snapshot: always immediate so both views show who's registered.
    if (this.lastLobbySnapshot) this._send(ws, this.lastLobbySnapshot)

    if (!isAdmin || this.delayMs === 0) {
      // Public viewers (or delay disabled): full real-time catch-up.
      if (this.lastCountdown)           this._send(ws, this.lastCountdown)
      if (this.lastStandings)           this._send(ws, this.lastStandings)
      for (const h of this.handHistory)  this._send(ws, h)
      for (const ts of this.lastTableStates.values()) this._send(ws, ts)
      if (this.lastTournamentComplete)  this._send(ws, this.lastTournamentComplete)
    }
    // Keyed auth with delay: no game-state catch-up. The felt starts blank and
    // fills in as the delayed queue delivers messages. This ensures no real-time
    // data is ever visible on the keyed view, even on initial load.
    // Tell the client how long until the first queued message arrives so the
    // countdown timer shows the actual remaining wait rather than always the full delay.
    if (isAdmin && this.delayMs > 0) {
      const hasQueuedMessages = this.queue.length > 0
      const delayRemainingMs = hasQueuedMessages
        ? Math.max(0, this.queue[0].deliverAt - Date.now())
        : this.delayMs
      const syncMsg: SpectatorSyncMsg = { type: 'spectator_sync', delayRemainingMs, hasQueuedMessages }
      this._send(ws, syncMsg)
    }

    ws.on('error', (err) => {
      console.error('[ws] spectator socket error:', err.message)
    })
    ws.on('close', () => {
      this.spectators.delete(ws)
      this.spectatorAuth.delete(ws)
    })
  }

  /** Send one message to a spectator, stripping hole cards for public connections. */
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

  /** Update catch-up buffers so public viewers joining mid-game see current state. */
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

  /** Release queued messages whose delivery time has passed. */
  private _flush(): void {
    const now = Date.now()
    let i = 0
    while (i < this.queue.length && this.queue[i].deliverAt <= now) i++
    if (i === 0) return
    const toSend = this.queue.splice(0, i)
    for (const { msg } of toSend) {
      for (const ws of this.spectators) {
        const isAdmin = this.spectatorAuth.get(ws) ?? false
        if (isAdmin) this._send(ws, msg)
      }
    }
  }

  /**
   * Fan out a message to all spectators, honouring the delay for keyed viewers.
   *
   * When delayMs > 0:
   *   - lobby_snapshot: immediate for everyone (pre-game state, not sensitive).
   *   - All other messages (DELAYED_FOR_AUTH): immediate for public, queued for
   *     keyed auth and released after delayMs. table_state is sent with full
   *     hole-card data when released; stripped of hole cards for public.
   *
   * When delayMs === 0: everything immediate for everyone.
   */
  broadcast(msg: ServerMessage): void {
    this._applyToBuffers(msg)

    if (this.delayMs > 0 && DELAYED_FOR_AUTH.has(msg.type)) {
      // Public: send immediately (stripped for table_state)
      for (const ws of this.spectators) {
        const isAdmin = this.spectatorAuth.get(ws) ?? false
        if (!isAdmin) this._send(ws, msg)
      }
      // Keyed auth: queue for delayed delivery
      this.queue.push({ deliverAt: Date.now() + this.delayMs, msg })
    } else {
      // No delay or pre-game message: immediate for all
      for (const ws of this.spectators) this._send(ws, msg)
    }
  }

  /**
   * Patches the connected flag for one player and re-broadcasts the table state.
   * Skipped in delay mode — connection state is implicit in the delayed feed.
   */
  updatePlayerConnected(playerId: string, connected: boolean): void {
    if (this.delayMs > 0) return

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
    this.queue.length           = 0
  }
}
