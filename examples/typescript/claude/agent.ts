/**
 * Claude Code Poker Agent (TypeScript)
 *
 * Uses the `claude` CLI (Claude Code) — no API key config needed beyond
 * what Claude Code already has set up.
 *
 * Setup:
 *   cp .env.example .env   # set POKER_SERVER and a unique AGENT_ID
 *   npm install
 *   npx ts-node agent.ts   # or: npm start
 *
 * Requires: Claude Code CLI installed and authenticated (`claude --version`)
 */

import WebSocket from "ws";
import { execFileSync } from "child_process";
import { config } from "dotenv";

config();

const SERVER_URL = process.env.POKER_SERVER ?? "ws://localhost:3000";
const AGENT_ID   = process.env.AGENT_ID    ?? "ts-claude-1";
const AGENT_NAME = process.env.AGENT_NAME  ?? "TSClaudeBot";
const MODEL      = process.env.CLAUDE_MODEL ?? "sonnet"; // sonnet | opus | haiku

const RANK_LABELS: Record<number, string> = { 14: "A", 13: "K", 12: "Q", 11: "J", 10: "T" };
const SUIT_LABELS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

interface Card { rank: number; suit: string }
interface Player { id: string; stack: number; bet: number; folded: boolean; allIn: boolean }

interface ActionRequired {
  type: "action_required";
  gameId: string;
  holeCards: Card[];
  communityCards: Card[];
  stage: string;
  position: string;
  pot: number;
  myStack: number;
  myBet: number;
  currentBet: number;
  validActions: string[];
  minRaise: number;
  maxRaise: number;
  players: Player[];
}

const ACTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    action:    { type: "string", enum: ["FOLD", "CHECK", "CALL", "RAISE"] },
    amount:    { type: "integer", description: "Chips to raise (only when action=RAISE)" },
    reasoning: { type: "string",  description: "One sentence explaining the decision" },
  },
  required: ["action", "reasoning"],
});

function fmtCard(c: Card): string {
  const r = RANK_LABELS[c.rank] ?? String(c.rank);
  const s = SUIT_LABELS[c.suit] ?? c.suit;
  return `${r}${s}`;
}

function fmtCards(cards: Card[]): string {
  return cards.length ? cards.map(fmtCard).join(" ") : "none";
}

function buildPrompt(state: ActionRequired): string {
  const raiseInfo = state.validActions.includes("RAISE")
    ? `\n  Raise range: ${state.minRaise} – ${state.maxRaise}`
    : "";

  const opponents = state.players
    .map(p => `  - ${p.id}: stack=${p.stack.toLocaleString()}, bet=${p.bet}, `
             + (p.folded ? "folded" : p.allIn ? "all-in" : "active"))
    .join("\n");

  return `You are playing Texas Hold'em in a poker tournament. Make the best play.

YOUR HAND:    ${fmtCards(state.holeCards)}
COMMUNITY:    ${fmtCards(state.communityCards)}
STAGE:        ${state.stage}
POSITION:     ${state.position}
POT:          ${state.pot.toLocaleString()}
MY STACK:     ${state.myStack.toLocaleString()}
MY BET:       ${state.myBet.toLocaleString()}
CURRENT BET:  ${state.currentBet.toLocaleString()}
OPPONENTS:
${opponents || "  (none visible)"}

VALID ACTIONS: ${state.validActions.join(", ")}${raiseInfo}

Choose the best action. If raising, pick a strategically sound bet size.`;
}

function decide(state: ActionRequired): { action: string; amount?: number } {
  try {
    const output = execFileSync(
      "claude",
      ["-p", buildPrompt(state), "--model", MODEL, "--output-format", "json", "--json-schema", ACTION_SCHEMA],
      { encoding: "utf8", timeout: 30_000 },
    );

    const data = JSON.parse(output);
    const decision: Record<string, unknown> =
      data.structured_output ?? JSON.parse(String(data.result ?? "{}").replace(/^```json?\s*/i, "").replace(/```$/, ""));

    const action = String(decision.action ?? "FOLD").toUpperCase();
    const reasoning = String(decision.reasoning ?? "");

    if (reasoning) {
      const amtStr = action === "RAISE" && decision.amount != null ? ` ${decision.amount}` : "";
      console.log(`  [${AGENT_NAME}] ${action}${amtStr} — ${reasoning}`);
    }

    if (!state.validActions.includes(action)) {
      console.log(`  [${AGENT_NAME}] invalid action ${JSON.stringify(action)}, folding`);
      return { action: "FOLD" };
    }

    const out: { action: string; amount?: number } = { action };
    if (action === "RAISE" && decision.amount != null) {
      let amt = Math.round(Number(decision.amount));
      amt = Math.max(state.minRaise, Math.min(state.maxRaise, amt));
      out.amount = amt;
    }
    return out;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [${AGENT_NAME}] error: ${msg} — folding`);
    return { action: "FOLD" };
  }
}

function run(): void {
  console.log(`Connecting to ${SERVER_URL} as ${AGENT_NAME} (${AGENT_ID}) via claude CLI [${MODEL}]`);

  const ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "register", agentId: AGENT_ID, agentName: AGENT_NAME }));
    console.log("Registered. Waiting for hands…");
  });

  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "action_required") {
      const action = decide(msg as ActionRequired);
      ws.send(JSON.stringify({ type: "action", gameId: msg.gameId, ...action }));

    } else if (msg.type === "hand_result") {
      const delta: number | undefined = msg.deltas?.[AGENT_ID];
      if (delta != null) {
        console.log(delta > 0
          ? `Won  hand #${msg.handNumber}  +${delta}`
          : `Lost hand #${msg.handNumber}  ${delta}`);
      }

    } else if (msg.type === "tournament_update") {
      const me = msg.standings?.find((p: { playerId: string }) => p.playerId === AGENT_ID);
      if (me) console.log(`Stack: ${me.stack.toLocaleString()}  |  Blinds ${msg.smallBlind}/${msg.bigBlind}`);

    } else if (msg.type === "tournament_end") {
      if (msg.result === "won") {
        console.log(`\n🏆  Tournament WINNER!  Place: #${msg.place}  Final stack: ${msg.finalStack}\n`);
      } else {
        console.log(`\nTournament ended.  Place: #${msg.place}  Final stack: ${msg.finalStack}\n`);
      }
      ws.close();

    } else if (msg.type === "error") {
      console.log(`Server error: ${msg.message}`);
    }
  });

  ws.on("close", () => console.log("Disconnected."));
  ws.on("error", (err: Error) => console.error("WebSocket error:", err.message));
}

run();
