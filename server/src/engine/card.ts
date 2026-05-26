export type Suit = 'c' | 'd' | 'h' | 's'
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14

export interface Card {
  rank: Rank
  suit: Suit
}

export const SUITS: Suit[] = ['c', 'd', 'h', 's']
export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

const RANK_DISPLAY: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
}

const DISPLAY_RANK: Record<string, Rank> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
}

export function cardToString(card: Card): string {
  return `${RANK_DISPLAY[card.rank]}${card.suit}`
}

export function stringToCard(s: string): Card {
  if (s.length !== 2) throw new Error(`Invalid card: "${s}"`)
  const rankChar = s[0]
  const suit = s[1] as Suit
  const rank = DISPLAY_RANK[rankChar]
  if (rank === undefined) throw new Error(`Invalid rank: "${rankChar}"`)
  if (!SUITS.includes(suit)) throw new Error(`Invalid suit: "${suit}"`)
  return { rank, suit }
}

export function createDeck(): Card[] {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit })))
}

export function shuffleDeck(deck: Card[], seeds: number[]): Card[] {
  const result = [...deck]
  // Seeded Fisher-Yates using the provided seed values as entropy
  // Build an LCG seeded from the quantum values
  let state = seeds.reduce((acc, v) => (acc ^ v) >>> 0, 0)
  const rand = (): number => {
    state = Math.imul(1664525, state) + 1013904223
    state = state >>> 0
    return state / 0x100000000
  }

  // Mix all seed values into the LCG state before use
  for (const s of seeds) {
    state = (state ^ s) >>> 0
    rand()
  }

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }

  return result
}
