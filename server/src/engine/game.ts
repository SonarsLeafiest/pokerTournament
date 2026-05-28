import { type Card, createDeck, shuffleDeck } from './card.js'
import { evaluateHand, compareHands } from './evaluator.js'
import { buildSidePots } from './sidepot.js'

export enum GameStage {
  PRE_FLOP = 'PRE_FLOP',
  FLOP = 'FLOP',
  TURN = 'TURN',
  RIVER = 'RIVER',
  SHOWDOWN = 'SHOWDOWN',
}

export enum ActionType {
  FOLD = 'FOLD',
  CHECK = 'CHECK',
  CALL = 'CALL',
  RAISE = 'RAISE',
}

export interface Action {
  type: ActionType
  amount?: number
}

export interface Player {
  id: string
  stack: number
  holeCards: Card[]
  bet: number   // chips put in during the current betting round
  folded: boolean
  allIn: boolean
}

export interface ShowdownResult {
  playerId: string
  amount: number
}

export interface GameState {
  players: Player[]
  deck: Card[]
  communityCards: Card[]
  pot: number
  stage: GameStage
  dealerIndex: number
  actionIndex: number
  currentBet: number   // highest bet this round
  lastRaiseSize: number
  contributions: Record<string, number>  // cumulative chips each player has put in
}

export interface CreateGameOptions {
  playerIds: string[]
  startingStack?: number
  playerStacks?: Record<string, number>
  smallBlind: number
  bigBlind: number
  seeds: number[]
  dealerIndex?: number
}

export function createGame(opts: CreateGameOptions): GameState {
  const { playerIds, smallBlind, bigBlind, seeds } = opts
  if (playerIds.length < 2) throw new Error('Need at least 2 players')
  if (!opts.startingStack && !opts.playerStacks) throw new Error('Provide startingStack or playerStacks')

  const deck = shuffleDeck(createDeck(), seeds)

  const players: Player[] = playerIds.map(id => {
    const stack = opts.playerStacks?.[id] ?? opts.startingStack ?? 0
    return { id, stack, holeCards: [], bet: 0, folded: false, allIn: stack === 0 }
  })

  const dealerIndex = opts.dealerIndex ?? 0
  const sbIndex = (dealerIndex + 1) % players.length
  const bbIndex = (dealerIndex + 2) % players.length

  postBlind(players[sbIndex], smallBlind)
  postBlind(players[bbIndex], bigBlind)

  // Seed contributions from blind posts
  const contributions: Record<string, number> = {}
  for (const p of players) {
    if (p.bet > 0) contributions[p.id] = p.bet
  }

  return {
    players,
    deck,
    communityCards: [],
    pot: smallBlind + bigBlind,
    stage: GameStage.PRE_FLOP,
    dealerIndex,
    actionIndex: (bbIndex + 1) % players.length,
    currentBet: bigBlind,
    lastRaiseSize: bigBlind,
    contributions,
  }
}

function postBlind(player: Player, amount: number): void {
  const paid = Math.min(amount, player.stack)
  player.stack -= paid
  player.bet += paid
  if (player.stack === 0) player.allIn = true
}

export function dealHands(state: GameState): GameState {
  const players = state.players.map(p => ({ ...p, holeCards: [] as Card[] }))
  const deck = [...state.deck]

  // Deal 2 cards to each active player
  for (let round = 0; round < 2; round++) {
    for (const player of players) {
      player.holeCards.push(deck.shift()!)
    }
  }

  return { ...state, players, deck }
}

export function dealFlop(state: GameState): GameState {
  const deck = [...state.deck]
  deck.shift() // burn
  const communityCards = [...state.communityCards, deck.shift()!, deck.shift()!, deck.shift()!]
  return { ...state, deck, communityCards }
}

export function dealTurn(state: GameState): GameState {
  const deck = [...state.deck]
  deck.shift() // burn
  const communityCards = [...state.communityCards, deck.shift()!]
  return { ...state, deck, communityCards }
}

export function dealRiver(state: GameState): GameState {
  const deck = [...state.deck]
  deck.shift() // burn
  const communityCards = [...state.communityCards, deck.shift()!]
  return { ...state, deck, communityCards }
}

