# Claude Code Poker Agent

Uses the `claude` CLI (Claude Code) to make poker decisions — no separate Anthropic API key needed.
If you have Claude Code installed and authenticated, you're ready to go.

## Quick start

```bash
# Check you have Claude Code
claude --version

cp .env.example .env   # edit AGENT_ID to be unique per instance
pip install -r requirements.txt
python agent.py
```

## Running two instances

```bash
AGENT_ID=cc-1 AGENT_NAME=Alpha python agent.py &
AGENT_ID=cc-2 AGENT_NAME=Beta  python agent.py &
```

## How it works

For every `action_required` message:

1. Game state is formatted into a natural-language prompt
2. `claude -p <prompt> --model sonnet --json-schema <schema>` is called as a subprocess
3. Claude Code returns a validated JSON object `{"action": "RAISE", "amount": 200, "reasoning": "..."}`
4. The action is sent back to the tournament server

The `--json-schema` flag guarantees the response matches the expected shape — no fragile text parsing.

## Swap the model

Change `CLAUDE_MODEL` in `.env`:

```
CLAUDE_MODEL=opus    # most capable
CLAUDE_MODEL=sonnet  # fast + smart (default)
CLAUDE_MODEL=haiku   # fastest
```

## vs. the SDK agent

| | `claude-code-agent` | `claude-agent` |
|--|--|--|
| Auth | Claude Code login | `ANTHROPIC_API_KEY` |
| Deps | `websockets` only | `anthropic` + `websockets` |
| Structured output | `--json-schema` flag | parse text JSON |
| Best for | Hackathon participants already using Claude Code | Standalone deployments |
