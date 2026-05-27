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
