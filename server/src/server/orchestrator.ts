import type { WebSocketHub } from './websocket.js'
import type { SpectatorState } from './spectator.js'
import type { LobbyState } from './http.js'
import type {
  ActionRequiredMsg, AgentActionMsg,
  HandResultMsg, TournamentUpdateMsg, TableStateMsg, TournamentCompleteMsg, TableWinnerMsg,
  BountyAnnouncedMsg, BountyClaimedMsg, BountyExpiredMsg, BountyInfo,
  BountyCurseRequiredMsg, BountyCursedMsg,
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
  bountyWindowHands:  number   // how many hands the target has before the bounty expires (0 = disabled)
  bountyFireEvery:    number   // hands between successive bounties (0 = same as bountyWindowHands)
  bountyReward:       number
  bountyCurseAmount:  number   // chips cursed after a claim (0 = disabled)
}

export class Orchestrator {
  private pendingActionMsgs = new Map<string, ActionRequiredMsg>()
  /** Per-table active bounties — each table runs its own bounty independently. */
  private activeBounties    = new Map<string, ActiveBounty>()
  /** Per-table next-fire hand counters. */
  private nextBountyAtHand  = new Map<string, number>()

  constructor(private opts: OrchestratorOptions) {}

  /** Hands between one bounty resolving and the next being announced on the same table. */
  private get cooldownHands(): number {
    return this.opts.bountyFireEvery > 0
      ? this.opts.bountyFireEvery
      : this.opts.bountyWindowHands
  }

  /** Returns the last action_required message sent to a player (for reconnect replay). */
  getPendingAction(playerId: string): ActionRequiredMsg | undefined {
    return this.pendingActionMsgs.get(playerId)
  }

  /**
   * Force all active tables to announce a bounty at the next hand boundary.
   * No-op if bounties are disabled. Dev/testing use only.
   */
  forceNextBounty(): void {
    if (this.opts.bountyWindowHands > 0) {
      for (const tableId of this.nextBountyAtHand.keys()) {
        this.nextBountyAtHand.set(tableId, 0)
      }
    }
  }

  /** Initialise or refresh per-table bounty counters after seating/rebalancing. */
  private syncTableBountyState(tableIds: string[]): void {
    const initial = this.opts.bountyWindowHands > 0 ? this.cooldownHands : Infinity
    // Add counters for newly-created tables
    for (const id of tableIds) {
      if (!this.nextBountyAtHand.has(id)) this.nextBountyAtHand.set(id, initial)
    }
    // Remove state for tables that no longer exist
    for (const id of [...this.nextBountyAtHand.keys()]) {
      if (!tableIds.includes(id)) {
        this.nextBountyAtHand.delete(id)
        this.activeBounties.delete(id)
      }
    }
  }

