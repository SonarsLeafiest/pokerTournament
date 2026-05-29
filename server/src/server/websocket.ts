import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { AgentMessage, ServerMessage } from './protocol.js'

export interface ConnectedAgent {
  id: string
  name: string
  ws: WebSocket
  connected: boolean
  actionTimer?: ReturnType<typeof setTimeout>  // paused while disconnected; restarted on reconnect
  _serverClose?: boolean                        // set by disconnectAll() to skip reconnect window
  pendingResolve?: (msg: AgentMessage) => void
  pendingReject?: (err: Error) => void
  remoteAddress?: string
}

export interface HubOptions {
  port?: number          // standalone mode (local dev / tests)
  noServer?: boolean     // attach to an existing HTTP server via handleUpgrade()
  actionTimeoutMs?: number
  /**
   * How long to wait for an action_ack before auto-folding.
   * action_ack is sent by the agent immediately on receipt of action_required
   * (before starting the LLM call), which resets the timer to actionTimeoutMs
   * so the reasoning deadline only counts actual thinking time.
   * Defaults to 30 s — generous enough to cover subprocess startup overhead.
   * Falls back to actionTimeoutMs behaviour for agents that don't send acks.
   */
  ackWindowMs?: number
  heartbeatIntervalMs?: number
  onAgentConnect?: (agent: ConnectedAgent) => void
  onAgentDisconnect?: (agentId: string) => void
  onAgentReconnect?: (agent: ConnectedAgent) => void
  /**
   * Called before accepting a brand-new registration (not a reconnect).
   * Return false to reject the connection with an error message.
   * Reconnects of already-known agents always succeed regardless.
   */
  canRegister?: (agentId: string, agentName: string) => boolean
}

export class WebSocketHub {
  private wss: WebSocketServer
  private agents: Map<string, ConnectedAgent> = new Map()
  private isAlive: Map<string, boolean> = new Map()
  private readonly actionTimeoutMs: number
  private readonly ackWindowMs: number

