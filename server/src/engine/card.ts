import { createHash } from 'node:crypto'

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

  // Pack all seed values as uint32 big-endian into one buffer so the full
  // entropy is available (128 bits from 8×uint16 quantum values, 256 bits
  // from 8×uint32 crypto fallback — nothing collapses to 32-bit state).
  const seedBuf = Buffer.alloc(seeds.length * 4)
  seeds.forEach((v, i) => seedBuf.writeUInt32BE(v >>> 0, i * 4))

  // Counter-mode SHA-256 PRNG: H(seed || counter) — each 32-byte digest
  // yields 8 uint32 values before the counter increments.
  let block = Buffer.alloc(0)
  let blockOffset = 0
  let counter = 0

  const nextUint32 = (): number => {
    if (blockOffset + 4 > block.length) {
      const ctrBuf = Buffer.alloc(4)
      ctrBuf.writeUInt32BE(counter++, 0)
      block = createHash('sha256').update(seedBuf).update(ctrBuf).digest()
      blockOffset = 0
    }
    const v = block.readUInt32BE(blockOffset)
    blockOffset += 4
    return v
  }

  for (let i = result.length - 1; i > 0; i--) {
    const j = nextUint32() % (i + 1)
    ;[result[i], result[j]] = [result[j], result[i]]
  }

  return result
}
