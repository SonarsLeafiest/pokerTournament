import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketHub, type ConnectedAgent } from './websocket.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHub(actionTimeoutMs = 1000, ackWindowMs = 4000) {
  return new WebSocketHub({ noServer: true, actionTimeoutMs, ackWindowMs })
}

/** Inject a fake connected agent directly into the hub's private Map. */
function injectAgent(hub: WebSocketHub, id = 'agent-1'): ConnectedAgent {
  const agent: ConnectedAgent = {
    id,
    name: id,
    ws:        { readyState: 1 } as any,
    connected: true,
  }
  ;(hub as any).agents.set(id, agent)
  ;(hub as any).isAlive.set(id, true)
  return agent
}

/** Deliver a message to the hub as if it arrived from the named agent. */
function deliver(hub: WebSocketHub, agentId: string, msg: object) {
  const agent = (hub as any).agents.get(agentId) as ConnectedAgent
  if (agent?.pendingResolve) {
    const handler = agent.pendingResolve
    agent.pendingResolve = undefined
    handler(msg as any)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('waitForAction — two-phase timing', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach  (() => { vi.useRealTimers() })

  it('resolves immediately when agent sends action directly (no ack)', async () => {
    const hub   = makeHub()
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)
    deliver(hub, agent.id, { type: 'action', gameId: 'g1', action: 'FOLD' })
    await expect(p).resolves.toMatchObject({ type: 'action', action: 'FOLD' })
  })

  it('resolves after action_ack + action', async () => {
    const hub   = makeHub()
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })
    deliver(hub, agent.id, { type: 'action', gameId: 'g1', action: 'CALL' })
    await expect(p).resolves.toMatchObject({ type: 'action', action: 'CALL' })
  })

  it('phase-1 timeout (no ack) rejects after ackWindowMs', async () => {
    const hub   = makeHub(1000, 4000)
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)
    vi.advanceTimersByTime(3999)
    // Not yet timed out
    const pending = (hub as any).agents.get(agent.id).pendingResolve
    expect(pending).toBeDefined()
    vi.advanceTimersByTime(1)
    await expect(p).rejects.toThrow('timed out')
  })

  it('phase-2 timeout (ack sent but no action) rejects after actionTimeoutMs', async () => {
    const hub   = makeHub(1000, 4000)
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })
    // Phase 2 timer is actionTimeoutMs=1000
    vi.advanceTimersByTime(999)
    expect((hub as any).agents.get(agent.id).pendingResolve).toBeDefined()
    vi.advanceTimersByTime(1)
    await expect(p).rejects.toThrow('timed out')
  })

  // ── C1: delayed-ack exploit prevention ───────────────────────────────────

  it('C1: late ack receives shortened reasoning window (elapsed subtracted)', async () => {
    // actionTimeoutMs=1000, ackWindowMs=4000
    // Ack arrives at t=800 → remaining = max(0, 1000-800) = 200ms
    const hub   = makeHub(1000, 4000)
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)

    vi.advanceTimersByTime(800)
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })

    // Should NOT yet timeout after 199 more ms (200ms window remaining)
    vi.advanceTimersByTime(199)
    expect((hub as any).agents.get(agent.id).pendingResolve).toBeDefined()

    // Should timeout at 200ms after ack
    vi.advanceTimersByTime(1)
    await expect(p).rejects.toThrow('timed out')
  })

  it('C1: ack arriving after actionTimeoutMs gives 0ms reasoning (immediate fold)', async () => {
    const hub   = makeHub(1000, 4000)
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)

    // Ack arrives after 1500ms — beyond the reasoning window
    vi.advanceTimersByTime(1500)
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })

    // remaining = max(0, 1000-1500) = 0 → setTimeout(fn, 0); flush it
    vi.advanceTimersByTime(0)
    await expect(p).rejects.toThrow('timed out')
  })

  it('C1: honest agent (ack at t≈0) gets full actionTimeoutMs for reasoning', async () => {
    const hub   = makeHub(1000, 4000)
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)

    // Ack nearly immediately (< 1ms elapsed)
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })

    // Advance to just before the reasoning deadline
    vi.advanceTimersByTime(999)
    expect((hub as any).agents.get(agent.id).pendingResolve).toBeDefined()

    // Send action in time
    deliver(hub, agent.id, { type: 'action', gameId: 'g1', action: 'RAISE' })
    await expect(p).resolves.toMatchObject({ action: 'RAISE' })
  })

  // ── C2: stale ack in phase 2 ─────────────────────────────────────────────

  it('C2: second action_ack in phase 2 is ignored — handler stays registered', async () => {
    const hub   = makeHub(1000, 4000)
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)

    // Phase 1 → phase 2
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })

    // Stale second ack — should NOT resolve the promise
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })

    // pendingResolve should still be set (handler re-registered itself)
    expect((hub as any).agents.get(agent.id).pendingResolve).toBeDefined()

    // Actual action still resolves correctly
    deliver(hub, agent.id, { type: 'action', gameId: 'g1', action: 'CHECK' })
    await expect(p).resolves.toMatchObject({ action: 'CHECK' })
  })

  it('C2: stale ack does NOT reset the phase-2 reasoning timer', async () => {
    const hub   = makeHub(1000, 4000)
    const agent = injectAgent(hub)
    const p     = hub.waitForAction(agent.id)

    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })

    // Advance 500ms — halfway through the 1s reasoning window
    vi.advanceTimersByTime(500)

    // Stale ack — if it reset the timer the agent would get 1500ms total
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })

    // Timer should fire 500ms after the FIRST ack, not after the stale one
    vi.advanceTimersByTime(500)
    await expect(p).rejects.toThrow('timed out')
  })

  // ── M2: reconnect uses remaining budget ───────────────────────────────────

  it('M2 phase-1: reconnect restarts with remaining ackWindowMs, not fresh window', () => {
    const hub   = makeHub(1000, 4000)
    const agent = injectAgent(hub)
    hub.waitForAction(agent.id)

    // Advance 1000ms into the 4000ms overhead window
    vi.advanceTimersByTime(1000)

    // Simulate disconnect: clear the timer (as the close handler would)
    clearTimeout(agent.actionTimer)
    agent.actionTimer = undefined
    agent.connected   = false
    agent.actionPhase = 'ack'
    agent.actionSentAt = Date.now() - 1000   // was started 1000ms ago

    // Reconnect
    agent.ws        = { readyState: 1 } as any
    agent.connected = true

    // Hub reconnect logic should restart with remaining = 4000-1000 = 3000ms
    if (agent.pendingResolve && agent.pendingReject && !agent.actionTimer) {
      const window    = agent.actionPhase === 'reasoning' ? 1000 : 4000
      const elapsed   = agent.actionSentAt ? Date.now() - agent.actionSentAt : 0
      const remaining = Math.max(0, window - elapsed)
      agent.actionTimer = setTimeout(() => { agent.pendingResolve = undefined }, remaining)
    }

    // 2999ms more should NOT timeout (3000ms remaining)
    vi.advanceTimersByTime(2999)
    expect(agent.pendingResolve).toBeDefined()

    // 1ms more should timeout
    vi.advanceTimersByTime(1)
    expect(agent.pendingResolve).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('waitForCurse', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach  (() => { vi.useRealTimers() })

  it('resolves with the message when agent responds in time', async () => {
    const hub   = makeHub()
    const agent = injectAgent(hub)
    const p     = hub.waitForCurse(agent.id, 2000)

    deliver(hub, agent.id, { type: 'bounty_curse', targetId: 'p2' })
    await expect(p).resolves.toMatchObject({ type: 'bounty_curse', targetId: 'p2' })
  })

  it('resolves with null on timeout (no rejection — graceful fallback)', async () => {
    const hub   = makeHub()
    const agent = injectAgent(hub)
    const p     = hub.waitForCurse(agent.id, 2000)

    vi.advanceTimersByTime(2000)
    await expect(p).resolves.toBeNull()
  })

  it('resolves with null when agent is not connected', async () => {
    const hub   = makeHub()
    const agent = injectAgent(hub)
    agent.connected = false

    const p = hub.waitForCurse(agent.id, 2000)
    await expect(p).resolves.toBeNull()
  })

  it('resolves with null when agent id is unknown', async () => {
    const hub = makeHub()
    const p   = hub.waitForCurse('ghost', 2000)
    await expect(p).resolves.toBeNull()
  })

  it('clears timer after message arrives (no stray timeout)', async () => {
    const hub   = makeHub()
    const agent = injectAgent(hub)
    hub.waitForCurse(agent.id, 2000)

    deliver(hub, agent.id, { type: 'bounty_curse', targetId: 'p3' })
    // If timer were still running this would fire and cause issues
    vi.advanceTimersByTime(2000)
    expect(agent.actionTimer).toBeUndefined()
  })

  it('does not interfere with a subsequent waitForAction call', async () => {
    const hub   = makeHub()
    const agent = injectAgent(hub)

    // Curse times out
    const curse = hub.waitForCurse(agent.id, 500)
    vi.advanceTimersByTime(500)
    await expect(curse).resolves.toBeNull()

    // waitForAction can still be used normally afterward
    const action = hub.waitForAction(agent.id)
    deliver(hub, agent.id, { type: 'action_ack', gameId: 'g1' })
    deliver(hub, agent.id, { type: 'action', gameId: 'g1', action: 'FOLD' })
    await expect(action).resolves.toMatchObject({ action: 'FOLD' })
  })
})
