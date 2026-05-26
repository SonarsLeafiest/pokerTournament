import { describe, it, expect } from 'vitest'
import { evaluateHand, compareHands, HandRank } from './evaluator.js'
import { stringToCard } from './card.js'

const cards = (strs: string[]) => strs.map(stringToCard)

describe('evaluateHand', () => {
  describe('high card', () => {
    it('should identify a high card hand', () => {
      const hand = evaluateHand(cards(['As', 'Kh', 'Jd', '8c', '5s', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.HIGH_CARD)
    })
  })

  describe('one pair', () => {
    it('should identify a pair', () => {
      const hand = evaluateHand(cards(['As', 'Ah', 'Kd', 'Qc', 'Js', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.ONE_PAIR)
    })
  })

  describe('two pair', () => {
    it('should identify two pair', () => {
      const hand = evaluateHand(cards(['As', 'Ah', 'Kd', 'Kc', 'Js', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.TWO_PAIR)
    })
  })

  describe('three of a kind', () => {
    it('should identify trips', () => {
      const hand = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Js', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.THREE_OF_A_KIND)
    })
  })

  describe('straight', () => {
    it('should identify a broadway straight (A-K-Q-J-T)', () => {
      const hand = evaluateHand(cards(['As', 'Kh', 'Qd', 'Jc', 'Ts', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.STRAIGHT)
    })

    it('should identify a mid straight', () => {
      const hand = evaluateHand(cards(['9s', '8h', '7d', '6c', '5s', 'Kh', '2d']))
      expect(hand.rank).toBe(HandRank.STRAIGHT)
    })

    it('should identify a wheel straight (A-2-3-4-5)', () => {
      const hand = evaluateHand(cards(['As', '2h', '3d', '4c', '5s', 'Kh', '9d']))
      expect(hand.rank).toBe(HandRank.STRAIGHT)
    })

    it('should NOT treat A-K-Q-J-9 as a straight', () => {
      const hand = evaluateHand(cards(['As', 'Kh', 'Qd', 'Jc', '9s', '3h', '2d']))
      expect(hand.rank).not.toBe(HandRank.STRAIGHT)
    })
  })

  describe('flush', () => {
    it('should identify a flush', () => {
      const hand = evaluateHand(cards(['As', 'Ks', 'Qs', 'Js', '9s', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.FLUSH)
    })

    it('should pick the best 5 cards for a flush from 7', () => {
      const hand = evaluateHand(cards(['As', 'Ks', 'Qs', 'Js', '9s', '3s', '2d']))
      expect(hand.rank).toBe(HandRank.FLUSH)
      expect(hand.value).toBeGreaterThan(
        evaluateHand(cards(['As', 'Ks', 'Qs', 'Js', '3s', '2s', '7d'])).value
      )
    })
  })

  describe('full house', () => {
    it('should identify a full house', () => {
      const hand = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Ks', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.FULL_HOUSE)
    })

    it('should pick the best full house when multiple are possible', () => {
      // AAA-KK beats AAA-QQ
      const aaakk = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Ks', 'Qh', 'Qd']))
      const aaaqq = evaluateHand(cards(['As', 'Ah', 'Ad', 'Qc', 'Qs', '3h', '2d']))
      expect(aaakk.value).toBeGreaterThan(aaaqq.value)
    })
  })

  describe('four of a kind', () => {
    it('should identify quads', () => {
      const hand = evaluateHand(cards(['As', 'Ah', 'Ad', 'Ac', 'Ks', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.FOUR_OF_A_KIND)
    })
  })

  describe('straight flush', () => {
    it('should identify a straight flush', () => {
      const hand = evaluateHand(cards(['9s', '8s', '7s', '6s', '5s', 'Kh', '2d']))
      expect(hand.rank).toBe(HandRank.STRAIGHT_FLUSH)
    })

    it('should identify a royal flush as a straight flush', () => {
      const hand = evaluateHand(cards(['As', 'Ks', 'Qs', 'Js', 'Ts', '3h', '2d']))
      expect(hand.rank).toBe(HandRank.STRAIGHT_FLUSH)
    })

    it('should identify a steel wheel (A-2-3-4-5 suited)', () => {
      const hand = evaluateHand(cards(['As', '2s', '3s', '4s', '5s', 'Kh', '9d']))
      expect(hand.rank).toBe(HandRank.STRAIGHT_FLUSH)
    })
  })

  describe('hand ranking hierarchy', () => {
    it('straight flush beats four of a kind', () => {
      const sf = evaluateHand(cards(['9s', '8s', '7s', '6s', '5s', 'Kh', '2d']))
      const quads = evaluateHand(cards(['As', 'Ah', 'Ad', 'Ac', 'Ks', '3h', '2d']))
      expect(sf.value).toBeGreaterThan(quads.value)
    })

    it('four of a kind beats full house', () => {
      const quads = evaluateHand(cards(['As', 'Ah', 'Ad', 'Ac', 'Ks', '3h', '2d']))
      const fh = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Ks', '3h', '2d']))
      expect(quads.value).toBeGreaterThan(fh.value)
    })

    it('full house beats flush', () => {
      const fh = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Ks', '3h', '2d']))
      const flush = evaluateHand(cards(['As', 'Ks', 'Qs', 'Js', '9s', '3h', '2d']))
      expect(fh.value).toBeGreaterThan(flush.value)
    })

    it('flush beats straight', () => {
      const flush = evaluateHand(cards(['As', 'Ks', 'Qs', 'Js', '9s', '3h', '2d']))
      const straight = evaluateHand(cards(['As', 'Kh', 'Qd', 'Jc', 'Ts', '3h', '2d']))
      expect(flush.value).toBeGreaterThan(straight.value)
    })

    it('straight beats three of a kind', () => {
      const straight = evaluateHand(cards(['As', 'Kh', 'Qd', 'Jc', 'Ts', '3h', '2d']))
      const trips = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Js', '3h', '2d']))
      expect(straight.value).toBeGreaterThan(trips.value)
    })

    it('three of a kind beats two pair', () => {
      const trips = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Js', '3h', '2d']))
      const twoPair = evaluateHand(cards(['As', 'Ah', 'Kd', 'Kc', 'Js', '3h', '2d']))
      expect(trips.value).toBeGreaterThan(twoPair.value)
    })

    it('two pair beats one pair', () => {
      const twoPair = evaluateHand(cards(['As', 'Ah', 'Kd', 'Kc', 'Js', '3h', '2d']))
      const onePair = evaluateHand(cards(['As', 'Ah', 'Kd', 'Qc', 'Js', '3h', '2d']))
      expect(twoPair.value).toBeGreaterThan(onePair.value)
    })

    it('one pair beats high card', () => {
      const onePair = evaluateHand(cards(['As', 'Ah', 'Kd', 'Qc', 'Js', '3h', '2d']))
      const highCard = evaluateHand(cards(['As', 'Kh', 'Jd', '8c', '5s', '3h', '2d']))
      expect(onePair.value).toBeGreaterThan(highCard.value)
    })
  })

  describe('kicker tiebreakers', () => {
    it('higher pair wins over lower pair', () => {
      const pairAces = evaluateHand(cards(['As', 'Ah', 'Kd', 'Qc', 'Js', '3h', '2d']))
      const pairKings = evaluateHand(cards(['Ks', 'Kh', 'Ad', 'Qc', 'Js', '3h', '2d']))
      expect(pairAces.value).toBeGreaterThan(pairKings.value)
    })

    it('same pair, higher kicker wins', () => {
      const pairAcesKicker = evaluateHand(cards(['As', 'Ah', 'Kd', 'Qc', 'Js', '3h', '2d']))
      const pairAcesLower = evaluateHand(cards(['As', 'Ah', 'Qd', 'Jc', '9s', '3h', '2d']))
      expect(pairAcesKicker.value).toBeGreaterThan(pairAcesLower.value)
    })

    it('identical hands return equal values (split pot scenario)', () => {
      const hand1 = evaluateHand(cards(['As', 'Kh', 'Qd', 'Jc', 'Ts', '3h', '2d']))
      const hand2 = evaluateHand(cards(['Ah', 'Kd', 'Qc', 'Js', 'Tc', '4h', '5d']))
      expect(hand1.value).toBe(hand2.value)
    })
  })
})

describe('compareHands', () => {
  it('should return positive when first hand wins', () => {
    const winner = evaluateHand(cards(['As', 'Ah', 'Ad', 'Ac', 'Ks', '3h', '2d']))
    const loser = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Ks', '3h', '2d']))
    expect(compareHands(winner, loser)).toBeGreaterThan(0)
  })

  it('should return negative when first hand loses', () => {
    const loser = evaluateHand(cards(['As', 'Ah', 'Ad', 'Kc', 'Ks', '3h', '2d']))
    const winner = evaluateHand(cards(['As', 'Ah', 'Ad', 'Ac', 'Ks', '3h', '2d']))
    expect(compareHands(loser, winner)).toBeLessThan(0)
  })

  it('should return 0 for tied hands', () => {
    const hand1 = evaluateHand(cards(['As', 'Kh', 'Qd', 'Jc', 'Ts', '3h', '2d']))
    const hand2 = evaluateHand(cards(['Ah', 'Kd', 'Qc', 'Js', 'Tc', '4h', '5d']))
    expect(compareHands(hand1, hand2)).toBe(0)
  })
})