  constructor(private opts: HubOptions) {
    this.actionTimeoutMs = opts.actionTimeoutMs ?? 5000
    this.ackWindowMs     = opts.ackWindowMs     ?? 30_000

    if (opts.noServer) {
      this.wss = new WebSocketServer({ noServer: true, maxPayload: 65_536 })
    } else {
      this.wss = new WebSocketServer({ port: opts.port, maxPayload: 65_536 })
    }

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))

    const heartbeatMs = opts.heartbeatIntervalMs ?? 30_000
    const interval = setInterval(() => this.heartbeat(), heartbeatMs)
    interval.unref()
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
    })
  }

  private heartbeat(): void {
    for (const [id, agent] of this.agents) {
      if (!agent.connected) continue  // reconnect window owns cleanup; skip heartbeat
      if (!this.isAlive.get(id)) {
        agent.ws.terminate()
        this.agents.delete(id)
        this.isAlive.delete(id)
        this.opts.onAgentDisconnect?.(id)
        continue
      }
      this.isAlive.set(id, false)
      agent.ws.ping()
    }
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    let agentId: string | null = null
    const remoteAddress = (_req as any).socket?.remoteAddress as string | undefined

    ws.on('pong', () => {
      if (agentId) this.isAlive.set(agentId, true)
    })

    ws.on('message', (data) => {
      let msg: AgentMessage
      try {
        msg = JSON.parse(data.toString()) as AgentMessage
      } catch {
        this.send(ws, { type: 'error', message: 'Invalid JSON' })
        return
      }

      if (msg.type === 'register') {
        const agentIdRaw   = msg.agentId
        const agentNameRaw = msg.agentName
        if (typeof agentIdRaw !== 'string' || agentIdRaw.length < 1 || agentIdRaw.length > 64
            || !/^[\w\-]+$/.test(agentIdRaw)) {
          this.send(ws, { type: 'error', message: 'Invalid agentId: must be 1-64 alphanumeric/dash/underscore characters' })
          ws.close(); return
        }
        if (typeof agentNameRaw !== 'string' || agentNameRaw.length < 1 || agentNameRaw.length > 64) {
          this.send(ws, { type: 'error', message: 'Invalid agentName: must be 1-64 characters' })
          ws.close(); return
        }
        agentId = agentIdRaw
        const existing = this.agents.get(agentId)

        if (existing && !existing.connected) {
          // Reconnect: check IP matches to prevent identity hijacking
          if (remoteAddress && existing.remoteAddress && existing.remoteAddress !== remoteAddress) {
            this.send(ws, { type: 'error', message: 'Reconnect from different IP not allowed' })
            ws.close()
            return
          }
          // Restore the existing agent object so pendingResolve/Reject survive
          existing.ws           = ws
          existing.connected    = true
          existing._serverClose = undefined
          existing.name         = msg.agentName
          this.isAlive.set(agentId, true)

          // Restart the action timeout (was paused on disconnect)
          if (existing.pendingResolve && existing.pendingReject && !existing.actionTimer) {
            const reject = existing.pendingReject
            const id     = agentId
            existing.actionTimer = setTimeout(() => {
              if (existing.pendingResolve) {
                existing.pendingResolve = undefined
                existing.pendingReject  = undefined
                existing.actionTimer    = undefined
                reject(new Error(`Agent ${id} timed out`))
              }
            }, this.actionTimeoutMs)
          }

          this.opts.onAgentReconnect?.(existing)
        } else {
          // Check if this ID is already taken by a currently-connected agent
          if (existing && existing.connected) {
            this.send(ws, { type: 'error', message: 'Agent ID already in use by a connected agent' })
            ws.close()
            return
          }
          // New registration — check whether it's currently allowed
          if (this.opts.canRegister && !this.opts.canRegister(agentId, msg.agentName)) {
            this.send(ws, { type: 'error', message: 'Tournament is already in progress. Registration is closed.' })
            ws.close()
            return
          }
          const agent: ConnectedAgent = { id: agentId, name: msg.agentName, ws, connected: true, remoteAddress }
          this.agents.set(agentId, agent)
          this.isAlive.set(agentId, true)
          this.send(ws, {
            type:        'register_ack',
            agentId,
            agentName:   msg.agentName,
            timeLimitMs: this.actionTimeoutMs,
            setupMs:     this.ackWindowMs,
          })
          this.opts.onAgentConnect?.(agent)
        }
        return
      }

      if (!agentId) {
        this.send(ws, { type: 'error', message: 'Must register before sending actions' })
        return
      }

      const agent = this.agents.get(agentId)
      if (agent?.pendingResolve) {
        // Clear before calling so the handler can re-register pendingResolve
        // for phase 2 (action_ack → action two-phase timing).
        const handler = agent.pendingResolve
        agent.pendingResolve = undefined
        handler(msg)
      }
    })

    ws.on('error', (err) => {
      console.error(`[ws] agent socket error (${agentId ?? 'unregistered'}):`, err.message)
    })

    ws.on('close', () => {
      if (!agentId) return
      const id    = agentId   // capture: TS can't narrow string | null inside callbacks
      const agent = this.agents.get(id)
      if (!agent) return
      this.isAlive.delete(id)

      if (agent._serverClose) {
        // Server-initiated (disconnectAll) — reject immediately, clean up
        agent.pendingReject?.(new Error(`Agent ${id} disconnected`))
        this.agents.delete(id)
        this.opts.onAgentDisconnect?.(id)
        return
      }

      // Agent-initiated disconnect — pause the action timer, notify UI, wait for reconnect
      agent.connected = false
      clearTimeout(agent.actionTimer)
      agent.actionTimer = undefined
      this.opts.onAgentDisconnect?.(id)
      // No timer: game pauses until agent reconnects or admin resets/closes
    })
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const agent of this.agents.values()) {
      if (agent.connected) this.send(agent.ws, msg)
    }
  }

  sendToAgent(agentId: string, msg: ServerMessage): void {
    const agent = this.agents.get(agentId)
    if (agent?.connected) this.send(agent.ws, msg)
  }

  /**
   * Wait for the next message from an agent, resolving with null on timeout
   * instead of rejecting.  Used for optional interactions (e.g. bounty curse)
   * where a non-response should fall back gracefully rather than auto-fold.
   */
  waitForCurse(agentId: string, timeoutMs: number): Promise<AgentMessage | null> {
    return new Promise((resolve) => {
      const agent = this.agents.get(agentId)
      if (!agent?.connected) { resolve(null); return }

      agent.pendingResolve = (msg) => {
        clearTimeout(agent.actionTimer)
        agent.actionTimer   = undefined
        agent.pendingReject = undefined
        resolve(msg)
      }
      agent.pendingReject = () => resolve(null)  // disconnect → null, not reject

      agent.actionTimer = setTimeout(() => {
        if (agent.pendingResolve) {
          agent.pendingResolve = undefined
          agent.pendingReject  = undefined
          agent.actionTimer    = undefined
          resolve(null)
        }
      }, timeoutMs)
    })
  }

  waitForAction(agentId: string): Promise<AgentMessage> {
    return new Promise((resolve, reject) => {
      const agent = this.agents.get(agentId)
      if (!agent) {
        reject(new Error(`Agent ${agentId} not connected`))
        return
      }

      const startTimer = (ms: number) => {
        clearTimeout(agent.actionTimer)
        agent.actionTimer = setTimeout(() => {
          agent.pendingResolve = undefined
          agent.pendingReject  = undefined
          agent.actionTimer    = undefined
          reject(new Error(`Agent ${agentId} timed out`))
        }, ms)
      }

      const resolveAction = (msg: AgentMessage) => {
        clearTimeout(agent.actionTimer)
        agent.actionTimer   = undefined
        agent.pendingReject = undefined
        resolve(msg)
      }

      // Phase 1 handler: receives either action_ack or a direct action.
      // If action_ack arrives, register phase 2 handler and restart timer
      // with the (shorter) reasoning window so only thinking time counts.
      // Agents that skip the ack and send an action directly are handled
      // transparently — the ackWindowMs timer is their total budget.
      agent.pendingResolve = (msg) => {
        if ((msg as any).type === 'action_ack') {
          // Phase 2: reasoning window starts now
          agent.pendingResolve = resolveAction
          startTimer(this.actionTimeoutMs)
          return
        }
        resolveAction(msg)
      }

      agent.pendingReject = (err) => {
        clearTimeout(agent.actionTimer)
        agent.actionTimer    = undefined
        agent.pendingResolve = undefined
        reject(err)
      }

      // Phase 1 timer: generous overhead window so CLI / slow starts don't stall
      if (agent.connected) startTimer(this.ackWindowMs)
    })
  }

  getConnectedAgentIds(): string[] {
    return [...this.agents.entries()]
      .filter(([, a]) => a.connected)
      .map(([id]) => id)
  }

  getConnectedAgents(): { id: string; name: string }[] {
    return [...this.agents.values()]
      .filter(a => a.connected)
      .map(a => ({ id: a.id, name: a.name }))
  }

  isAgentConnected(agentId: string): boolean {
    return this.agents.get(agentId)?.connected === true
  }

  disconnectAll(): void {
    for (const agent of this.agents.values()) {
      agent._serverClose = true
      agent.ws.close()
    }
  }

  get agentCount(): number {
    let n = 0
    for (const a of this.agents.values()) if (a.connected) n++
    return n
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()))
    })
  }
}