  async runTournament(config: TournamentConfig): Promise<void> {
    const { hub, spectator, getLobbyState, setLobbyState, isAborted } = this.opts

    spectator.resetBuffers()
    this.activeBounties.clear()
    this.nextBountyAtHand.clear()

    const tournament = new Tournament(config)
    tournament.seatTables()
    this.syncTableBountyState(tournament.tableIds)

    let handNumber = 0

    while (!tournament.isFinished() && !isAborted()) {
      const tables = tournament.tableIds

      // Snapshot standings + per-table target-was-active flags before the round
      const standingsBefore = new Map(tournament.standings.map(p => [p.id, p.stack]))
      const targetWasActive = new Map<string, boolean>()
      for (const tableId of tables) {
        const bounty = this.activeBounties.get(tableId)
        if (bounty) {
          targetWasActive.set(tableId,
            tournament.getTableActivePlayers(tableId).some(p => p.id === bounty.targetId))
        }
      }

      await Promise.all(tables.map(tableId => this.playHand(tournament, tableId, ++handNumber)))

      // Bounty resolution per table — must happen before standings broadcast
      for (const tableId of tables) {
        await this.resolveBounty(tournament, tableId, handNumber, standingsBefore,
          targetWasActive.get(tableId) ?? false)
        this.maybeAnnounceBounty(tournament, tableId, handNumber)
      }

      tournament.rebalance()
      this.syncTableBountyState(tournament.tableIds)  // add/remove entries as tables merge
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
   * Resolve the bounty for one table after a hand round.
   * Awards chips if the target was eliminated, expires if the window closed,
   * or cancels if the table is down to heads-up.
   */
  private async resolveBounty(
    tournament:      Tournament,
    tableId:         string,
    handNumber:      number,
    standingsBefore: Map<string, number>,
    targetWasActive: boolean,
  ): Promise<void> {
    const { hub, spectator } = this.opts
    const bounty = this.activeBounties.get(tableId)
    if (!bounty || !targetWasActive) return

    const tablePlayers        = tournament.getTableActivePlayers(tableId)
    const targetNowEliminated = !tablePlayers.some(p => p.id === bounty.targetId)

    if (targetNowEliminated) {
      let eliminatorId:   string | null = null
      let eliminatorName: string        = ''
      let maxGain                       = 0

      for (const player of tournament.standings) {
        if (player.id === bounty.targetId) continue
        // Skip players absent from the pre-hand snapshot — their delta is unknown
        if (!standingsBefore.has(player.id)) continue
        const before = standingsBefore.get(player.id)!
        const gain   = player.stack - before
        if (gain > maxGain) {
          maxGain        = gain
          eliminatorId   = player.id
          eliminatorName = player.name
        }
      }

      if (eliminatorId && bounty.reward > 0) {
        tournament.awardBonus(eliminatorId, bounty.reward)
        const claimed: BountyClaimedMsg = {
          type: 'bounty_claimed', tableId, targetId: bounty.targetId, targetName: bounty.targetName,
          claimedById: eliminatorId, claimedByName: eliminatorName,
          reward: bounty.reward, handNumber,
        }
        spectator.broadcast(claimed)
        hub.broadcast(claimed)
        console.log(`[bounty] ${eliminatorName} eliminated ${bounty.targetName} and claimed ${bounty.reward} bonus chips! (${tableId})`)

        if (this.opts.bountyCurseAmount > 0) {
          await this._applyCurse(hub, spectator, tournament, tableId, eliminatorId, eliminatorName, handNumber)
        }
      }

      this.activeBounties.delete(tableId)
      this.nextBountyAtHand.set(tableId, handNumber + this.cooldownHands)
      return
    }

    if (handNumber >= bounty.expiresAfterHand) {
      const expired: BountyExpiredMsg = {
        type: 'bounty_expired', tableId, targetId: bounty.targetId, targetName: bounty.targetName, handNumber,
      }
      spectator.broadcast(expired)
      console.log(`[bounty] Bounty on ${bounty.targetName} expired unclaimed (${tableId})`)
      this.activeBounties.delete(tableId)
      this.nextBountyAtHand.set(tableId, handNumber + this.cooldownHands)
      return
    }

    // Cancel at heads-up — no tactical value with only two players
    if (tablePlayers.length <= 2) {
      const expired: BountyExpiredMsg = {
        type: 'bounty_expired', tableId, targetId: bounty.targetId, targetName: bounty.targetName, handNumber,
      }
      spectator.broadcast(expired)
      console.log(`[bounty] Bounty on ${bounty.targetName} cancelled — heads-up reached (${tableId})`)
      this.activeBounties.delete(tableId)
      this.nextBountyAtHand.set(tableId, Infinity)
    }
  }

  /** Announce a new bounty for one table if enough hands have passed. */
  private maybeAnnounceBounty(tournament: Tournament, tableId: string, handNumber: number): void {
    if (this.activeBounties.has(tableId)) return
    const nextHand = this.nextBountyAtHand.get(tableId) ?? Infinity
    if (handNumber < nextHand) return

    const tablePlayers = tournament.getTableActivePlayers(tableId)
    if (tablePlayers.length <= 2) return  // need 3+ seated at this table

    const target           = tablePlayers[Math.floor(Math.random() * tablePlayers.length)]
    const expiresAfterHand = handNumber + this.opts.bountyWindowHands

    this.activeBounties.set(tableId, {
      targetId: target.id, targetName: target.name,
      reward: this.opts.bountyReward, expiresAfterHand,
    })

    const msg: BountyAnnouncedMsg = {
      type: 'bounty_announced', tableId, targetId: target.id, targetName: target.name,
      reward: this.opts.bountyReward, expiresAfterHand, handNumber,
    }
    this.opts.spectator.broadcast(msg)
    console.log(`[bounty] 💰 BOUNTY on ${target.name} at ${tableId} — ${this.opts.bountyReward} chips, expires h.${expiresAfterHand}`)
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

      // Build bounty info for this agent — scoped to their table
      const activeBountyInfo: BountyInfo | null =
        (this.activeBounties.get(tId) as BountyInfo | undefined) ?? null

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

      let response: AgentActionMsg
      try {
        response = await hub.waitForAction(playerId) as AgentActionMsg
      } catch (e) {
        this.pendingActionMsgs.delete(playerId)
        lastActions.set(playerId, 'TIMEOUT')
        spectator.broadcast({ type: 'agent_timeout', tableId: tId, playerId, handNumber })
        console.log(`[timeout] ⏰  ${playerId} timed out — auto-fold (hand #${handNumber}, ${tId})`)
        throw e
      }
      this.pendingActionMsgs.delete(playerId)

      // H3: discard actions that claim to be for a different game/table
      if (response.gameId && response.gameId !== tId) {
        hub.sendToAgent(playerId, { type: 'error', message: `Action for game ${response.gameId} ignored (expected ${tId})` })
        lastActions.set(playerId, ActionType.FOLD)
        return { type: ActionType.FOLD }
      }

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

      // M1: validate raise amount is at least minRaise — a sub-minimum raise
      // would cause applyAction to throw and crash the tournament (DoS).
      if (action === ActionType.RAISE) {
        const minRaiseRequired = state.currentBet + state.lastRaiseSize
        if (amount == null || amount < minRaiseRequired) {
          hub.sendToAgent(playerId, { type: 'error', message: `Raise amount ${amount} below minimum ${minRaiseRequired}` })
          lastActions.set(playerId, ActionType.FOLD)
          return { type: ActionType.FOLD }
        }
      }

      lastActions.set(playerId,
        action === ActionType.RAISE && amount != null ? `${action} ${amount}` : action)

      return { type: action as ActionType, amount }
    }

    const activeBefore = tournament.getTableActivePlayers(tableId)
    const stacksBefore = new Map(tournament.standings.map(p => [p.id, p.stack]))
    const { winners, showdown, communityCards } = await tournament.playHand(tableId, requestAction)
    const stacksAfter  = new Map(tournament.standings.map(p => [p.id, p.stack]))

    const deltas: Record<string, number> = {}
    for (const [id, before] of stacksBefore) {
      const after = stacksAfter.get(id) ?? before
      if (after !== before) deltas[id] = after - before
    }

    // Skip broadcasting when the table had < 2 players and playHand returned
    // early — no cards were dealt and winners is empty. The hand number was
    // already incremented; we just don't emit a log entry for it.
    if (winners.length === 0) return

    const resultMsg: HandResultMsg = {
      type:       'hand_result',
      gameId:     tableId,
      handNumber,
      winners:        winners.map(w => ({ playerId: w.playerId, amount: w.amount })),
      showdown,
      communityCards,
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
    const bountyTargetId = this.activeBounties.get(tableId)?.targetId ?? null
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
        avatarUrl:      hub.getAgentAvatarUrl(p.id),
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

  // ── Curse mechanic ──────────────────────────────────────────────────────────

  /**
   * After a bounty claim the eliminator chooses one opponent to curse
   * (-bountyCurseAmount chips).  A short window is given for the agent to
   * respond; if they time out or send an invalid target, a random active
   * opponent is chosen instead.  The cursed player and all spectators are
   * notified via bounty_cursed.
   */
  private async _applyCurse(
    hub:           typeof this.opts.hub,
    spectator:     typeof this.opts.spectator,
    tournament:    Tournament,
    tableId:       string,
    curserId:      string,
    curserName:    string,
    handNumber:    number,
  ): Promise<void> {
    const curseAmount = this.opts.bountyCurseAmount
    const available   = tournament.activePlayers
      .filter(p => p.id !== curserId)
      .map(p => ({ id: p.id, name: p.name, stack: p.stack }))

    if (available.length === 0) return

    const curseMsg: BountyCurseRequiredMsg = {
      type:             'bounty_curse_required',
      reward:           this.opts.bountyReward,
      curseAmount,
      availableTargets: available,
      timeLimitMs:      this.opts.actionTimeout,
    }
    hub.sendToAgent(curserId, curseMsg)

    // Wait for curse response; fall back to random target on silence
    let targetId: string | null = null
    const response = await hub.waitForCurse(curserId, this.opts.actionTimeout)
    if (response?.type === 'bounty_curse' && available.some(t => t.id === (response as any).targetId)) {
      targetId = (response as any).targetId
    }
    if (!targetId) {
      // available.length is checked to be > 0 above, but guard defensively
      if (available.length === 0) return
      targetId = available[Math.floor(Math.random() * available.length)].id
    }

    const target = tournament.standings.find(p => p.id === targetId)
    if (!target) return

    const actual = tournament.penalizePlayer(targetId, curseAmount)
    const cursed: BountyCursedMsg = {
      type:       'bounty_cursed',
      tableId,
      curserId,
      curserName,
      targetId,
      targetName: target.name,
      amount:     actual,
      handNumber,
    }
    spectator.broadcast(cursed)
    hub.broadcast(cursed)
    console.log(`[bounty] 💀 ${curserName} curses ${target.name} for -${actual} chips!`)
  }
}
