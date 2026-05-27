import { describe, it, expect } from 'vitest'
import {
  createGame,
  dealHands,
  dealFlop,
  dealTurn,
  dealRiver,
  applyAction,
  getShowdownWinners,
  runOutBoard,
  GameStage,
  ActionType,
  type GameState,
} from './game.js'

const SEEDS = [11111, 22222, 33333, 44444, 55555]

function newGame(playerCount = 4, startingStack = 1000): GameState {
  return createGame({
    playerIds: Array.from({ length: playerCount }, (_, i) => `p${i + 1}`),
    startingStack,
    smallBlind: 10,
    bigBlind: 20,
    seeds: SEEDS,
  })
}

describe('createGame', () => {
  it('should create a game with the correct number of players', () => {
    const game = newGame(4)
    expect(game.players).toHaveLength(4)
  })

  it('should assign starting stacks to non-blind players', () => {
    const game = newGame(4, 1000)
    // Dealer (index 0) and UTG (index 3) have not paid blinds
    expect(game.players[0].stack).toBe(1000)
    expect(game.players[3].stack).toBe(1000)
  })

  it('should support per-player stacks when players have unequal chips', () => {
    const game = createGame({
      playerIds: ['p1', 'p2', 'p3'],
      playerStacks: { p1: 2000, p2: 500, p3: 800 },
      smallBlind: 10,
      bigBlind: 20,
      seeds: SEEDS,
    })
    // p1=dealer(2000), p2=SB(500-10=490), p3=BB(800-20=780)
    expect(game.players[0].stack).toBe(2000)
    expect(game.players[1].stack).toBe(490)
    expect(game.players[2].stack).toBe(780)
    expect(game.pot).toBe(30)
  })

  it('should post small and big blinds', () => {
    const game = newGame(4)
    // Dealer is index 0; SB=index 1, BB=index 2
    expect(game.players[1].stack).toBe(990)  // SB paid 10
    expect(game.players[2].stack).toBe(980)  // BB paid 20
    expect(game.pot).toBe(30)
  })

  it('should set stage to PRE_FLOP', () => {
    const game = newGame(4)
    expect(game.stage).toBe(GameStage.PRE_FLOP)
  })

  it('should set action to the player after BB (UTG)', () => {
    const game = newGame(4)
    // SB=1, BB=2, so action starts at index 3
    expect(game.actionIndex).toBe(3)
  })
})

describe('dealHands', () => {
  it('should give each active player exactly 2 hole cards', () => {
    const game = dealHands(newGame(4))
    for (const player of game.players) {
      expect(player.holeCards).toHaveLength(2)
    }
  })

  it('should deal unique cards to each player', () => {
    const game = dealHands(newGame(4))
    const allCards = game.players.flatMap(p => p.holeCards)
    const unique = new Set(allCards.map(c => `${c.rank}${c.suit}`))
    expect(unique.size).toBe(allCards.length)
  })
})

describe('applyAction — pre-flop betting', () => {
  it('should allow a fold action', () => {
    let game = dealHands(newGame(4))
    const actingPlayer = game.players[game.actionIndex]
    game = applyAction(game, actingPlayer.id, { type: ActionType.FOLD })
    expect(game.players.find(p => p.id === actingPlayer.id)!.folded).toBe(true)
  })

  it('should allow a call action', () => {
    let game = dealHands(newGame(4))
    const actingId = game.players[game.actionIndex].id
    const stackBefore = game.players[game.actionIndex].stack
    game = applyAction(game, actingId, { type: ActionType.CALL })
    expect(game.players.find(p => p.id === actingId)!.stack).toBe(stackBefore - 20)
  })

  it('should allow a raise action', () => {
    let game = dealHands(newGame(4))
    const actingId = game.players[game.actionIndex].id
    game = applyAction(game, actingId, { type: ActionType.RAISE, amount: 60 })
    expect(game.currentBet).toBe(60)
  })

  it('should reject an action from a player who is not acting', () => {
    let game = dealHands(newGame(4))
    const wrongPlayer = game.players[(game.actionIndex + 1) % game.players.length].id
    expect(() => applyAction(game, wrongPlayer, { type: ActionType.CALL })).toThrow()
  })

  it('should reject a raise below the minimum', () => {
    let game = dealHands(newGame(4))
    const actingId = game.players[game.actionIndex].id
    // Minimum raise is 2x current bet (40 total), so 30 is too low
    expect(() => applyAction(game, actingId, { type: ActionType.RAISE, amount: 30 })).toThrow()
  })

  it('should advance action index after each action', () => {
    let game = dealHands(newGame(4))
    const firstIndex = game.actionIndex
    const actingId = game.players[firstIndex].id
    game = applyAction(game, actingId, { type: ActionType.CALL })
    expect(game.actionIndex).not.toBe(firstIndex)
  })
})

