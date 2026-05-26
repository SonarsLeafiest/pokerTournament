import { createGame, dealHands, applyAction, getShowdownWinners, GameStage, ActionType } from './game.js'
import type { GameState, Action } from './game.js'
import { fetchQuantumSeeds } from './rng.js'

export interface TournamentPlayer {
  id: string
  name: string
  stack: number
  eliminated: boolean
}

export interface BlindLevel {
  smallBlind: number
  bigBlind: number
  handsPerLevel: number
}

export interface TournamentConfig {
  players: { id: string; name: string }[]
  startingStack: number
  blindLevels: BlindLevel[]
  tableSizes: number      // max players per table
  actionTimeoutMs: number
}

export interface TableState {
  tableId: string
  gameState: GameState
  playerIds: string[]
  handNumber: number
}

// Called by the server loop to request an action from a specific player.
// Returns the action taken (fold on timeout/disconnect is handled by caller).
export type ActionRequestor = (
  tableId: string,
  playerId: string,
  gameState: GameState
) => Promise<Action>

export class Tournament {
  private players: Map<string, TournamentPlayer>
  private tables: Map<string, TableState> = new Map()
  private blindLevelIndex = 0
  private handsPlayedAtLevel = 0
  private handCount = 0

  constructor(private config: TournamentConfig) {
    this.players = new Map(
      config.players.map(p => [p.id, { ...p, stack: config.startingStack, eliminated: false }])
    )
  }

  get standings(): TournamentPlayer[] {
    return [...this.players.values()].sort((a, b) => b.stack - a.stack)
  }

  get activePlayers(): TournamentPlayer[] {
    return [...this.players.values()].filter(p => !p.eliminated)
  }

  get currentBlinds(): BlindLevel {
    return this.config.blindLevels[this.blindLevelIndex]
  }

  isFinished(): boolean {
    return this.activePlayers.length <= 1
  }

  seatTables(): void {
    const active = this.activePlayers.map(p => p.id)
    this.tables.clear()
    const tableCount = Math.ceil(active.length / this.config.tableSizes)
    for (let t = 0; t < tableCount; t++) {
      const seats = active.filter((_, i) => i % tableCount === t)
      this.tables.set(`table-${t + 1}`, {
        tableId: `table-${t + 1}`,
        gameState: {} as GameState,
        playerIds: seats,
        handNumber: 0,
      })
    }
  }

  async playHand(tableId: string, requestAction: ActionRequestor): Promise<void> {
    const table = this.tables.get(tableId)
    if (!table) throw new Error(`Unknown table: ${tableId}`)

    const seeds = await fetchQuantumSeeds(8).catch(() => fallbackSeeds())
    const blinds = this.currentBlinds

    const playerStacks = table.playerIds.map(id => ({
      id,
      stack: this.players.get(id)!.stack,
    }))

    let state = dealHands(
      createGame({
        playerIds: table.playerIds,
        startingStack: 0,  // overridden below
        smallBlind: blinds.smallBlind,
        bigBlind: blinds.bigBlind,
        seeds,
      })
    )

    // Apply actual stacks
    state = {
      ...state,
      players: state.players.map((p, i) => ({
        ...p,
        stack: playerStacks[i].stack - p.bet,
      })),
    }

    // Betting loop
    while (state.stage !== GameStage.SHOWDOWN) {
      if (state.players.filter(p => !p.folded && !p.allIn).length <= 1) break

      const actingPlayer = state.players[state.actionIndex]
      if (actingPlayer.folded || actingPlayer.allIn) {
        state = applyAction(state, actingPlayer.id, { type: ActionType.CALL })
        continue
      }

      let action: Action
      try {
        action = await requestAction(tableId, actingPlayer.id, state)
      } catch {
        // Timeout — auto fold
        action = { type: ActionType.FOLD }
      }

      state = applyAction(state, actingPlayer.id, action)
    }

    // Resolve winners and update stacks
    const results = getShowdownWinners(state)
    for (const player of this.players.values()) {
      const finalState = state.players.find(p => p.id === player.id)
      if (finalState) player.stack = finalState.stack
    }
    for (const result of results) {
      const player = this.players.get(result.playerId)
      if (player) player.stack += result.amount
    }

    // Mark eliminations
    for (const player of this.players.values()) {
      if (player.stack === 0) player.eliminated = true
    }

    table.handNumber++
    this.handCount++
    this.handsPlayedAtLevel++

    if (this.handsPlayedAtLevel >= blinds.handsPerLevel) {
      this.advanceBlinds()
    }

    table.gameState = state
  }

  private advanceBlinds(): void {
    if (this.blindLevelIndex < this.config.blindLevels.length - 1) {
      this.blindLevelIndex++
      this.handsPlayedAtLevel = 0
    }
  }
}

function fallbackSeeds(): number[] {
  const buf = new Uint32Array(8)
  crypto.getRandomValues(buf)
  return [...buf]
}
