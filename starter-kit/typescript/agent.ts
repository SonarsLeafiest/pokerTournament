/**
 * Poker Tournament — TypeScript Starter Agent
 *
 * Connects to the game server via WebSocket and plays random legal actions.
 * Replace the `decide()` function with your own logic.
 *
 * Setup: cp .env.example .env  then edit .env
 * Run:   npm start
 */

import 'dotenv/config'
import WebSocket from 'ws'

const SERVER_URL  = process.env.POKER_SERVER  ?? 'ws://localhost:3000'
const AGENT_ID    = process.env.AGENT_ID      ?? 'ts-agent-1'
const AGENT_NAME  = process.env.AGENT_NAME    ?? 'TypeScriptBot'

// ── Types (mirrors protocol.ts on the server) ───────────────────────────────

interface Card { rank: number; suit: 'c' | 'd' | 'h' | 's' }

interface ActionRequiredMsg {
  type: 'action_required'
  gameId: string
  handNumber: number
  holeCards: [Card, Card]
  communityCards: Card[]
  pot: number
  myStack: number
  myBet: number
  currentBet: number
  validActions: string[]
  minRaise: number
  maxRaise: number
}

interface HandResultMsg {
  type: 'hand_result'
  handNumber: number
  winners: { playerId: string; amount: number }[]
}

interface TournamentUpdateMsg {
  type: 'tournament_update'
  standings: { playerId: string; stack: number; eliminated: boolean }[]
  blindLevel: number
  smallBlind: number
  bigBlind: number
}

type ServerMsg = ActionRequiredMsg | HandResultMsg | TournamentUpdateMsg | { type: 'error'; message: string }

// ── Decision logic (replace this!) ──────────────────────────────────────────

function decide(state: ActionRequiredMsg): { action: string; amount?: number } {
  const { validActions, minRaise, maxRaise } = state

  // Never fold if we can check
  if (validActions.includes('CHECK')) return { action: 'CHECK' }

  // Raise 20% of the time
  if (validActions.includes('RAISE') && Math.random() < 0.2) {
    const amount = Math.floor(minRaise + Math.random() * (Math.min(minRaise * 3, maxRaise) - minRaise))
    return { action: 'RAISE', amount }
  }

  if (validActions.includes('CALL')) return { action: 'CALL' }

  return { action: 'FOLD' }
}

// ── Connection loop ──────────────────────────────────────────────────────────

function connect() {
  console.log(`Connecting to ${SERVER_URL} as ${AGENT_NAME} (${AGENT_ID})`)
  const ws = new WebSocket(SERVER_URL)

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', agentId: AGENT_ID, agentName: AGENT_NAME }))
    console.log('Registered. Waiting for hands...')
  })

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMsg

    if (msg.type === 'action_required') {
      const action = decide(msg)
      ws.send(JSON.stringify({ type: 'action', gameId: msg.gameId, ...action }))
    }

    if (msg.type === 'hand_result') {
      const win = msg.winners.find(w => w.playerId === AGENT_ID)
      if (win) console.log(`Won hand #${msg.handNumber}! +${win.amount}`)
    }

    if (msg.type === 'tournament_update') {
      const me = msg.standings.find(p => p.playerId === AGENT_ID)
      if (me) console.log(`Stack: ${me.stack.toLocaleString()}  |  Blinds ${msg.smallBlind}/${msg.bigBlind}`)
    }

    if (msg.type === 'error') {
      console.error(`Server error: ${msg.message}`)
    }
  })

  ws.on('close', () => {
    console.log('Disconnected. Reconnecting in 2s...')
    setTimeout(connect, 2000)
  })

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message)
  })
}

connect()