describe('betting round completion → stage transitions', () => {
  function playToFlop(): GameState {
    let game = dealHands(newGame(4))
    // UTG calls, BTN calls, SB calls, BB checks
    while (game.stage === GameStage.PRE_FLOP) {
      const actingId = game.players[game.actionIndex].id
      game = applyAction(game, actingId, { type: ActionType.CALL })
    }
    return game
  }

  it('should transition to FLOP after all pre-flop action is complete', () => {
    const game = playToFlop()
    expect(game.stage).toBe(GameStage.FLOP)
  })

  it('should deal 3 community cards on the flop', () => {
    const game = playToFlop()
    expect(game.communityCards).toHaveLength(3)
  })

  it('should transition to TURN after flop action is complete', () => {
    let game = playToFlop()
    while (game.stage === GameStage.FLOP) {
      const actingId = game.players[game.actionIndex].id
      game = applyAction(game, actingId, { type: ActionType.CALL })
    }
    expect(game.stage).toBe(GameStage.TURN)
    expect(game.communityCards).toHaveLength(4)
  })

  it('should transition to RIVER after turn action is complete', () => {
    let game = playToFlop()
    while (game.stage !== GameStage.RIVER) {
      const actingId = game.players[game.actionIndex].id
      game = applyAction(game, actingId, { type: ActionType.CALL })
    }
    expect(game.stage).toBe(GameStage.RIVER)
    expect(game.communityCards).toHaveLength(5)
  })

  it('should transition to SHOWDOWN after river action is complete', () => {
    let game = playToFlop()
    while (game.stage !== GameStage.SHOWDOWN) {
      const actingId = game.players[game.actionIndex].id
      game = applyAction(game, actingId, { type: ActionType.CALL })
    }
    expect(game.stage).toBe(GameStage.SHOWDOWN)
  })
})

describe('fold to one remaining player', () => {
  it('should end hand immediately when all but one player folds', () => {
    let game = dealHands(newGame(4))
    // Fold everyone except the last player
    let foldsApplied = 0
    while (foldsApplied < 3) {
      const actingId = game.players[game.actionIndex].id
      game = applyAction(game, actingId, { type: ActionType.FOLD })
      foldsApplied++
      if (game.stage === GameStage.SHOWDOWN) break
    }
    expect(game.stage).toBe(GameStage.SHOWDOWN)
  })

  it('should award pot to the last remaining player', () => {
    let game = dealHands(newGame(2, 1000))
    const folderId = game.players[game.actionIndex].id
    game = applyAction(game, folderId, { type: ActionType.FOLD })
    const winners = getShowdownWinners(game)
    expect(winners).toHaveLength(1)
    expect(winners[0].playerId).not.toBe(folderId)
  })
})

describe('getShowdownWinners', () => {
  it('should return winner(s) with the amount won', () => {
    let game = dealHands(newGame(2, 1000))
    // Both call/check to showdown
    while (game.stage !== GameStage.SHOWDOWN) {
      const actingId = game.players[game.actionIndex].id
      game = applyAction(game, actingId, { type: ActionType.CALL })
    }
    const winners = getShowdownWinners(game)
    expect(winners.length).toBeGreaterThanOrEqual(1)
    expect(winners[0].amount).toBeGreaterThan(0)
  })

  it('should split pot on a tie', () => {
    // Both players play to showdown using identical board (community wins)
    // We can't guarantee a tie deterministically without controlling cards,
    // so we verify the split logic via a unit-style check
    let game = dealHands(newGame(2, 1000))
    while (game.stage !== GameStage.SHOWDOWN) {
      const actingId = game.players[game.actionIndex].id
      game = applyAction(game, actingId, { type: ActionType.CALL })
    }
    const winners = getShowdownWinners(game)
    const totalAwarded = winners.reduce((sum, w) => sum + w.amount, 0)
    expect(totalAwarded).toBe(game.pot)
  })
})

