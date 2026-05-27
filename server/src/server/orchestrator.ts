import type { WebSocketHub } from './websocket.js'
import type { SpectatorState } from './spectator.js'
import type { LobbyState } from './http.js'
import type {
  ActionRequiredMsg, AgentActionMsg,
  HandResultMsg, TournamentUpdateMsg, TableStateMsg, TournamentCompleteMsg, TableWinnerMsg,
  BountyAnnouncedMsg, BountyClaimedMsg, BountyExpiredMsg, BountyInfo,
} from './protocol.js'
import { Tournament, type TournamentConfig, type ActionRequestor } from '../engine/tournament.js'
import { ActionType, type GameState } from '../engine/game.js'

const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'HJ', 'CO', 'MP']

function labelPosition(dealerIdx: number, playerIdx: number, total: number): string {
  const offset = (playerIdx - dealerIdx + total) % total
  return POSITIONS[offset] ?? `P${offset}`
}

function validActionsFor(state: GameState, playerIdx: number): ActionType[] {
  const p = state.players[playerIdx]
  const actions: ActionType[] = [ActionType.FOLD]
  if (p.bet >= state.currentBet) {
    actions.push(ActionType.CHECK)
  } else {
    actions.push(ActionType.CALL)
  }
  if (p.stack > state.currentBet - p.bet) actions.push(ActionType.RAISE)
  return actions
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface ActiveBounty {
  targetId:         string
  targetName:       string
  reward:           number
  expiresAfterHand: number
}

export interface OrchestratorOptions {
  hub:                WebSocketHub
  spectator:          SpectatorState
  turnDelayMs:        number
  actionTimeout:      number
  getLobbyState:      () => LobbyState
  setLobbyState:      (s: LobbyState) => void
  isAborted:          () => boolean
  bountyWindowHands:  number   // 0 = disabled
  bountyReward:       number
}

export class Orchestrator {
  private pendingActionMsgs = new Map<string, ActionRequiredMsg>()
  private activeBounty:    ActiveBounty | null = null
  private nextBountyAtHand: number             = 0

  constructor(private opts: OrchestratorOptions) {}

  /** Returns the last action_required message sent to a player (for reconnect replay). */
  getPendingAction(playerId: string): ActionRequiredMsg | undefined {
    return this.pendingActionMsgs.get(playerId)
  }

  async runTournament(config: TournamentConfig): Promise<void> {
    const { hub, spectator, getLobbyState, setLobbyState, isAborted } = this.opts

    spectator.resetBuffers()
    this.activeBounty    = null
    this.nextBountyAtHand = this.opts.bountyWindowHands > 0 ? this.opts.bountyWindowHands : Infinity

    const tournament = new Tournament(config)
    tournament.seatTables()

    let handNumber = 0

    while (!tournament.isFinished() && !isAborted()) {
      const tables = tournament.tableIds

      // Snapshot standings before the round so we can detect eliminations
      const standingsBefore = new Map(tournament.standings.map(p => [p.id, p.stack]))
      const targetWasActive = this.activeBounty
        ? tournament.activePlayers.some(p => p.id === this.activeBounty!.targetId)
        : false

      await Promise.all(tables.map(tableId => this.playHand(tournament, tableId, ++handNumber)))

      // Bounty resolution must happen before standings broadcast
      this.resolveBounty(tournament, handNumber, standingsBefore, targetWasActive)
      this.maybeAnnounceBounty(tournament, handNumber)

      tournament.rebalance()
      this.broadcastStandings(tournament, handNumber)
    }

    if (isAborted()) {
      console.log('\nTournament aborted — ready for reset')
      return
    }

    const standings = tournament.standings
    const winner    = standings[0]
    console.log(`\nTournament over! Winner: ${winner.name} (${winner.id}) with ${winner.stack} chips`)

    // Notify each agent of their final placement
    for (const [i, player] of standings.entries()) {
      hub.sendToAgent(player.id, {
        type:       'tournament_end',
        place:      i + 1,
        result:     i === 0 ? 'won' : 'lost',
        finalStack: player.stack,
      })
    }

    // Broadcast final result to spectators
    const completeMsg: TournamentCompleteMsg = {
      type:       'tournament_complete',
      winnerId:   winner.id,
      winnerName: winner.name,
      finalStack: winner.stack,
      standings:  standings.map((p, i) => ({
        playerId: p.id,
        name:     p.name,
        place:    i + 1,
        stack:    p.stack,
      })),
    }
    spectator.broadcast(completeMsg)

    await sleep(2000)
    hub.disconnectAll()
    setLobbyState('closed')
  }

  // ── Bounty helpers ──────────────────────────────────────────────────────────

  /**
   * Check whether the active bounty target was eliminated during the round that
   * just finished.  If so, award the reward to whoever gained the most chips at
   * their table and broadcast a bounty_claimed message.
   * Also expire the bounty if its window has closed without a claim.
   */
  private resolveBounty(
    tournament:     Tournament,
    handNumber:     number,
    standingsBefore: Map<string, number>,
    targetWasActive: boolean,
  ): void {
    const { spectator } = this.opts
    if (!this.activeBounty || !targetWasActive) return

    const bounty = this.activeBounty

    // Check if the target is now eliminated
    const targetNowEliminated = !tournament.activePlayers.some(p => p.id === bounty.targetId)
    if (targetNowEliminated) {
      // Find the eliminator: player with the largest positive stack delta
      let eliminatorId:   string | null = null
      let eliminatorName: string        = ''
      let maxGain                       = 0

      for (const player of tournament.standings) {
        if (player.id === bounty.targetId) continue
        const before = standingsBefore.get(player.id) ?? player.stack
        const gain   = player.stack - before
        if (gain > maxGain) {
          maxGain        = gain
          eliminatorId   = player.id
          eliminatorName = player.name
        }
      }

      if (eliminatorId) {
        tournament.awardBonus(eliminatorId, bounty.reward)
        const claimed: BountyClaimedMsg = {
          type:          'bounty_claimed',
          targetId:      bounty.targetId,
          targetName:    bounty.targetName,
          claimedById:   eliminatorId,
          claimedByName: eliminatorName,
          reward:        bounty.reward,
          handNumber,
        }
        spectator.broadcast(claimed)
        console.log(
          `[bounty] ${eliminatorName} eliminated ${bounty.targetName} and claimed ${bounty.reward} bonus chips!`
        )
      }

      this.activeBounty    = null
      this.nextBountyAtHand = handNumber + this.opts.bountyWindowHands
      return
    }

    // Check if the window has expired without a claim
    if (handNumber >= bounty.expiresAfterHand) {
      const expired: BountyExpiredMsg = {
        type:       'bounty_expired',
        targetId:   bounty.targetId,
        targetName: bounty.targetName,
        handNumber,
      }
      spectator.broadcast(expired)
      console.log(`[bounty] Bounty on ${bounty.targetName} expired unclaimed`)
      this.activeBounty    = null
      this.nextBountyAtHand = handNumber + this.opts.bountyWindowHands
    }
  }

  /** Announce a new bounty if enough hands have passed since the last one. */
  private maybeAnnounceBounty(tournament: Tournament, handNumber: number): void {
    if (this.activeBounty) return
    if (handNumber < this.nextBountyAtHand) return
    if (tournament.activePlayers.length < 2) return

    // Pick a random active player as the target
    const active = tournament.activePlayers
    const target = active[Math.floor(Math.random() * active.length)]

    const expiresAfterHand = handNumber + this.opts.bountyWindowHands
    this.activeBounty = {
      targetId:         target.id,
      targetName:       target.name,
      reward:           this.opts.bountyReward,
      expiresAfterHand,
    }

    const msg: BountyAnnouncedMsg = {
      type:             'bounty_announced',
      targetId:         target.id,
      targetName:       target.name,
      reward:           this.opts.bountyReward,
      expiresAfterHand,
      handNumber,
    }
    this.opts.spectator.broadcast(msg)
    console.log(
      `[bounty] 💰 BOUNTY on ${target.name} — ${this.opts.bountyReward} chips to whoever eliminates them before hand ${expiresAfterHand}`
    )
  }

  // ── Hand loop ───────────────────────────────────────────────────────────────

  private async playHand(
    tournament: Tournament,
    tableId:    string,
    handNumber: number,
  ): Promise<void> {
    const { hub, spectator, isAborted } = this.opts
    const lastActions = new Map<string, string>()

    const requestAction: ActionRequestor = async (tId, playerId, state) => {
      const playerIdx    = state.players.findIndex(p => p.id === playerId)
      const player       = state.players[playerIdx]
      const validActions = validActionsFor(state, playerIdx)

      // Build bounty info for this agent's action message
      const activeBountyInfo: BountyInfo | null = this.activeBounty
        ? {
            targetId:         this.activeBounty.targetId,
            targetName:       this.activeBounty.targetName,
            reward:           this.activeBounty.reward,
            expiresAfterHand: this.activeBounty.expiresAfterHand,
          }
        : null

      const msg: ActionRequiredMsg = {
        type:           'action_required',
        gameId:         tId,
        handNumber,
        stage:          state.stage,
        position:       labelPosition(state.dealerIndex, playerIdx, state.players.length),
        holeCards:      player.holeCards as ActionRequiredMsg['holeCards'],
        communityCards: state.communityCards,
        pot:            state.pot,
        myStack:        player.stack,
        myBet:          player.bet,
        currentBet:     state.currentBet,
        players:        state.players
          .filter(p => p.id !== playerId)
          .map(p => ({ id: p.id, stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn })),
        validActions,
        minRaise:       state.currentBet + state.lastRaiseSize,
        maxRaise:       player.stack,
        timeLimitMs:    this.opts.actionTimeout,
        activeBounty:   activeBountyInfo,
      }

      this.broadcastTableState(tId, handNumber, state, playerId, lastActions)
      if (!isAborted()) await sleep(this.opts.turnDelayMs)

      this.pendingActionMsgs.set(playerId, msg)
      hub.sendToAgent(playerId, msg)

      const response = await hub.waitForAction(playerId) as AgentActionMsg
      this.pendingActionMsgs.delete(playerId)

      const VALID_ACTIONS = ['FOLD', 'CHECK', 'CALL', 'RAISE']
      const action = (typeof response.action === 'string' && VALID_ACTIONS.includes(response.action.toUpperCase()))
        ? response.action.toUpperCase() as ActionType
        : ActionType.FOLD

      const rawAmount = response.amount
      const amount    = (typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount >= 0)
        ? Math.floor(rawAmount)
        : undefined

      if (!validActions.includes(action as ActionType)) {
        hub.sendToAgent(playerId, { type: 'error', message: `Invalid action: ${action}` })
        lastActions.set(playerId, ActionType.FOLD)
        return { type: ActionType.FOLD }
      }

      lastActions.set(playerId,
        action === ActionType.RAISE && amount != null ? `${action} ${amount}` : action)

      return { type: action as ActionType, amount }
    }

    const activeBefore = tournament.getTableActivePlayers(tableId)
    const stacksBefore = new Map(tournament.standings.map(p => [p.id, p.stack]))
    const winners      = await tournament.playHand(tableId, requestAction)
    const stacksAfter  = new Map(tournament.standings.map(p => [p.id, p.stack]))

    const deltas: Record<string, number> = {}
    for (const [id, before] of stacksBefore) {
      const after = stacksAfter.get(id) ?? before
      if (after !== before) deltas[id] = after - before
    }

    const resultMsg: HandResultMsg = {
      type:       'hand_result',
      gameId:     tableId,
      handNumber,
      winners:    winners.map(w => ({ playerId: w.playerId, amount: w.amount })),
      showdown:   [],
      deltas,
    }
    spectator.broadcast(resultMsg)
    hub.broadcast(resultMsg)

    // Announce when a table finds its champion (before the final table merges)
    const tableWinner = tournament.getTableWinner(tableId)
    if (tableWinner && activeBefore.length > 1 && !tournament.isFinished()) {
      const winnerMsg: TableWinnerMsg = {
        type:        'table_winner',
        tableId,
        handNumber,
        winnerId:    tableWinner.id,
        winnerName:  tableWinner.name,
        winnerStack: tableWinner.stack,
      }
      spectator.broadcast(winnerMsg)
      console.log(`[table] ${tableWinner.name} (${tableWinner.id}) wins ${tableId} — advancing to the final table`)
    }
  }

  private broadcastTableState(
    tableId:        string,
    handNumber:     number,
    state:          GameState,
    actingPlayerId: string,
    lastActions:    Map<string, string>,
  ): void {
    const { hub, spectator } = this.opts
    const bountyTargetId = this.activeBounty?.targetId ?? null
    const msg: TableStateMsg = {
      type:           'table_state',
      tableId,
      handNumber,
      stage:          state.stage,
      players:        state.players.map((p, i) => ({
        id:             p.id,
        stack:          p.stack,
        bet:            p.bet,
        folded:         p.folded,
        allIn:          p.allIn,
        isActing:       p.id === actingPlayerId,
        isDealer:       i === state.dealerIndex,
        connected:      hub.isAgentConnected(p.id),
        holeCards:      p.holeCards,
        lastAction:     lastActions.get(p.id),
        isBountyTarget: p.id === bountyTargetId,
      })),
      communityCards: state.communityCards,
      pot:            state.pot,
      dealerIndex:    state.dealerIndex,
    }
    spectator.broadcast(msg)
  }

  private broadcastStandings(tournament: Tournament, handNumber: number): void {
    const msg: TournamentUpdateMsg = {
      type:         'tournament_update',
      standings:    tournament.standings.map(p => ({
        playerId:   p.id,
        stack:      p.stack,
        eliminated: p.eliminated,
      })),
      blindLevel:   tournament.blindLevel,
      smallBlind:   tournament.currentBlinds.smallBlind,
      bigBlind:     tournament.currentBlinds.bigBlind,
      activeTables: tournament.tableIds,
      tableCount:   tournament.tableIds.length,
    }
    this.opts.spectator.broadcast(msg)
    console.log(
      `Hand ${handNumber} | ${tournament.activePlayers.length} players remaining` +
      ` | Blinds ${msg.smallBlind}/${msg.bigBlind}` +
      ` | Tables: ${msg.activeTables.join(', ')}`
    )
  }
}
