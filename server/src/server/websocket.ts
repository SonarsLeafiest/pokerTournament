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
}

export interface HubOptions {
  port?: number          // standalone mode (local dev / tests)
  noServer?: boolean     // attach to an existing HTTP server via handleUpgrade()
  actionTimeoutMs?: number
  heartbeatIntervalMs?: number
  onAgentConnect?: (agent: ConnectedAgent) => void
  onAgentDisconnect?: (agentId: string) => void
  onAgentReconnect?: (agent: ConnectedAgent) => void
}

export class WebSocketHub {
  private wss: WebSocketServer
  private agents: Map<string, ConnectedAgent> = new Map()
  private isAlive: Map<string, boolean> = new Map()
  private readonly actionTimeoutMs: number

  constructor(private opts: HubOptions) {
    this.actionTimeoutMs = opts.actionTimeoutMs ?? 5000

    if (opts.noServer) {
      this.wss = new WebSocketServer({ noServer: true })
    } else {
      this.wss = new WebSocketServer({ port: opts.port })
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
        agentId = msg.agentId
        const existing = this.agents.get(agentId)

        if (existing && !existing.connected) {
          // Reconnect: restore the existing agent object so pendingResolve/Reject survive
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
          const agent: ConnectedAgent = { id: agentId, name: msg.agentName, ws, connected: true }
          this.agents.set(agentId, agent)
          this.isAlive.set(agentId, true)
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
        agent.pendingResolve(msg)
        agent.pendingResolve = undefined
      }
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

  waitForAction(agentId: string): Promise<AgentMessage> {
    return new Promise((resolve, reject) => {
      const agent = this.agents.get(agentId)
      if (!agent) {
        reject(new Error(`Agent ${agentId} not connected`))
        return
      }

      agent.pendingResolve = (msg) => {
        clearTimeout(agent.actionTimer)
        agent.actionTimer   = undefined
        agent.pendingReject = undefined
        resolve(msg)
      }
      agent.pendingReject = (err) => {
        clearTimeout(agent.actionTimer)
        agent.actionTimer    = undefined
        agent.pendingResolve = undefined
        reject(err)
      }

      // Only run the timeout while connected — it restarts on reconnect
      if (agent.connected) {
        agent.actionTimer = setTimeout(() => {
          if (agent.pendingResolve) {
            agent.pendingResolve = undefined
            agent.pendingReject  = undefined
            agent.actionTimer    = undefined
            reject(new Error(`Agent ${agentId} timed out`))
          }
        }, this.actionTimeoutMs)
      }
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
