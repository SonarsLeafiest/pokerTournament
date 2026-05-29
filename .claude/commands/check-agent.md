---
name: check-agent
description: Audit an agent file for protocol correctness. Checks that it handles every required message type, sends correctly structured responses, has timeout/error handling, and is wired up for bounty and curse events. Pass the file path as an argument, e.g. /check-agent examples/python/personalities/ace_hunter.py
---

# Check Agent Protocol Compliance

Audit the agent file passed as the argument (or ask for a path if none given).

## What to check

Work through each category and report findings clearly.

### 1. Outbound messages (agent → server)

Verify the agent sends these messages in the correct format:

| Message | Required fields | Notes |
|---------|----------------|-------|
| `register` | `type`, `agentId`, `agentName` | Must be the first message sent on connect |
| `action` | `type`, `gameId`, `action` (FOLD/CHECK/CALL/RAISE), `amount` (RAISE only) | `action` must be uppercase; `amount` must be an integer |
| `bounty_curse` | `type`, `targetId` | Only sent in response to `bounty_curse_required` |

### 2. Inbound message handling (server → agent)

Check that the agent has a handler for **every** message type:

| Message | Required response | Notes |
|---------|------------------|-------|
| `register_ack` | Log the `timeLimitMs` | Confirms registration; surfaces the action timeout |
| `action_required` | Send `action` within `timeLimitMs` | The core game loop |
| `hand_result` | Optional log | Contains `deltas`, `showdown` (hole cards when revealed) |
| `tournament_update` | Optional log | Standings, blind level, active tables |
| `tournament_end` | Disconnect or stop | Signals final placement |
| `bounty_announced` | Optional log | Active bounty is also in every `action_required.activeBounty` |
| `bounty_claimed` | Optional log | |
| `bounty_expired` | Optional log | |
| `bounty_cursed` | Log when `targetId === AGENT_ID` | Player should know they were targeted |
| `bounty_curse_required` | Send `bounty_curse` with a `targetId` | Must respond within `timeLimitMs` or server picks randomly |
| `error` | Log the message | Server signals an invalid action was sent |

### 3. Action timeout handling

- Does the agent respond to `action_required` within `timeLimitMs` milliseconds?
- Is there a subprocess/API timeout that could exceed the server limit?
- Is there a fallback (e.g. FOLD) if the LLM call fails or times out?

### 4. Bounty awareness in `action_required`

Check that `action_required.activeBounty` is used in the prompt/decision logic:

- If `activeBounty.targetId === AGENT_ID` → agent should play defensively
- If target is in `players` list → agent should consider widening range to pressure them
- If target is at another table → note it but play normally

### 5. Error handling

- Network errors / disconnects handled gracefully?
- JSON parse errors caught?
- Invalid responses from LLM caught and folded?
- Will the agent reconnect after a drop (or does it just crash)?

### 6. Valid action enforcement

The agent should only send actions listed in `validActions`. Sending `CHECK` when it's not valid causes an auto-fold and a server `error` message.

## Reporting

List each issue found as:

```
[CRITICAL] Missing handler for `bounty_curse_required` — server will pick a random target
[WARNING]  No fallback if Claude CLI times out — agent will hang and get auto-folded
[INFO]     activeBounty not used in prompt — misses bounty bounty mechanic
[OK]       Handles all required outbound message types
```

Conclude with: **"Agent is ready to compete"** or **"Agent needs fixes before competing"** with a summary of blockers.
