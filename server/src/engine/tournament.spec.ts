import { describe, it, expect } from 'vitest'
import { Tournament, type TournamentConfig, type ActionRequestor } from './tournament.js'
import { ActionType } from './game.js'

const BASE_CONFIG: TournamentConfig = {
  players: [
    { id: 'p1', name: 'Alice' },
    { id: 'p2', name: 'Bob' },
    { id: 'p3', name: 'Carol' },
  ],
  startingStack: 500,
  blindLevels: [{ smallBlind: 10, bigBlind: 20, handsPerLevel: 99 }],
  tableSizes: 6,
  actionTimeoutMs: 5000,
}

const alwaysFold: ActionRequestor = async () => ({ type: ActionType.FOLD })

function getTableState(t: Tournament, tableId = 'table-1') {
  return (t as any).tables.get(tableId) as { dealerIndex: number; playerIds: string[] }
}

describe('playHand return value', () => {
  it('should return the winners with amounts won', async () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    const results = await t.playHand('table-1', alwaysFold)
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]).toMatchObject({ playerId: expect.any(String), amount: expect.any(Number) })
    expect(results[0].amount).toBeGreaterThan(0)
  })
})

describe('tableIds getter', () => {
  it('returns empty array before seatTables()', () => {
    const t = new Tournament(BASE_CONFIG)
    expect(t.tableIds).toEqual([])
  })

  it('returns ["table-1"] for 3-player config with tableSizes:6', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    expect(t.tableIds).toEqual(['table-1'])
  })

  it('returns two table ids for 7-player config with tableSizes:4', () => {
    const cfg: TournamentConfig = {
      ...BASE_CONFIG,
      players: Array.from({ length: 7 }, (_, i) => ({ id: `p${i+1}`, name: `P${i+1}` })),
      tableSizes: 4,
    }
    const t = new Tournament(cfg)
    t.seatTables()
    expect(t.tableIds).toHaveLength(2)
    expect(t.tableIds).toContain('table-1')
    expect(t.tableIds).toContain('table-2')
  })

  it('updates after a second seatTables() call', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    expect(t.tableIds).toHaveLength(1)
    t.seatTables()
    expect(t.tableIds).toHaveLength(1)
  })
})

describe('blindLevel getter', () => {
  it('returns 1 at the start of the tournament', () => {
    const t = new Tournament(BASE_CONFIG)
    expect(t.blindLevel).toBe(1)
  })

  it('increments after enough hands are played', async () => {
    const cfg: TournamentConfig = {
      ...BASE_CONFIG,
      blindLevels: [
        { smallBlind: 10, bigBlind: 20, handsPerLevel: 1 },
        { smallBlind: 20, bigBlind: 40, handsPerLevel: 99 },
      ],
    }
    const t = new Tournament(cfg)
    t.seatTables()
    expect(t.blindLevel).toBe(1)
    await t.playHand('table-1', alwaysFold)
    expect(t.blindLevel).toBe(2)
  })
})

describe('rebalance()', () => {
  it('does not re-seat when active tables have 2+ players each', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    const idsBefore = [...t.tableIds]
    t.rebalance()
    expect(t.tableIds).toEqual(idsBefore)
  })

  it('consolidates tables when each has only 1 active player left', () => {
    const cfg: TournamentConfig = {
      ...BASE_CONFIG,
      players: [
        { id: 'p1', name: 'P1' },
        { id: 'p2', name: 'P2' },
        { id: 'p3', name: 'P3' },
        { id: 'p4', name: 'P4' },
      ],
      tableSizes: 2,
    }
    const t = new Tournament(cfg)
    t.seatTables()
    expect(t.tableIds).toHaveLength(2)
    // seatTables distributes round-robin: table-1=[p1,p3], table-2=[p2,p4]
    // Eliminate one player from each table so each table has exactly 1 active
    ;(t as any).players.get('p3').eliminated = true  // removes from table-1
    ;(t as any).players.get('p4').eliminated = true  // removes from table-2

    t.rebalance()
    expect(t.tableIds).toHaveLength(1)
  })

  it('does not throw when tournament is finished', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    ;(t as any).players.forEach((p: any) => {
      if (p.id !== 'p1') { p.eliminated = true; p.stack = 0 }
    })
    expect(() => t.rebalance()).not.toThrow()
  })
})

describe('awardBonus', () => {
  it('adds chips to an active player', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    const before = t.standings.find(p => p.id === 'p1')!.stack
    t.awardBonus('p1', 250)
    expect(t.standings.find(p => p.id === 'p1')!.stack).toBe(before + 250)
  })

  it('does nothing for an eliminated player', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    ;(t as any).players.get('p2').eliminated = true
    ;(t as any).players.get('p2').stack = 0
    const before = t.standings.find(p => p.id === 'p2')!.stack
    t.awardBonus('p2', 250)
    expect(t.standings.find(p => p.id === 'p2')!.stack).toBe(before)
  })

  it('does nothing for an unknown player id', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    expect(() => t.awardBonus('ghost', 250)).not.toThrow()
  })
})

