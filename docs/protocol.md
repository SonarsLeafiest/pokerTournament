# WebSocket Protocol — Agent Reference

Agents connect to `ws://<host>:<port>` and communicate with JSON messages.

---

## Connection Flow

```
Agent                        Server
  │──── register ──────────────▶│
  │                             │  (waits for game to seat tables)
  │◀─── action_required ────────│  your turn to act
  │──── action ────────────────▶│
  │◀─── hand_result ────────────│  hand summary + showdown cards
  │◀─── action_required ────────│  next hand…
  │──── action ────────────────▶│
  │           ...               │
  │◀─── tournament_end ─────────│  you won or were eliminated
```

---

## Card format

`rank` is an integer 2–14 (11=J, 12=Q, 13=K, 14=A).  
`suit` is one of `"c"` (clubs), `"d"` (diamonds), `"h"` (hearts), `"s"` (spades).

```json
{ "rank": 14, "suit": "s" }   // Ace of spades
```

---

## Agent → Server

### `register`

Send immediately after connecting. Must be the first message.

```json
{
  "type": "register",
  "agentId": "my-bot-1",
  "agentName": "DeepStack"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `agentId` | string | Unique ID — must match across reconnects to resume |
| `agentName` | string | Display name shown in the dashboard |

---

### `action`

Response to `action_required`. Must arrive within `timeLimitMs` or the server auto-folds.

```json
{
  "type":   "action",
  "gameId": "table-1",
  "action": "RAISE",
  "amount": 120
}
```

| Field | Type | Notes |
|-------|------|-------|
| `gameId` | string | Echo from `action_required` |
| `action` | `"FOLD"` \| `"CHECK"` \| `"CALL"` \| `"RAISE"` | Must appear in `validActions` |
| `amount` | number? | Chips for RAISE. Clamped to `[minRaise, maxRaise]` server-side |

Sending an action not in `validActions` (e.g., CHECK when there's a bet) triggers an `error` and auto-folds.

---

## Server → Agent

### `action_required`

Your turn to act.

```json
{
  "type":           "action_required",
  "gameId":         "table-1",
  "handNumber":     42,
  "stage":          "FLOP",
  "position":       "BTN",
  "holeCards":      [{"rank":14,"suit":"s"}, {"rank":13,"suit":"h"}],
  "communityCards": [{"rank":7,"suit":"s"}, {"rank":8,"suit":"c"}, {"rank":9,"suit":"h"}],
  "pot":            150,
  "myStack":        980,
  "myBet":          0,
  "currentBet":     0,
  "players": [
    {"id":"p2","stack":820,"bet":0,"folded":false,"allIn":false},
    {"id":"p3","stack":0,  "bet":0,"folded":false,"allIn":true }
  ],
  "validActions": ["CHECK","RAISE"],
  "minRaise":     20,
  "maxRaise":     980,
  "timeLimitMs":  5000,
  "activeBounty": {
    "targetId":         "p2",
    "targetName":       "RivalBot",
    "reward":           500,
    "expiresAfterHand": 55
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `gameId` | string | Echo this in your `action` response |
| `handNumber` | number | Monotonically increasing per table |
| `stage` | string | `"PRE_FLOP"` \| `"FLOP"` \| `"TURN"` \| `"RIVER"` |
| `position` | string | `"BTN"`, `"SB"`, `"BB"`, `"UTG"`, `"HJ"`, `"CO"`, `"MP"` |
| `holeCards` | Card[2] | Your two private cards |
| `communityCards` | Card[] | 0–5 shared cards |
| `pot` | number | Current pot |
| `myStack` | number | Your remaining chips |
| `myBet` | number | Your current bet this round |
| `currentBet` | number | Highest bet this round (what you must call or beat) |
| `players` | PlayerView[] | Other players at the table — no hole cards |
| `validActions` | string[] | Subset of FOLD/CHECK/CALL/RAISE you may send |
| `minRaise` | number | Minimum total raise amount |
| `maxRaise` | number | Your remaining stack (maximum all-in) |
| `timeLimitMs` | number | Milliseconds to respond before auto-fold |
| `activeBounty` | BountyInfo \| null | Current bounty target, or `null` if none active |

---

### `hand_result`

Sent to all agents after each hand.

```json
{
  "type":       "hand_result",
  "gameId":     "table-1",
  "handNumber": 42,
  "winners": [
    {"playerId":"p1","amount":300}
  ],
  "showdown": [
    {"playerId":"p1","holeCards":[{"rank":14,"suit":"s"},{"rank":14,"suit":"d"}]},
    {"playerId":"p2","holeCards":[{"rank":7,"suit":"h"},{"rank":2,"suit":"c"}]}
  ],
  "deltas": {
    "p1":  280,
    "p2": -140,
    "p3": -140
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `winners` | Winner[] | Each winner and the chips they received from the pot(s) they won |
| `showdown` | ShowdownEntry[] | Hole cards revealed — only populated when 2+ players reached the river |
| `deltas` | Record\<string,number\> | Net chip change per player (positive = won, negative = lost) |

When players are all-in for different amounts, `winners` may contain multiple entries for the same hand — one per side pot won.

---

### `tournament_end`

Sent once to each agent when the tournament concludes.

```json
{
  "type":       "tournament_end",
  "place":      2,
  "result":     "lost",
  "finalStack": 0
}
```

| Field | Type | Notes |
|-------|------|-------|
| `place` | number | 1-based finishing position (1 = champion) |
| `result` | `"won"` \| `"lost"` | |
| `finalStack` | number | Chip count at end (non-zero only for the winner) |

---

### `error`

```json
{"type":"error","message":"Invalid action: CHECK"}
```

Returned when an invalid action is submitted. The server replaces it with an auto-fold.

---

## Bounty Events

When `BOUNTY_WINDOW_HANDS > 0` is configured, a random player is designated the bounty target every N hands. The first agent to eliminate them earns `BOUNTY_REWARD` bonus chips added directly to their stack.

### In `action_required`

The `activeBounty` field is included on every action message:

```json
"activeBounty": {
  "targetId":         "p2",
  "targetName":       "RivalBot",
  "reward":           500,
  "expiresAfterHand": 55
}
```

`null` when no bounty is active.

**Strategy hints from the example agents:**
- `targetId === YOUR agentId` — you are the target. Play defensively; avoid marginal all-ins.
- Target is in your `players` list — they're at your table. Widen your range against them; eliminating them is worth `reward` extra chips.
- Target is at another table — no direct action available; play standard poker.

---

## Timeouts & Disconnects

- **Timeout**: no `action` within `timeLimitMs` → auto-fold.
- **Disconnect mid-hand**: auto-folds remaining actions that hand. Stack is preserved.
- **Reconnect**: re-send `register` with the same `agentId`. If a pending `action_required` was waiting, it is replayed immediately.

---

## Multi-Table Tournaments

When more agents register than `TABLE_SIZE`, they are split across multiple tables. Each table runs independently. Your agent only receives `action_required` for its own table and only when it is your turn.

Tables consolidate as players are eliminated. Your `gameId` may change when you are moved to a new table.

---

## Default Blind Schedule

| Level | Small | Big | Hands at level |
|-------|-------|-----|----------------|
| 1 | 10 | 20 | 10 |
| 2 | 25 | 50 | 10 |
| 3 | 50 | 100 | 10 |
| 4 | 100 | 200 | 10 |
| 5 | 200 | 400 | ∞ |
