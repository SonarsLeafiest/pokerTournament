import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SpectatorState } from './spectator.js'
import type {
  TableStateMsg, TournamentUpdateMsg, HandResultMsg, TournamentCompleteMsg, TableWinnerMsg,
  BountyAnnouncedMsg, BountyClaimedMsg, BountyExpiredMsg, CountdownMsg,
} from './protocol.js'
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
  communityCards: [{ rank: 10, suit: 'h' }],
  pot: 30,
  dealerIndex: 0,
}

const STANDINGS_MSG: TournamentUpdateMsg = {
  type: 'tournament_update',
  standings: [{ playerId: 'p1', stack: 980, eliminated: false }],
  blindLevel: 1, smallBlind: 10, bigBlind: 20,
  activeTables: ['table-1'], tableCount: 1,
}

const COUNTDOWN_MSG: CountdownMsg = {
  type: 'countdown',
  secondsRemaining: 5,
  agentCount: 3,
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
    expect(msgs[0].players[0].stack).toBe(980)  // financial data present
    expect(msgs[0].pot).toBe(30)
  })

  it('sends full table_state to authenticated connections', () => {
    const state = new SpectatorState('key', 0)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(TABLE_MSG)
    expect(received(ws)[0].players[0].holeCards).toHaveLength(2)
  })

  it('sends all messages immediately to all connections when no delay', () => {
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

  // ── table_state ────────────────────────────────────────────────────────────

  it('sends stripped table_state to unauthenticated immediately (full data except hole cards)', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, false)
    state.broadcast(TABLE_MSG)

    const msgs = received(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe('table_state')
    expect(msgs[0].players[0].holeCards).toHaveLength(0)  // stripped
    expect(msgs[0].players[0].stack).toBe(980)             // financial data intact
    expect(msgs[0].pot).toBe(30)
    expect(msgs[0].communityCards).toHaveLength(1)
  })

  it('sends SKELETON table_state to authenticated immediately (seat positions only, no financial data)', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(TABLE_MSG)

    const msgs = received(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe('table_state')
    expect(msgs[0].players[0].id).toBe('p1')       // identity kept
    expect(msgs[0].players[0].holeCards).toHaveLength(0)  // no cards
    expect(msgs[0].players[0].stack).toBe(0)        // stack zeroed
    expect(msgs[0].players[0].bet).toBe(0)          // bet zeroed
    expect(msgs[0].players[0].isActing).toBe(false) // acting state zeroed
    expect(msgs[0].communityCards).toHaveLength(0)  // no community cards
    expect(msgs[0].pot).toBe(0)                     // pot zeroed
  })

  it('sends full table_state to authenticated after delay', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(TABLE_MSG)

    vi.advanceTimersByTime(5100)
    flush(state)

    const msgs = received(ws)
    expect(msgs).toHaveLength(2)
    expect(msgs[1].players[0].holeCards).toHaveLength(2)
    expect(msgs[1].players[0].stack).toBe(980)
    expect(msgs[1].pot).toBe(30)
  })

  it('does NOT send full table_state to unauthenticated after flush', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, false)
    state.broadcast(TABLE_MSG)

    vi.advanceTimersByTime(5100)
    flush(state)

    expect(received(ws)).toHaveLength(1)
  })

  it('full table_state is not released until delayMs has elapsed', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(TABLE_MSG)

    vi.advanceTimersByTime(4000)
    flush(state)
    expect(received(ws)).toHaveLength(1)

    vi.advanceTimersByTime(1100)
    flush(state)
    expect(received(ws)).toHaveLength(2)
    expect(received(ws)[1].players[0].holeCards).toHaveLength(2)
  })

  // ── Pre-game messages ─────────────────────────────────────────────────────

  it('lobby_snapshot is immediate for all connections (keyed viewers need lobby state)', () => {
    const state = new SpectatorState('key', 5000)
    const wsAuth = makeWs()
    const wsUnauth = makeWs()
    inject(state, wsAuth, true)
    inject(state, wsUnauth, false)
    const msg = { type: 'lobby_snapshot' as const, agents: [] }
    state.broadcast(msg)

    expect(received(wsAuth)).toHaveLength(1)
    expect(received(wsUnauth)).toHaveLength(1)
    expect((state as any).queue).toHaveLength(0)
  })

  it('countdown is immediate for unauthenticated and delayed for authenticated', () => {
    const state = new SpectatorState('key', 5000)
    const wsAuth = makeWs()
    const wsUnauth = makeWs()
    inject(state, wsAuth, true)
    inject(state, wsUnauth, false)
    state.broadcast(COUNTDOWN_MSG)

    // Unauthenticated sees it immediately
    expect(received(wsUnauth)).toHaveLength(1)
    expect(received(wsUnauth)[0].type).toBe('countdown')
    // Authenticated does not see it yet
    expect(received(wsAuth)).toHaveLength(0)
    expect((state as any).queue).toHaveLength(1)
  })

  it('countdown is delivered to authenticated after delay', () => {
    const state = new SpectatorState('key', 5000)
    const ws = makeWs()
    inject(state, ws, true)
    state.broadcast(COUNTDOWN_MSG)
    vi.advanceTimersByTime(5100)
    flush(state)
    expect(received(ws)).toHaveLength(1)
    expect(received(ws)[0].type).toBe('countdown')
  })
})