describe('getTableActivePlayers / getTableWinner', () => {
  it('getTableActivePlayers returns empty array for unknown table', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    expect(t.getTableActivePlayers('table-99')).toEqual([])
  })

  it('getTableActivePlayers returns all players at a fresh table', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    const ids = t.getTableActivePlayers('table-1').map(p => p.id)
    expect(ids).toEqual(['p1', 'p2', 'p3'])
  })

  it('getTableActivePlayers excludes eliminated players', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    ;(t as any).players.get('p2').eliminated = true
    const ids = t.getTableActivePlayers('table-1').map(p => p.id)
    expect(ids).toEqual(['p1', 'p3'])
  })

  it('getTableWinner returns null when multiple players active', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    expect(t.getTableWinner('table-1')).toBeNull()
  })

  it('getTableWinner returns null for unknown table', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    expect(t.getTableWinner('table-99')).toBeNull()
  })

  it('getTableWinner returns the sole surviving player', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    ;(t as any).players.get('p2').eliminated = true
    ;(t as any).players.get('p3').eliminated = true
    const winner = t.getTableWinner('table-1')
    expect(winner).not.toBeNull()
    expect(winner!.id).toBe('p1')
  })
})

describe('dealer button rotation', () => {
  it('should start with dealerIndex 0', () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    expect(getTableState(t).dealerIndex).toBe(0)
  })

  it('should advance dealerIndex by 1 after each hand', async () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()

    await t.playHand('table-1', alwaysFold)
    expect(getTableState(t).dealerIndex).toBe(1)

    await t.playHand('table-1', alwaysFold)
    expect(getTableState(t).dealerIndex).toBe(2)
  })

  it('should wrap dealerIndex back to 0 after a full rotation', async () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()
    const n = getTableState(t).playerIds.length  // 3

    for (let i = 0; i < n; i++) {
      await t.playHand('table-1', alwaysFold)
    }

    expect(getTableState(t).dealerIndex).toBe(0)
  })

  it('should pass the correct dealerIndex to the game state', async () => {
    const t = new Tournament(BASE_CONFIG)
    t.seatTables()

    const capturedDealerIndices: number[] = []
    let actionsThisHand = 0

    const capturingFold: ActionRequestor = async (_tableId, _playerId, state) => {
      if (actionsThisHand === 0) capturedDealerIndices.push(state.dealerIndex)
      actionsThisHand++
      return { type: ActionType.FOLD }
    }

    actionsThisHand = 0
    await t.playHand('table-1', capturingFold)
    actionsThisHand = 0
    await t.playHand('table-1', capturingFold)
    actionsThisHand = 0
    await t.playHand('table-1', capturingFold)

    expect(capturedDealerIndices).toEqual([0, 1, 2])
  })
})

describe('all-in runout', () => {
  const alwaysCall: ActionRequestor = async () => ({ type: ActionType.CALL })

  it('completes without throwing when BB is immediately all-in and SB calls', async () => {
    // BB posts 20 and has no chips left; SB must call to complete betting.
    // Without the fix this crashes with "Need at least 5 cards".
    const cfg: TournamentConfig = {
      ...BASE_CONFIG,
      players: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }],
      startingStack: 20, // exactly the big blind → BB is immediately all-in
      blindLevels: [{ smallBlind: 5, bigBlind: 20, handsPerLevel: 99 }],
    }
    const t = new Tournament(cfg)
    t.seatTables()
    await expect(t.playHand('table-1', alwaysCall)).resolves.not.toThrow()
  })

  it('completes when all players go all-in preflop', async () => {
    // All three players call/raise all-in before any community cards are dealt.
    const cfg: TournamentConfig = {
      ...BASE_CONFIG,
      players: [
        { id: 'p1', name: 'Alice' },
        { id: 'p2', name: 'Bob' },
        { id: 'p3', name: 'Carol' },
      ],
      startingStack: 20,
      blindLevels: [{ smallBlind: 5, bigBlind: 20, handsPerLevel: 99 }],
    }
    const t = new Tournament(cfg)
    t.seatTables()
    const results = await t.playHand('table-1', alwaysCall)
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('conserves total chips across an all-in hand', async () => {
    const cfg: TournamentConfig = {
      ...BASE_CONFIG,
      players: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }],
      startingStack: 100,
      blindLevels: [{ smallBlind: 10, bigBlind: 20, handsPerLevel: 99 }],
    }
    const t = new Tournament(cfg)
    t.seatTables()
    const totalBefore = t.standings.reduce((s, p) => s + p.stack, 0)

    // Drive both players all-in
    const alwaysRaiseAllIn: ActionRequestor = async (_tableId, _playerId, state) => {
      const me = state.players.find(p => p.id === _playerId)!
      if (state.validActions.includes('RAISE')) return { type: ActionType.RAISE, amount: me.stack + me.bet }
      return { type: ActionType.CALL }
    }

    await t.playHand('table-1', alwaysRaiseAllIn)
    const totalAfter = t.standings.reduce((s, p) => s + p.stack, 0)
    expect(totalAfter).toBe(totalBefore)
  })
})