export function applyAction(state: GameState, playerId: string, action: Action): GameState {
  if (action.type === ActionType.RAISE) {
    if (action.amount == null || !Number.isFinite(action.amount) || action.amount < 0) {
      throw new Error(`Invalid raise amount: ${action.amount}`)
    }
  }

  const actingPlayer = state.players[state.actionIndex]
  if (actingPlayer.id !== playerId) {
    throw new Error(`It is not ${playerId}'s turn (expected ${actingPlayer.id})`)
  }

  let players = state.players.map(p => ({ ...p }))
  const actor = players[state.actionIndex]
  let pot = state.pot
  let currentBet = state.currentBet
  let lastRaiseSize = state.lastRaiseSize
  const contributions = { ...state.contributions }

  switch (action.type) {
    case ActionType.FOLD:
      actor.folded = true
      break

    case ActionType.CHECK:
      if (actor.bet < currentBet) throw new Error('Cannot check when there is a bet to call')
      break

    case ActionType.CALL: {
      const toCall = Math.min(currentBet - actor.bet, actor.stack)
      actor.stack -= toCall
      actor.bet += toCall
      pot += toCall
      if (actor.stack === 0) actor.allIn = true
      contributions[actor.id] = (contributions[actor.id] ?? 0) + toCall
      break
    }

    case ActionType.RAISE: {
      const totalBet = Math.min(action.amount ?? 0, actor.stack + actor.bet)
      const raiseSize = totalBet - currentBet
      const minRaise = currentBet + lastRaiseSize
      if (totalBet < minRaise && actor.stack + actor.bet > minRaise) {
        throw new Error(`Raise must be at least ${minRaise} (min raise: ${lastRaiseSize})`)
      }
      const chips = totalBet - actor.bet
      actor.stack -= chips
      pot += chips
      actor.bet = totalBet
      if (actor.stack === 0) actor.allIn = true
      lastRaiseSize = Math.max(raiseSize, lastRaiseSize)
      currentBet = totalBet
      contributions[actor.id] = (contributions[actor.id] ?? 0) + chips
      break
    }
  }

  const activePlayers = players.filter(p => !p.folded)

  // If only one player remains, go straight to showdown
  if (activePlayers.length === 1) {
    return { ...state, players, pot, currentBet, lastRaiseSize, contributions, stage: GameStage.SHOWDOWN }
  }

  // Advance to next player who can still act
  const nextIndex = nextActingIndex(players, state.actionIndex)

  // Check if the betting round is over
  if (isBettingRoundComplete(players, currentBet)) {
    return advanceStage({ ...state, players, pot, currentBet, lastRaiseSize, contributions, actionIndex: nextIndex })
  }

  return { ...state, players, pot, currentBet, lastRaiseSize, contributions, actionIndex: nextIndex }
}

function nextActingIndex(players: Player[], fromIndex: number): number {
  let idx = (fromIndex + 1) % players.length
  while (players[idx].folded || players[idx].allIn) {
    idx = (idx + 1) % players.length
    if (idx === fromIndex) break
  }
  return idx
}

function isBettingRoundComplete(players: Player[], currentBet: number): boolean {
  const active = players.filter(p => !p.folded && !p.allIn)
  return active.every(p => p.bet === currentBet)
}

function advanceStage(state: GameState): GameState {
  // Reset per-round bets
  const players = state.players.map(p => ({ ...p, bet: 0 }))
  // Action starts left of dealer after pre-flop
  const actionIndex = nextActingIndex(players, state.dealerIndex)

  switch (state.stage) {
    case GameStage.PRE_FLOP:
      return dealFlop({ ...state, players, currentBet: 0, lastRaiseSize: 0, actionIndex, stage: GameStage.FLOP })
    case GameStage.FLOP:
      return dealTurn({ ...state, players, currentBet: 0, lastRaiseSize: 0, actionIndex, stage: GameStage.TURN })
    case GameStage.TURN:
      return dealRiver({ ...state, players, currentBet: 0, lastRaiseSize: 0, actionIndex, stage: GameStage.RIVER })
    case GameStage.RIVER:
      return { ...state, players, currentBet: 0, lastRaiseSize: 0, actionIndex, stage: GameStage.SHOWDOWN }
    default:
      return state
  }
}

/**
 * Deals all remaining community cards and advances to SHOWDOWN without
 * any further betting — used when all active players are all-in.
 * Safe to call at any stage; at SHOWDOWN it is a no-op.
 */
export function runOutBoard(state: GameState): GameState {
  let s = state
  if (s.stage === GameStage.PRE_FLOP) s = { ...dealFlop(s),  stage: GameStage.FLOP }
  if (s.stage === GameStage.FLOP)     s = { ...dealTurn(s),  stage: GameStage.TURN }
  if (s.stage === GameStage.TURN)     s = { ...dealRiver(s), stage: GameStage.RIVER }
  if (s.stage === GameStage.RIVER)    s = { ...s,            stage: GameStage.SHOWDOWN }
  return s
}

export function getShowdownWinners(state: GameState): ShowdownResult[] {
  const activePlayers = state.players.filter(p => !p.folded)

  if (activePlayers.length === 1) {
    return [{ playerId: activePlayers[0].id, amount: state.pot }]
  }

  const sidePots = buildSidePots(state.contributions)
  const winnings = new Map<string, number>()

  for (const pot of sidePots) {
    // Only non-folded players who contributed enough are eligible for this pot
    const eligible = activePlayers.filter(p => pot.eligiblePlayerIds.includes(p.id))
    if (eligible.length === 0) continue

    if (eligible.length === 1) {
      winnings.set(eligible[0].id, (winnings.get(eligible[0].id) ?? 0) + pot.amount)
      continue
    }

    const evaluated = eligible.map(p => ({
      player: p,
      result: evaluateHand([...p.holeCards, ...state.communityCards]),
    }))
    evaluated.sort((a, b) => compareHands(b.result, a.result))

    const best = evaluated[0].result
    const potWinners = evaluated.filter(e => compareHands(e.result, best) === 0)
    const share    = Math.floor(pot.amount / potWinners.length)
    const remainder = pot.amount - share * potWinners.length

    potWinners.forEach((w, i) => {
      winnings.set(w.player.id, (winnings.get(w.player.id) ?? 0) + share + (i === 0 ? remainder : 0))
    })
  }

  return [...winnings.entries()].map(([playerId, amount]) => ({ playerId, amount }))
}
