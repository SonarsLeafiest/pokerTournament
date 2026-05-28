import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SpectatorState } from './spectator.js'
import type { TableStateMsg, TournamentUpdateMsg } from './protocol.js'
import { GameStage } from '../engine/game.js'

// ── Fake WebSocket helpers ────────────────────────────────────────────────────

function makeWs(): { readyState: number; OPEN: number; send: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } {
  return { readyState: 1, OPEN: 1, send: vi.fn(), on: vi.fn() }
}

type FakeWs = ReturnType<typeof makeWs>

function inject(state: SpectatorState, ws: FakeWs, isAdmin: boolean): void {
  const s = state as any
  s.spectators.add(ws)
  s.spectatorAuth.set(ws, isAdmin)
}

function flush(state: SpectatorState): void {
  (state as any)._flush()
}

function received(ws: FakeWs): any[] {
  return ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]))
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TABLE_MSG: TableStateMsg = {
  type: 'table_state',
  tableId: 'table-1',
  handNumber: 1,
  stage: GameStage.PRE_FLOP,
  players: [{
    id: 'p1', stack: 980, bet: 20, folded: false, allIn: false,
    isActing: true, isDealer: true, connected: true,
    holeCards: [{ rank: 14, suit: 's' }, { rank: 13, suit: 's' }],
  }],
  communityCards: [],
  pot: 30,
  dealerIndex: 0,
}

const STANDINGS_MSG: TournamentUpdateMsg = {
  type: 'tournament_update',
  standings: [{ playerId: 'p1', stack: 980, eliminated: false }],
  blindLevel: 1, smallBlind: 10, bigBlind: 20,
  activeTables: ['table-1'], tableCount: 1,
}

// ── No-delay mode ────────────────────────────────────────────────────────────

describe('no delay (delayMs=0)', () => {
  it('sends stripped table_state to unauthenticated connections', () => {
    const state = new SpectatorState('key', 0)
    const ws = makeWs()
    inject(state, ws, false)
    state.broadcast(TABLE_MSG)
    const msgs = received(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].players[0].holeCards).toHaveLength(0)
  })

  it('sends full table_state to authenticated connections', () => {
    const state = new SpectatorState('key', 0)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(TABLE_MSG)
    expect(received(ws)[0].players[0].holeCards).toHaveLength(2)
  })

  it('sends non-card messages immediately to all connections', () => {
    const state = new SpectatorState('key', 0)
    const wsAuth = makeWs()
    const wsUnauth = makeWs()
    inject(state, wsAuth, true)
    inject(state, wsUnauth, false)
    state.broadcast(STANDINGS_MSG)
    expect(received(wsAuth)).toHaveLength(1)
    expect(received(wsUnauth)).toHaveLength(1)
    expect(received(wsAuth)[0].type).toBe('tournament_update')
  })
})

// ── Delay mode ───────────────────────────────────────────────────────────────

describe('delay mode (delayMs > 0)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('sends table_state stripped to unauthenticated immediately', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, false)
    state.broadcast(TABLE_MSG)

    const msgs = received(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe('table_state')
    expect(msgs[0].players[0].holeCards).toHaveLength(0)
  })

  it('sends table_state stripped to authenticated immediately (table visible right away)', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(TABLE_MSG)

    const msgs = received(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe('table_state')
    expect(msgs[0].players[0].holeCards).toHaveLength(0)
  })

  it('sends full table_state to authenticated connections after delay', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(TABLE_MSG)

    vi.advanceTimersByTime(5100)
    flush(state)

    const msgs = received(ws)
    expect(msgs).toHaveLength(2)
    expect(msgs[1].players[0].holeCards).toHaveLength(2)
  })

  it('does NOT send full table_state to unauthenticated connections after flush', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, false)
    state.broadcast(TABLE_MSG)

    vi.advanceTimersByTime(5100)
    flush(state)

    // Unauthenticated only ever gets the one stripped message
    expect(received(ws)).toHaveLength(1)
  })

  it('sends non-card messages immediately to all connections (no delay)', () => {
    const state = new SpectatorState('key', 5000)
    const wsAuth = makeWs()
    const wsUnauth = makeWs()
    inject(state, wsAuth, true)
    inject(state, wsUnauth, false)
    state.broadcast(STANDINGS_MSG)

    // Both receive immediately without waiting for the flush interval
    expect(received(wsAuth)).toHaveLength(1)
    expect(received(wsUnauth)).toHaveLength(1)
    expect(received(wsAuth)[0].type).toBe('tournament_update')
    expect(received(wsUnauth)[0].type).toBe('tournament_update')
  })

  it('non-card messages are not held in the queue', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(STANDINGS_MSG)

    // No pending queue entries for non-card messages
    const queue: any[] = (state as any).queue
    expect(queue).toHaveLength(0)
  })

  it('full table_state is not released until delayMs has elapsed', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(TABLE_MSG)

    // Just before expiry: still only the initial stripped message
    vi.advanceTimersByTime(4000)
    flush(state)
    expect(received(ws)).toHaveLength(1)

    // After expiry: full message arrives
    vi.advanceTimersByTime(1100)
    flush(state)
    expect(received(ws)).toHaveLength(2)
    expect(received(ws)[1].players[0].holeCards).toHaveLength(2)
  })
})
