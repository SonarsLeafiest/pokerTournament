import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SUITS,
  RANKS,
  cardToString,
  stringToCard,
  createDeck,
  shuffleDeck,
} from './card.js'

describe('card constants', () => {
  it('should have 4 suits', () => {
    expect(SUITS).toHaveLength(4)
    expect(SUITS).toContain('c')
    expect(SUITS).toContain('d')
    expect(SUITS).toContain('h')
    expect(SUITS).toContain('s')
  })

  it('should have 13 ranks', () => {
    expect(RANKS).toHaveLength(13)
    expect(RANKS[0]).toBe(2)
    expect(RANKS[12]).toBe(14)
  })
})

describe('cardToString', () => {
  it('should format a card as rank+suit', () => {
    expect(cardToString({ rank: 14, suit: 's' })).toBe('As')
    expect(cardToString({ rank: 13, suit: 'h' })).toBe('Kh')
    expect(cardToString({ rank: 12, suit: 'd' })).toBe('Qd')
    expect(cardToString({ rank: 11, suit: 'c' })).toBe('Jc')
    expect(cardToString({ rank: 10, suit: 's' })).toBe('Ts')
    expect(cardToString({ rank: 2, suit: 'h' })).toBe('2h')
  })
})

describe('stringToCard', () => {
  it('should parse a card string', () => {
    expect(stringToCard('As')).toEqual({ rank: 14, suit: 's' })
    expect(stringToCard('Kh')).toEqual({ rank: 13, suit: 'h' })
    expect(stringToCard('2c')).toEqual({ rank: 2, suit: 'c' })
    expect(stringToCard('Td')).toEqual({ rank: 10, suit: 'd' })
  })

  it('should throw on invalid card string', () => {
    expect(() => stringToCard('Xs')).toThrow()
    expect(() => stringToCard('Ax')).toThrow()
    expect(() => stringToCard('')).toThrow()
  })
})

describe('createDeck', () => {
  it('should create a full 52-card deck', () => {
    const deck = createDeck()
    expect(deck).toHaveLength(52)
  })

  it('should contain every rank/suit combination exactly once', () => {
    const deck = createDeck()
    const strings = deck.map(cardToString)
    const unique = new Set(strings)
    expect(unique.size).toBe(52)
  })
})

describe('shuffleDeck', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('should return a deck of the same 52 cards in a different order', () => {
    const deck = createDeck()
    const shuffled = shuffleDeck(deck, [12345, 54321, 11111, 22222])
    expect(shuffled).toHaveLength(52)
    const original = new Set(deck.map(cardToString))
    const result = new Set(shuffled.map(cardToString))
    expect(result).toEqual(original)
  })

  it('should produce a different order from the original', () => {
    const deck = createDeck()
    const shuffled = shuffleDeck(deck, [99999, 88888, 77777, 66666, 55555, 44444])
    const samePosition = deck.filter((c, i) => cardToString(c) === cardToString(shuffled[i]))
    expect(samePosition.length).toBeLessThan(52)
  })

  it('should produce deterministic results for the same seed', () => {
    const deck1 = createDeck()
    const deck2 = createDeck()
    const seeds = [111, 222, 333, 444]
    const shuffled1 = shuffleDeck(deck1, seeds)
    const shuffled2 = shuffleDeck(deck2, seeds)
    expect(shuffled1.map(cardToString)).toEqual(shuffled2.map(cardToString))
  })
})
