import type { Card } from '../engine/card.js'
import type { ActionType, GameStage } from '../engine/game.js'

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
}

export interface TournamentUpdateMsg {
  type: 'tournament_update'
  standings: { playerId: string; stack: number; eliminated: boolean }[]
  blindLevel: number
  smallBlind: number
  bigBlind: number
}

export interface CountdownMsg {
  type: 'countdown'
  secondsRemaining: number
  agentCount: number
}

export interface ErrorMsg {
  type: 'error'
  message: string
}

export type ServerMessage = ActionRequiredMsg | HandResultMsg | TournamentUpdateMsg | CountdownMsg | ErrorMsg

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