// ── Delayed message types (hand/result data) ─────────────────────────────────

describe('result + standings message delay', () => {
  const HAND_RESULT_MSG: HandResultMsg = {
    type: 'hand_result', gameId: 'table-1', handNumber: 5,
    winners: [{ playerId: 'p1', amount: 100 }], showdown: [], deltas: { p1: 80, p2: -80 },
  }
  const TABLE_WINNER_MSG: TableWinnerMsg = {
    type: 'table_winner', tableId: 'table-2', handNumber: 12,
    winnerId: 'p3', winnerName: 'Carol', winnerStack: 1000,
  }
  const TOURNAMENT_COMPLETE_MSG: TournamentCompleteMsg = {
    type: 'tournament_complete', winnerId: 'p1', winnerName: 'Alice',
    finalStack: 2000,
    standings: [{ playerId: 'p1', name: 'Alice', place: 1, stack: 2000 }],
  }
  const BOUNTY_ANNOUNCED_MSG: BountyAnnouncedMsg = {
    type: 'bounty_announced', targetId: 'p2', targetName: 'Bob',
    reward: 500, expiresAfterHand: 15, handNumber: 5,
  }
  const BOUNTY_CLAIMED_MSG: BountyClaimedMsg = {
    type: 'bounty_claimed', targetId: 'p2', targetName: 'Bob',
    claimedById: 'p1', claimedByName: 'Alice', reward: 500, handNumber: 8,
  }
  const BOUNTY_EXPIRED_MSG: BountyExpiredMsg = {
    type: 'bounty_expired', targetId: 'p2', targetName: 'Bob', handNumber: 15,
  }

  beforeEach(() => { vi.useFakeTimers() })

  for (const [label, msg] of [
    ['hand_result',          HAND_RESULT_MSG],
    ['table_winner',         TABLE_WINNER_MSG],
    ['tournament_complete',  TOURNAMENT_COMPLETE_MSG],
    ['tournament_update',    STANDINGS_MSG],
    ['bounty_announced',     BOUNTY_ANNOUNCED_MSG],
    ['bounty_claimed',       BOUNTY_CLAIMED_MSG],
    ['bounty_expired',       BOUNTY_EXPIRED_MSG],
    ['countdown',            COUNTDOWN_MSG],
  ] as const) {
    it(`${label}: unauthenticated receives immediately`, () => {
      const state = new SpectatorState('key', 5000)
      const ws = makeWs()
      inject(state, ws, false)
      state.broadcast(msg as any)
      expect(received(ws)).toHaveLength(1)
      expect(received(ws)[0].type).toBe(label)
    })

    it(`${label}: authenticated receives nothing immediately`, () => {
      const state = new SpectatorState('key', 5000)
      const ws = makeWs()
      inject(state, ws, true)
      state.broadcast(msg as any)
      expect(received(ws)).toHaveLength(0)
    })

    it(`${label}: authenticated receives after delay`, () => {
      const state = new SpectatorState('key', 5000)
      const ws = makeWs()
      inject(state, ws, true)
      state.broadcast(msg as any)
      vi.advanceTimersByTime(5100)
      flush(state)
      expect(received(ws)).toHaveLength(1)
      expect(received(ws)[0].type).toBe(label)
    })

    it(`${label}: not queued when no delay configured`, () => {
      const state = new SpectatorState('key', 0)
      const wsAuth = makeWs()
      const wsUnauth = makeWs()
      inject(state, wsAuth, true)
      inject(state, wsUnauth, false)
      state.broadcast(msg as any)
      expect(received(wsAuth)).toHaveLength(1)
      expect(received(wsUnauth)).toHaveLength(1)
      expect((state as any).queue).toHaveLength(0)
    })
  }
})
