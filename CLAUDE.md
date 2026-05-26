# pokerTournament

A Texas Hold'em poker tournament platform for engineering team hackathons. Teams build AI agents that connect via WebSocket and compete in a managed tournament.

## Required Skills

All development MUST follow these two skills — they are non-negotiable on every task:

| Skill | Command | When |
|-------|---------|------|
| TDD Workflow | `/tdd-workflow` | Writing any new code — tests before production code, always |
| Verification Before Completion | `/verification-before-completion` | Before any completion claim, commit, or PR |

Both are defined as project slash commands in `.claude/commands/`.

## Agent Roles

This project uses two custom subagent roles defined in `.claude/agents/`:

| Agent | Model | File | Purpose |
|-------|-------|------|---------|
| **planner** | Opus | `.claude/agents/planner.md` | Architecture, scoping, task breakdown — delegates all implementation |
| **worker** | Sonnet | `.claude/agents/worker.md` | TDD implementation — no git operations, reports back to parent |

Use `@planner` when designing features or exploring the codebase before writing code. The planner dispatches workers for all implementation tasks.

## Randomness

All randomness (deck shuffles, tournament seeding, blind assignments) MUST be seeded from the ANU Quantum Random Number Generator:

- **Endpoint**: `https://qrng.anu.edu.au/API/jsonI.php?length=<n>&type=uint16`
- **Response**: `{"type":"uint16","length":4,"data":[27433,4257,7118,46195],"success":true}`
- **Parameters**: `length` (1–1024 numbers), `type` (`uint8`, `uint16`, or `hex16`)
- **Docs**: https://quantumnumbers.anu.edu.au/documentation

Implementation requirements:
- Fetch seed values at game/tournament start, not on every shuffle
- Timeout after 500ms and fall back to `crypto.randomBytes()` / `secrets.token_bytes()`
- Log whether quantum or fallback seed was used (relevant for audit/fairness)

## Repository

- **Repo**: `SonarsLeafiest/pokerTournament`
- **Branch strategy**: Push directly to `main`
- **Remote**: `https://github.com/SonarsLeafiest/pokerTournament`

## Project Structure

```
server/          # Game server — WebSocket hub, Texas Hold'em engine, tournament manager
dashboard/       # Live spectator web UI (real-time standings, hand replays)
starter-kit/     # Boilerplate agents for teams (Python + TypeScript)
docs/            # WebSocket protocol spec and participant guide
```

## Key Conventions

- **Language**: TypeScript (server + dashboard), Python (starter-kit examples)
- **Test runner**: Vitest
- **Coverage targets**: ≥90% on game engine / hand evaluator, ≥85% overall
- **WebSocket protocol**: JSON messages — see `docs/protocol.md`
- **Agent timeout**: 5000ms to respond per action or auto-fold
- **Commits**: Small and frequent; commit at each green TDD state
