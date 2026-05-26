import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { AgentMessage, ServerMessage } from './protocol.js'

export interface ConnectedAgent {
  id: string
  name: string
  ws: WebSocket
  pendingResolve?: (msg: AgentMessage) => void
}

export interface HubOptions {
  port: number
  actionTimeoutMs?: number
  onAgentConnect?: (agent: ConnectedAgent) => void
  onAgentDisconnect?: (agentId: string) => void
}

export class WebSocketHub {
  private wss: WebSocketServer
  private agents: Map<string, ConnectedAgent> = new Map()
  private readonly actionTimeoutMs: number

  constructor(private opts: HubOptions) {
    this.actionTimeoutMs = opts.actionTimeoutMs ?? 5000
    this.wss = new WebSocketServer({ port: opts.port })
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    let agentId: string | null = null

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
        const agent: ConnectedAgent = { id: agentId, name: msg.agentName, ws }
        this.agents.set(agentId, agent)
        this.opts.onAgentConnect?.(agent)
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
      if (agentId) {
        this.agents.delete(agentId)
        this.opts.onAgentDisconnect?.(agentId)
      }
    })
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const agent of this.agents.values()) {
      this.send(agent.ws, msg)
    }
  }

  sendToAgent(agentId: string, msg: ServerMessage): void {
    const agent = this.agents.get(agentId)
    if (agent) this.send(agent.ws, msg)
  }

  waitForAction(agentId: string): Promise<AgentMessage> {
    return new Promise((resolve, reject) => {
      const agent = this.agents.get(agentId)
      if (!agent) {
        reject(new Error(`Agent ${agentId} not connected`))
        return
      }

      const timeout = setTimeout(() => {
        if (agent.pendingResolve) {
          agent.pendingResolve = undefined
          reject(new Error(`Agent ${agentId} timed out`))
        }
      }, this.actionTimeoutMs)

      agent.pendingResolve = (msg) => {
        clearTimeout(timeout)
        resolve(msg)
      }
    })
  }

  getConnectedAgentIds(): string[] {
    return [...this.agents.keys()]
  }

  get agentCount(): number {
    return this.agents.size
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()))
    })
  }
}
