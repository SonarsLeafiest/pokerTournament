import { describe, it, expect } from 'vitest'
import { buildSidePots, type SidePot } from './sidepot.js'

describe('buildSidePots', () => {
  it('should build a single pot when no player is all-in', () => {
    const contributions = { p1: 100, p2: 100, p3: 100 }
    const pots = buildSidePots(contributions)
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(300)
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p1', 'p2', 'p3'])
  })

  it('should build a side pot when one player is all-in for less', () => {
    // p1 is all-in for 50, p2 and p3 bet 100 each
    const contributions = { p1: 50, p2: 100, p3: 100 }
    const pots = buildSidePots(contributions)

    // Main pot: 50*3 = 150 (all 3 eligible)
    // Side pot: 50*2 = 100 (p2 and p3 only)
    expect(pots).toHaveLength(2)

    const mainPot = pots.find(p => p.eligiblePlayerIds.includes('p1'))!
    expect(mainPot.amount).toBe(150)
    expect(mainPot.eligiblePlayerIds.sort()).toEqual(['p1', 'p2', 'p3'])

    const sidePot = pots.find(p => !p.eligiblePlayerIds.includes('p1'))!
    expect(sidePot.amount).toBe(100)
    expect(sidePot.eligiblePlayerIds.sort()).toEqual(['p2', 'p3'])
  })

  it('should build multiple side pots for multiple all-in levels', () => {
    // p1 all-in for 30, p2 all-in for 70, p3 full for 100
    const contributions = { p1: 30, p2: 70, p3: 100 }
    const pots = buildSidePots(contributions)

    // Level 30: 30*3 = 90 (all eligible)
    // Level 70: (70-30)*2 = 80 (p2 and p3)
    // Level 100: (100-70)*1 = 30 (p3 only)
    expect(pots).toHaveLength(3)

    expect(pots[0].amount).toBe(90)
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p1', 'p2', 'p3'])

    expect(pots[1].amount).toBe(80)
    expect(pots[1].eligiblePlayerIds.sort()).toEqual(['p2', 'p3'])

    expect(pots[2].amount).toBe(30)
    expect(pots[2].eligiblePlayerIds).toEqual(['p3'])
  })

  it('should handle a single player (no contest)', () => {
    const pots = buildSidePots({ p1: 200 })
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(200)
    expect(pots[0].eligiblePlayerIds).toEqual(['p1'])
  })

  it('should total to the sum of all contributions', () => {
    const contributions = { p1: 45, p2: 120, p3: 120, p4: 80 }
    const pots = buildSidePots(contributions)
    const total = pots.reduce((sum, p) => sum + p.amount, 0)
    expect(total).toBe(45 + 120 + 120 + 80)
  })

  it('should handle all players contributing equally (single pot)', () => {
    const contributions = { p1: 200, p2: 200, p3: 200, p4: 200 }
    const pots = buildSidePots(contributions)
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(800)
  })
})
