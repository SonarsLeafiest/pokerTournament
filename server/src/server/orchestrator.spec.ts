/**
 * Orchestrator bounty logic — unit tests.
 *
 * We test the private per-table bounty methods by reaching into the
 * orchestrator's state via `as any` casts.  The WebSocket hub and spectator
 * are replaced with lightweight spies so no real sockets are needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import { Tournament, type TournamentConfig } from '../engine/tournament.js'
import { ActionType } from '../engine/game.js'

// ── Minimal stubs ─────────────────────────────────────────────────────────────

function makeSpectator() {
  return { broadcast: vi.fn(), resetBuffers: vi.fn(), updatePlayerConnected: vi.fn() } as any
}

function makeHub() {
  return {
    sendToAgent: vi.fn(), broadcast: vi.fn(), waitForCurse: vi.fn().mockResolvedValue(null),
    isAgentConnected: vi.fn().mockReturnValue(true), getConnectedAgents: vi.fn().mockReturnValue([]),
    disconnectAll: vi.fn(),
  } as any
}

function makeOrchestrator(bountyWindowHands = 10, bountyFireEvery = 5, bountyCurseAmount = 0) {
  const spectator = makeSpectator()
  const hub       = makeHub()
  const opts = {
    hub, spectator,
    turnDelayMs: 0, actionTimeout: 1000,
    getLobbyState: () => 'in_progress' as const,
    setLobbyState: vi.fn(),
    isAborted: () => false,
    bountyWindowHands, bountyFireEvery,
    bountyReward: 200, bountyCurseAmount,
  }
  return { orch: new Orchestrator(opts), spectator, hub }
}

const BASE_CONFIG: TournamentConfig = {
  players:        [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' },
                   { id: 'p4', name: 'D' }, { id: 'p5', name: 'E' }, { id: 'p6', name: 'F' }],
  startingStack:  500,
  blindLevels:    [{ smallBlind: 10, bigBlind: 20, handsPerLevel: 99 }],
  tableSizes:     3,
  actionTimeoutMs: 1000,
}

function makeTournament() {
  const t = new Tournament(BASE_CONFIG)
  t.seatTables()
  return t
}

// ── Helpers to reach private state ───────────────────────────────────────────

const getActiveBounties   = (o: Orchestrator) => (o as any).activeBounties   as Map<string, any>
const getNextBountyAtHand = (o: Orchestrator) => (o as any).nextBountyAtHand as Map<string, number>
const syncState           = (o: Orchestrator, ids: string[]) => (o as any).syncTableBountyState(ids)
const announce            = (o: Orchestrator, t: Tournament, tid: string, hand: number) =>
  (o as any).maybeAnnounceBounty(t, tid, hand)
const resolve             = (o: Orchestrator, t: Tournament, tid: string, hand: number,
                               before: Map<string, number>, wasActive: boolean) =>
  (o as any).resolveBounty(t, tid, hand, before, wasActive)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncTableBountyState', () => {
  it('initialises counters for all tables', () => {
    const { orch } = makeOrchestrator(10, 5)
    syncState(orch, ['table-1', 'table-2'])
    expect(getNextBountyAtHand(orch).has('table-1')).toBe(true)
    expect(getNextBountyAtHand(orch).has('table-2')).toBe(true)
  })

  it('removes counters for dissolved tables', () => {
    const { orch } = makeOrchestrator(10, 5)
    syncState(orch, ['table-1', 'table-2'])
    syncState(orch, ['table-1'])            // table-2 merged
    expect(getNextBountyAtHand(orch).has('table-2')).toBe(false)
  })

  it('does not reset existing counter when table survives', () => {
    const { orch } = makeOrchestrator(10, 5)
    syncState(orch, ['table-1'])
    getNextBountyAtHand(orch).set('table-1', 99)  // simulate mid-game value
    syncState(orch, ['table-1'])
    expect(getNextBountyAtHand(orch).get('table-1')).toBe(99)
  })

  it('fires at cooldownHands when bounties enabled (bountyFireEvery=5)', () => {
    const { orch } = makeOrchestrator(10, 5)
    syncState(orch, ['table-1'])
    expect(getNextBountyAtHand(orch).get('table-1')).toBe(5)  // cooldownHands = bountyFireEvery
  })

  it('fires at bountyWindowHands when bountyFireEvery=0 (fallback)', () => {
    const { orch } = makeOrchestrator(10, 0)
    syncState(orch, ['table-1'])
    expect(getNextBountyAtHand(orch).get('table-1')).toBe(10)
  })

  it('sets Infinity when bounties disabled', () => {
    const { orch } = makeOrchestrator(0, 0)
    syncState(orch, ['table-1'])
    expect(getNextBountyAtHand(orch).get('table-1')).toBe(Infinity)
  })
})

describe('maybeAnnounceBounty', () => {
  it('announces a bounty when hand reaches the fire threshold', () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)

    const tableId = t.tableIds[0]
    getNextBountyAtHand(orch).set(tableId, 5)
    announce(orch, t, tableId, 5)

    expect(getActiveBounties(orch).has(tableId)).toBe(true)
    expect(spectator.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'bounty_announced', tableId }))
  })

  it('does not announce before the fire threshold', () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)

    const tableId = t.tableIds[0]
    getNextBountyAtHand(orch).set(tableId, 10)
    announce(orch, t, tableId, 5)   // hand 5 < threshold 10

    expect(getActiveBounties(orch).has(tableId)).toBe(false)
    expect(spectator.broadcast).not.toHaveBeenCalled()
  })

  it('does not announce when a bounty is already active for the table', () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)

    const tableId = t.tableIds[0]
    getActiveBounties(orch).set(tableId, { targetId: 'p1', targetName: 'A', reward: 200, expiresAfterHand: 15 })
    getNextBountyAtHand(orch).set(tableId, 5)
    announce(orch, t, tableId, 5)

    expect(spectator.broadcast).not.toHaveBeenCalled()
  })

  it('does not announce when table has <= 2 active players', () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)

    const tableId = t.tableIds[0]
    // Eliminate everyone except 2
    const tablePlayers = t.getTableActivePlayers(tableId)
    for (const p of tablePlayers.slice(2)) {
      ;(t as any).players.get(p.id).eliminated = true
    }
    getNextBountyAtHand(orch).set(tableId, 5)
    announce(orch, t, tableId, 5)

    expect(getActiveBounties(orch).has(tableId)).toBe(false)
  })

  it('announces independently for each table', () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)
    expect(t.tableIds).toHaveLength(2)

    for (const tableId of t.tableIds) {
      getNextBountyAtHand(orch).set(tableId, 5)
      announce(orch, t, tableId, 5)
    }

    expect(getActiveBounties(orch).size).toBe(2)
    // Each announcement has its own tableId
    const calls = (spectator.broadcast as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    const tableIds = calls.map((m: any) => m.tableId)
    expect(tableIds).toContain(t.tableIds[0])
    expect(tableIds).toContain(t.tableIds[1])
  })
})

describe('resolveBounty — expiry', () => {
  it('expires a bounty after the window closes', async () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)
    const tableId = t.tableIds[0]

    getActiveBounties(orch).set(tableId, {
      targetId: 'p1', targetName: 'A', reward: 200, expiresAfterHand: 10,
    })
    const before = new Map(t.standings.map(p => [p.id, p.stack]))
    await resolve(orch, t, tableId, 10, before, true)

    expect(getActiveBounties(orch).has(tableId)).toBe(false)
    expect(spectator.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'bounty_expired', tableId }))
    expect(getNextBountyAtHand(orch).get(tableId)).toBe(10 + 5) // hand + cooldown
  })

  it('cancels bounty at heads-up on the table', async () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)
    const tableId = t.tableIds[0]

    // Eliminate down to 2 players at this table
    const tablePlayers = t.getTableActivePlayers(tableId)
    ;(t as any).players.get(tablePlayers[2].id).eliminated = true

    getActiveBounties(orch).set(tableId, {
      targetId: tablePlayers[0].id, targetName: 'A', reward: 200, expiresAfterHand: 20,
    })
    const before = new Map(t.standings.map(p => [p.id, p.stack]))
    await resolve(orch, t, tableId, 5, before, true)

    expect(getActiveBounties(orch).has(tableId)).toBe(false)
    expect(getNextBountyAtHand(orch).get(tableId)).toBe(Infinity)
  })
})

describe('resolveBounty — claim', () => {
  it('awards reward to the player with the largest positive stack delta', async () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)
    const tableId = t.tableIds[0]
    const players = t.getTableActivePlayers(tableId)
    const target  = players[0]
    const claimer = players[1]

    // Set up bounty on target
    getActiveBounties(orch).set(tableId, {
      targetId: target.id, targetName: target.name, reward: 200, expiresAfterHand: 15,
    })

    // Record stacks before the "hand"
    const before = new Map(t.standings.map(p => [p.id, p.stack]))

    // Eliminate the target and give the claimer a big stack gain
    ;(t as any).players.get(target.id).eliminated = true
    ;(t as any).players.get(target.id).stack      = 0
    ;(t as any).players.get(claimer.id).stack    += 300

    await resolve(orch, t, tableId, 5, before, true)

    expect(getActiveBounties(orch).has(tableId)).toBe(false)
    expect(spectator.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bounty_claimed', tableId, claimedById: claimer.id, reward: 200,
    }))
    // Bonus chips awarded
    expect(t.standings.find(p => p.id === claimer.id)!.stack).toBe(before.get(claimer.id)! + 300 + 200)
  })

  it('skips resolution when targetWasActive=false', async () => {
    const { orch, spectator } = makeOrchestrator(10, 5)
    const t = makeTournament()
    syncState(orch, t.tableIds)
    const tableId = t.tableIds[0]

    getActiveBounties(orch).set(tableId, {
      targetId: 'p1', targetName: 'A', reward: 200, expiresAfterHand: 15,
    })
    const before = new Map(t.standings.map(p => [p.id, p.stack]))
    await resolve(orch, t, tableId, 5, before, false)  // target wasn't active

    // Bounty should still be active — nothing resolved
    expect(getActiveBounties(orch).has(tableId)).toBe(true)
    expect(spectator.broadcast).not.toHaveBeenCalled()
  })
})
