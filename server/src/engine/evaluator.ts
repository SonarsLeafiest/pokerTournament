import type { Card, Rank } from './card.js'

export enum HandRank {
  HIGH_CARD = 1,
  ONE_PAIR = 2,
  TWO_PAIR = 3,
  THREE_OF_A_KIND = 4,
  STRAIGHT = 5,
  FLUSH = 6,
  FULL_HOUSE = 7,
  FOUR_OF_A_KIND = 8,
  STRAIGHT_FLUSH = 9,
}

export interface HandResult {
  rank: HandRank
  // Numeric value for direct comparison — higher always wins
  value: number
}

// Encode up to 6 rank values (4 bits each) into a single number beneath
// a hand-rank prefix. Supports tiebreaking for all hand types.
function encodeValue(handRank: HandRank, ...rankValues: number[]): number {
  let v = handRank * 16 ** 6
  for (let i = 0; i < rankValues.length; i++) {
    v += rankValues[i] * 16 ** (5 - i)
  }
  return v
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]]
  if (arr.length < k) return []
  const [first, ...rest] = arr
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c])
  const withoutFirst = combinations(rest, k)
  return [...withFirst, ...withoutFirst]
}

function evaluate5(hand: Card[]): HandResult {
  const ranks = hand.map(c => c.rank).sort((a, b) => b - a) as number[]
  const suits = hand.map(c => c.suit)

  const isFlush = suits.every(s => s === suits[0])

  // Check straight (including wheel: A-2-3-4-5)
  const isStraight = (rs: number[]): number | false => {
    const sorted = [...new Set(rs)].sort((a, b) => b - a)
    if (sorted.length === 5 && sorted[0] - sorted[4] === 4) return sorted[0]
    // Wheel: A-2-3-4-5 — treat Ace as 1
    if (sorted[0] === 14 && sorted[1] === 5 && sorted[2] === 4 && sorted[3] === 3 && sorted[4] === 2) return 5
    return false
  }

  const straightHigh = isStraight(ranks)

  if (isFlush && straightHigh !== false) {
    return { rank: HandRank.STRAIGHT_FLUSH, value: encodeValue(HandRank.STRAIGHT_FLUSH, straightHigh) }
  }

  // Count rank frequencies
  const freq: Map<number, number> = new Map()
  for (const r of ranks) freq.set(r, (freq.get(r) ?? 0) + 1)
  const groups = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const counts = groups.map(g => g[1])
  const ranksByCount = groups.map(g => g[0])

  if (counts[0] === 4) {
    return { rank: HandRank.FOUR_OF_A_KIND, value: encodeValue(HandRank.FOUR_OF_A_KIND, ranksByCount[0], ranksByCount[1]) }
  }

  if (counts[0] === 3 && counts[1] === 2) {
    return { rank: HandRank.FULL_HOUSE, value: encodeValue(HandRank.FULL_HOUSE, ranksByCount[0], ranksByCount[1]) }
  }

  if (isFlush) {
    return { rank: HandRank.FLUSH, value: encodeValue(HandRank.FLUSH, ...ranks) }
  }

  if (straightHigh !== false) {
    return { rank: HandRank.STRAIGHT, value: encodeValue(HandRank.STRAIGHT, straightHigh) }
  }

  if (counts[0] === 3) {
    return { rank: HandRank.THREE_OF_A_KIND, value: encodeValue(HandRank.THREE_OF_A_KIND, ranksByCount[0], ranksByCount[1], ranksByCount[2]) }
  }

  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = ranksByCount.slice(0, 2).sort((a, b) => b - a)
    const kicker = ranksByCount[2]
    return { rank: HandRank.TWO_PAIR, value: encodeValue(HandRank.TWO_PAIR, pairs[0], pairs[1], kicker) }
  }

  if (counts[0] === 2) {
    return { rank: HandRank.ONE_PAIR, value: encodeValue(HandRank.ONE_PAIR, ranksByCount[0], ranksByCount[1], ranksByCount[2], ranksByCount[3]) }
  }

  return { rank: HandRank.HIGH_CARD, value: encodeValue(HandRank.HIGH_CARD, ...ranks) }
}

export function evaluateHand(cards: Card[]): HandResult {
  if (cards.length < 5) throw new Error(`Need at least 5 cards, got ${cards.length}`)
  const combos = combinations(cards, 5)
  return combos.map(evaluate5).reduce((best, curr) => curr.value > best.value ? curr : best)
}

export function compareHands(a: HandResult, b: HandResult): number {
  return a.value - b.value
}
