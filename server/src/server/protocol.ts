import type { Card } from '../engine/card.js'
import type { ActionType, GameStage } from '../engine/game.js'

// ── Spectator table state ────────────────────────────────────────────────────

export interface TablePlayerState {
  id: string
  stack: number
  bet: number
  folded: boolean
  allIn: boolean
  isActing: boolean
  isDealer: boolean
  connected: boolean
  holeCards: Card[]
  lastAction?: string
}

export interface TableStateMsg {
  type: 'table_state'
  tableId: string
  handNumber: number
  stage: GameStage
  players: TablePlayerState[]
  communityCards: Card[]
  pot: number
  dealerIndex: number
}

// ── Server → Agent ──────────────────────────────────────────────────────────

export interface PlayerView {
  id: string
  stack: number
  bet: number
  folded: boolean
  allIn: boolean
}

export interface ActionRequiredMsg {
  type: 'action_required'
  gameId: string
  handNumber: number
  stage: GameStage
  position: string          // 'BTN' | 'SB' | 'BB' | 'UTG' | 'UTG+1' | ...
  holeCards: [Card, Card]
  communityCards: Card[]
  pot: number
  myStack: number
  myBet: number
  currentBet: number
  players: PlayerView[]
  validActions: ActionType[]
  minRaise: number
  maxRaise: number          // player's remaining stack
  timeLimitMs: number
}

export interface HandResultMsg {
  type: 'hand_result'
  gameId: string
  handNumber: number
  winners: { playerId: string; amount: number; hand?: string }[]
  showdown: { playerId: string; holeCards: [Card, Card] }[]
  deltas: Record<string, number>   // net chip change per player (positive = won, negative = lost)
}

export interface TournamentUpdateMsg {
  type: 'tournament_update'
  standings: { playerId: string; stack: number; eliminated: boolean }[]
  blindLevel: number
  smallBlind: number
  bigBlind: number
  activeTables: string[]
  tableCount: number
}

export interface CountdownMsg {
  type: 'countdown'
  secondsRemaining: number
  agentCount: number
}

export interface TournamentEndMsg {
  type: 'tournament_end'
  place: number
  result: 'won' | 'lost'
  finalStack: number
}

export interface TournamentCompleteMsg {
  type: 'tournament_complete'
  winnerId: string
  winnerName: string
  finalStack: number
  standings: { playerId: string; name: string; place: number; stack: number }[]
}

export interface LobbySnapshotMsg {
  type: 'lobby_snapshot'
  agents: { id: string; name: string }[]
}

export interface ErrorMsg {
  type: 'error'
  message: string
}

export type ServerMessage = ActionRequiredMsg | HandResultMsg | TournamentUpdateMsg | CountdownMsg | TableStateMsg | TournamentEndMsg | TournamentCompleteMsg | LobbySnapshotMsg | ErrorMsg

// ── Agent → Server ───────────────────────────────────────────────────────────

export interface AgentRegisterMsg {
  type: 'register'
  agentId: string
  agentName: string
}

export interface AgentActionMsg {
  type: 'action'
  gameId: string
  action: ActionType
  amount?: number
}

export type AgentMessage = AgentRegisterMsg | AgentActionMsg