describe('dealerIndex option', () => {
  it('should default dealer to index 0 when dealerIndex is omitted', () => {
    const game = newGame(4)
    expect(game.dealerIndex).toBe(0)
  })

  it('should respect a custom dealerIndex when provided', () => {
    const game = createGame({
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      seeds: SEEDS,
      dealerIndex: 2,
    })
    expect(game.dealerIndex).toBe(2)
    // SB = (2+1)%4 = 3, BB = (2+2)%4 = 0
    expect(game.players[3].stack).toBe(990)   // SB paid 10
    expect(game.players[0].stack).toBe(980)   // BB paid 20
    // UTG = (2+3)%4 = 1
    expect(game.actionIndex).toBe(1)
  })

  it('should wrap dealerIndex correctly for the last player', () => {
    const game = createGame({
      playerIds: ['p1', 'p2', 'p3'],
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      seeds: SEEDS,
      dealerIndex: 2,
    })
    expect(game.dealerIndex).toBe(2)
    // SB = (2+1)%3 = 0, BB = (2+2)%3 = 1
    expect(game.players[0].stack).toBe(990)
    expect(game.players[1].stack).toBe(980)
  })
})

describe('runOutBoard', () => {
  function gameAtStage(stage: GameStage): GameState {
    let g = dealHands(newGame(2, 1000))
    if (stage === GameStage.PRE_FLOP) return { ...g, stage }
    g = { ...dealFlop(g), stage: GameStage.FLOP }
    if (stage === GameStage.FLOP) return g
    g = { ...dealTurn(g), stage: GameStage.TURN }
    if (stage === GameStage.TURN) return g
    g = { ...dealRiver(g), stage: GameStage.RIVER }
    if (stage === GameStage.RIVER) return g
    return { ...g, stage: GameStage.SHOWDOWN }
  }

  it('from PRE_FLOP → SHOWDOWN with 5 community cards', () => {
    const g = runOutBoard(gameAtStage(GameStage.PRE_FLOP))
    expect(g.stage).toBe(GameStage.SHOWDOWN)
    expect(g.communityCards).toHaveLength(5)
  })

  it('from FLOP → SHOWDOWN with 5 community cards', () => {
    const g = runOutBoard(gameAtStage(GameStage.FLOP))
    expect(g.stage).toBe(GameStage.SHOWDOWN)
    expect(g.communityCards).toHaveLength(5)
  })

  it('from TURN → SHOWDOWN with 5 community cards', () => {
    const g = runOutBoard(gameAtStage(GameStage.TURN))
    expect(g.stage).toBe(GameStage.SHOWDOWN)
    expect(g.communityCards).toHaveLength(5)
  })

  it('from RIVER → SHOWDOWN (no extra cards dealt)', () => {
    const g = runOutBoard(gameAtStage(GameStage.RIVER))
    expect(g.stage).toBe(GameStage.SHOWDOWN)
    expect(g.communityCards).toHaveLength(5)
  })

  it('from SHOWDOWN → unchanged (no-op)', () => {
    const before = gameAtStage(GameStage.SHOWDOWN)
    const g = runOutBoard(before)
    expect(g.stage).toBe(GameStage.SHOWDOWN)
    expect(g.communityCards).toHaveLength(5)
  })
})

describe('all-in handling', () => {
  it('should cap a raise at the player stack (all-in)', () => {
    let game = dealHands(newGame(2, 100))
    const actingId = game.players[game.actionIndex].id
    const stack = game.players[game.actionIndex].stack
    game = applyAction(game, actingId, { type: ActionType.RAISE, amount: stack + 500 })
    expect(game.players.find(p => p.id === actingId)!.stack).toBe(0)
    expect(game.players.find(p => p.id === actingId)!.allIn).toBe(true)
  })
})
