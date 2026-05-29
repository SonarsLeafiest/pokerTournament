---
name: strategy
description: Analyse a poker hand situation and explain the optimal play. Great for debugging why an agent made a bad decision, or for prototyping the logic before writing code. Pass a description or JSON game state as the argument, e.g. /strategy I have A♠K♠ on a Q♠J♦2♥ flop, pot is 300, opponent bets 200 into me, I have 800 behind
---

# Poker Strategy Analysis

Analyse the hand situation provided and give a clear, reasoned recommendation.

## What to cover

### 1. Hand strength

Evaluate the current made hand and draw equity:

- What's the best 5-card hand right now?
- Are there flush draws, straight draws, or combo draws?
- Roughly how many outs are live?

### 2. Pot odds and equity

- **Pot odds**: what % equity is needed to call profitably?
- **Estimated equity**: approximate equity vs. a reasonable opponent range
- Is a call +EV, -EV, or borderline?

### 3. Position and stack depth

- How does position affect the decision?
- Are stack sizes relevant (e.g. is a raise pot-committed)?

### 4. Bounty context (if mentioned)

- Does an active bounty change the decision?
  - If the player **is** the bounty target → tighten up, avoid marginal spots
  - If the **opponent** is the bounty target → widen to pressure them

### 5. Recommended action

State the recommendation clearly:

```
RAISE to [amount]   — because …
CALL                — because …
FOLD                — because …
CHECK               — because …
```

### 6. How to implement this in agent code

If the user is debugging their agent, show the concrete prompt text or logic change that would produce the correct decision. For example:

```python
# In build_prompt():
if state['myStack'] / state['pot'] < 1.5:
    prompt += "\nNote: you are committed to this pot — factor stack depth into your raise sizing."
```

## Format

Keep the analysis tight — one paragraph per section, no padding. Lead with the recommendation, then justify it. End with a one-sentence agent implementation tip if relevant.
