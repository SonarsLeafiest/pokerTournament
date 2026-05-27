import type { WebSocketHub } from './websocket.js'
import type { SpectatorState } from './spectator.js'
import type { LobbyState } from './http.js'
import type {
  ActionRequiredMsg, AgentActionMsg,
  HandResultMsg, TournamentUpdateMsg, TableStateMsg, TournamentCompleteMsg,
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

export interface OrchestratorOptions {
  hub:           WebSocketHub
  spectator:     SpectatorState
  turnDelayMs:   number
  actionTimeout: number
  getLobbyState: () => LobbyState
  setLobbyState: (s: LobbyState) => void
  isAborted:     () => boolean
}

export class Orchestrator {
  private pendingActionMsgs = new Map<string, ActionRequiredMsg>()

  constructor(private opts: OrchestratorOptions) {}

  /** Returns the last action_required message sent to a player (for reconnect replay). */
  getPendingAction(playerId: string): ActionRequiredMsg | undefined {
    return this.pendingActionMsgs.get(playerId)
  }

  async runTournament(config: TournamentConfig): Promise<void> {
    const { hub, spectator, getLobbyState, setLobbyState, isAborted } = this.opts

    spectator.resetBuffers()
    const tournament = new Tournament(config)
    tournament.seatTables()

    let handNumber = 0

    while (!tournament.isFinished() && !isAborted()) {
      const tables = tournament.tableIds
      await Promise.all(tables.map(tableId => this.playHand(tournament, tableId, ++handNumber)))

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

  private async playHand(
    tournament: Tournament,
    tableId:    string,
    handNumber: number,
  ): Promise<void> {
    const { hub, spectator, isAborted } = this.opts
    const lastActions = new Map<string, string>()

    const requestAction: ActionRequestor = async (tId, playerId, state) => {
      const playerIdx  = state.players.findIndex(p => p.id === playerId)
      const player     = state.players[playerIdx]
      const validActions = validActionsFor(state, playerIdx)

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
        minRaise:    state.currentBet + state.lastRaiseSize,
        maxRaise:    player.stack,
        timeLimitMs: this.opts.actionTimeout,
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
      const amount = (typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount >= 0)
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
  }

  private broadcastTableState(
    tableId:        string,
    handNumber:     number,
    state:          GameState,
    actingPlayerId: string,
    lastActions:    Map<string, string>,
  ): void {
    const { hub, spectator } = this.opts
    const msg: TableStateMsg = {
      type:           'table_state',
      tableId,
      handNumber,
      stage:          state.stage,
      players:        state.players.map((p, i) => ({
        id:         p.id,
        stack:      p.stack,
        bet:        p.bet,
        folded:     p.folded,
        allIn:      p.allIn,
        isActing:   p.id === actingPlayerId,
        isDealer:   i === state.dealerIndex,
        connected:  hub.isAgentConnected(p.id),
        holeCards:  [],
        lastAction: lastActions.get(p.id),
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
