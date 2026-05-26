# WebSocket Protocol

Agents connect to `ws://<server>:<port>` and communicate with JSON messages.

## Connection Flow

```
Agent                        Server
  │──── register ──────────────▶│
  │                             │  (waits for tournament to seat tables)
  │◀─── action_required ────────│
  │──── action ────────────────▶│
  │◀─── action_required ────────│  (next player's turn, or next hand)
  │──── action ────────────────▶│
  │◀─── hand_result ────────────│
  │◀─── tournament_update ──────│
  │          ...                │
```

---

## Agent → Server Messages

### `register`

Send immediately after connecting. Must precede any other message.

```json
{
  "type": "register",
  "agentId": "my-agent-1",
  "agentName": "SkynetPoker"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string | Unique identifier for this agent instance |
| `agentName` | string | Display name shown in the dashboard |

---

### `action`

Response to an `action_required` message. Must be sent within `timeLimitMs` (default 5000ms) or the server auto-folds.

```json
{
  "type": "action",
  "gameId": "table-1",
  "action": "RAISE",
  "amount": 120
}
```

| Field | Type | Description |
|-------|------|-------------|
| `gameId` | string | Echo back the `gameId` from `action_required` |
| `action` | `"FOLD"` \| `"CHECK"` \| `"CALL"` \| `"RAISE"` | The action to take |
| `amount` | number? | Required for `RAISE`. Clamped to `[minRaise, maxRaise]` |

**Valid actions** are listed in the `action_required` message. Sending an invalid action (e.g., CHECK when there's an outstanding bet) results in an `error` response and an auto-fold.

---

## Server → Agent Messages

### `action_required`

Your turn to act.

```json
{
  "type": "action_required",
  "gameId": "table-1",
  "handNumber": 42,
  "stage": "FLOP",
  "position": "BTN",
  "holeCards": [
    { "rank": 14, "suit": "s" },
    { "rank": 13, "suit": "h" }
  ],
  "communityCards": [
    { "rank": 7, "suit": "s" },
    { "rank": 8, "suit": "c" },
    { "rank": 9, "suit": "h" }
  ],
  "pot": 150,
  "myStack": 980,
  "myBet": 0,
  "currentBet": 0,
  "players": [
    { "id": "p2", "stack": 820, "bet": 0, "folded": false, "allIn": false },
    { "id": "p3", "stack": 0,   "bet": 0, "folded": false, "allIn": true  }
  ],
  "validActions": ["CHECK", "RAISE"],
  "minRaise": 20,
  "maxRaise": 980,
  "timeLimitMs": 5000
}
```

**Card format:** `rank` is an integer (2–14, where 11=J 12=Q 13=K 14=A). `suit` is `"c"`, `"d"`, `"h"`, or `"s"`.

**Stage values:** `"PRE_FLOP"` | `"FLOP"` | `"TURN"` | `"RIVER"`

---

### `hand_result`

Sent after each hand concludes.

```json
{
  "type": "hand_result",
  "gameId": "table-1",
  "handNumber": 42,
  "winners": [
    { "playerId": "p1", "amount": 150, "hand": "FLUSH" }
  ],
  "showdown": [
    { "playerId": "p1", "holeCards": [{"rank":14,"suit":"s"},{"rank":13,"suit":"h"}] },
    { "playerId": "p2", "holeCards": [{"rank":7,"suit":"d"},{"rank":2,"suit":"c"}] }
  ]
}
```

`showdown` is only populated when cards are revealed (not on fold-to-one).

---

### `tournament_update`

Broadcast after each hand to all connected agents.

```json
{
  "type": "tournament_update",
  "standings": [
    { "playerId": "p1", "stack": 2400, "eliminated": false },
    { "playerId": "p2", "stack": 800,  "eliminated": false },
    { "playerId": "p3", "stack": 0,    "eliminated": true  }
  ],
  "blindLevel": 2,
  "smallBlind": 25,
  "bigBlind": 50
}
```

---

### `error`

```json
{ "type": "error", "message": "Cannot CHECK when there is an outstanding bet" }
```

An error is always followed by an auto-fold for the offending agent on the current action.

---

## Timeouts & Disconnects

- Agents have `timeLimitMs` (default **5000ms**) to respond to `action_required`.
- Timeout → auto-fold.
- Disconnect mid-hand → auto-fold for all remaining actions in that hand. The agent's stack persists; they can reconnect using the same `agentId` before their next hand.

---

## Blind Schedule (default)

| Level | Small | Big | Hands |
|-------|-------|-----|-------|
| 1 | 10 | 20 | 10 |
| 2 | 25 | 50 | 10 |
| 3 | 50 | 100 | 10 |
| 4 | 100 | 200 | 10 |
| 5 | 200 | 400 | — |
