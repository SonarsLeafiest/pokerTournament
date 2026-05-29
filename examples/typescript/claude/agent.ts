/**
 * Anthropic SDK Poker Agent (TypeScript)
 *
 * Uses the Anthropic SDK directly with two latency optimisations:
 *
 *   Prompt caching   — the static game context is marked with cache_control
 *                      so Anthropic re-uses it for 5 minutes across hands.
 *   Response prefill — the assistant turn starts with '{"action":' so the
 *                      model skips any preamble and continues straight to JSON.
 *
 * Typical latency: 1-2 s (vs 10-15 s via CLI subprocess).
 *
 * Setup:
 *   cp .env.example .env   # set ANTHROPIC_API_KEY and AGENT_ID
 *   npm install
 *   npm start
 */

import Anthropic from "@anthropic-ai/sdk";
import WebSocket from "ws";
import { config } from "dotenv";

config();

const SERVER_URL  = process.env.POKER_SERVER  ?? "ws://localhost:3000";
const AGENT_ID    = process.env.AGENT_ID      ?? "ts-claude-1";
const AGENT_NAME  = process.env.AGENT_NAME    ?? "TSClaudeBot";
const MODEL       = process.env.CLAUDE_MODEL  ?? "claude-haiku-4-5-20251001";

const client = new Anthropic();

const RANK_LABELS: Record<number, string> = { 14: "A", 13: "K", 12: "Q", 11: "J", 10: "T" };
const SUIT_LABELS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

interface Card   { rank: number; suit: string }
interface Player { id: string; stack: number; bet: number; folded: boolean; allIn: boolean }
interface BountyInfo { targetId: string; targetName: string; reward: number; expiresAfterHand: number }

interface ActionRequired {
  type: "action_required";
  gameId: string; handNumber: number; stage: string; position: string;
  holeCards: Card[]; communityCards: Card[];
  pot: number; myStack: number; myBet: number; currentBet: number;
  players: Player[]; validActions: string[];
  minRaise: number; maxRaise: number; timeLimitMs: number;
  activeBounty: BountyInfo | null;
}

function fmtCard(c: Card): string {
  return `${RANK_LABELS[c.rank] ?? c.rank}${SUIT_LABELS[c.suit] ?? c.suit}`;
}
function fmtCards(cards: Card[]): string {
  return cards.length ? cards.map(fmtCard).join(" ") : "none";
}

// ── Cached static context ────────────────────────────────────────────────────

const STATIC_CONTEXT = `You are playing Texas Hold'em in a poker tournament. Make the best play.
Respond ONLY with a JSON object — no preamble, no explanation outside JSON.
Format: {"action":"FOLD|CHECK|CALL|RAISE","amount":<int if RAISE>,"reasoning":"<one sentence>"}`;

function buildBountySection(state: ActionRequired): string {
  const b = state.activeBounty;
  if (!b) return "";
  if (b.targetId === AGENT_ID)
    return `\n⚠️ BOUNTY ON YOU: +${b.reward.toLocaleString()} chips to whoever eliminates you before hand ${b.expiresAfterHand}. Play defensively.\n`;
  const atTable = state.players.some(p => p.id === b.targetId);
  if (atTable)
    return `\n💰 BOUNTY TARGET HERE: ${b.targetName} worth +${b.reward.toLocaleString()} chips if eliminated before hand ${b.expiresAfterHand}. Widen your range against them.\n`;
  return `\n💰 ACTIVE BOUNTY: ${b.targetName} at another table (+${b.reward.toLocaleString()} chips, exp. h.${b.expiresAfterHand}).\n`;
}

function buildPrompt(state: ActionRequired): string {
  const raiseInfo = state.validActions.includes("RAISE")
    ? `\n  Raise range: ${state.minRaise} – ${state.maxRaise}` : "";
  const opponents = state.players
    .map(p => `  - ${p.id}: stack=${p.stack.toLocaleString()}, bet=${p.bet}, `
             + (p.folded ? "folded" : p.allIn ? "all-in" : "active"))
    .join("\n");

  return `${buildBountySection(state)}
YOUR HAND:    ${fmtCards(state.holeCards)}
COMMUNITY:    ${fmtCards(state.communityCards)}
STAGE:        ${state.stage}  (hand #${state.handNumber})
POSITION:     ${state.position}
POT:          ${state.pot.toLocaleString()}
MY STACK:     ${state.myStack.toLocaleString()}
MY BET:       ${state.myBet.toLocaleString()}
CURRENT BET:  ${state.currentBet.toLocaleString()}
OPPONENTS:
${opponents || "  (none visible)"}

VALID ACTIONS: ${state.validActions.join(", ")}${raiseInfo}`;
}

const PREFILL = '{"action":';

function extractJson(continuation: string): Record<string, unknown> {
  const raw = PREFILL + continuation;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") { depth--; if (depth === 0) return JSON.parse(raw.slice(0, i + 1)); }
  }
  return JSON.parse(raw);
}

async function decide(state: ActionRequired): Promise<{ action: string; amount?: number }> {
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 120,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: STATIC_CONTEXT,     cache_control: { type: "ephemeral" } } as any,
            { type: "text", text: buildPrompt(state) },
          ],
        },
        { role: "assistant", content: PREFILL },
      ],
    } as any);

    const decision = extractJson((resp.content[0] as any).text ?? "");
    const action   = String(decision.action ?? "FOLD").toUpperCase();
    const reasoning = String(decision.reasoning ?? "");

    if (reasoning) {
      const amt = action === "RAISE" && decision.amount != null ? ` ${decision.amount}` : "";
      console.log(`  [${AGENT_NAME}] ${action}${amt} — ${reasoning}`);
    }
    if (!state.validActions.includes(action)) return { action: "FOLD" };

    const out: { action: string; amount?: number } = { action };
    if (action === "RAISE" && decision.amount != null) {
      let amt = Math.round(Number(decision.amount));
      amt = Math.max(state.minRaise, Math.min(state.maxRaise, amt));
      out.amount = amt;
    }
    return out;
  } catch (err) {
    console.log(`  [${AGENT_NAME}] error: ${err instanceof Error ? err.message : err} — folding`);
    return { action: "FOLD" };
  }
}

// Use const binding so the type check compiles; value set at top of file.
const model = MODEL;

async function run(): Promise<void> {
  console.log(`Connecting to ${SERVER_URL} as ${AGENT_NAME} (${AGENT_ID}) via Anthropic SDK [${model}]`);

  const ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "register", agentId: AGENT_ID, agentName: AGENT_NAME }));
  });

  ws.on("message", async (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "register_ack") {
      console.log(`Registered as ${msg.agentName}. Reasoning window: ${msg.timeLimitMs}ms  Setup: ${msg.setupMs ?? "?"}ms`);
      console.log("Waiting for hands…");

    } else if (msg.type === "action_required") {
      ws.send(JSON.stringify({ type: "action_ack", gameId: msg.gameId }));
      const action = await decide(msg as ActionRequired);
      ws.send(JSON.stringify({ type: "action", gameId: msg.gameId, ...action }));

    } else if (msg.type === "hand_result") {
      const delta: number | undefined = msg.deltas?.[AGENT_ID];
      if (delta != null) console.log(delta > 0 ? `Won  hand #${msg.handNumber}  +${delta}` : `Lost hand #${msg.handNumber}  ${delta}`);
      if (msg.showdown?.length && msg.communityCards?.length) {
        const board = msg.communityCards.map((c: Card) => fmtCard(c)).join(" ");
        const hands = msg.showdown.map((s: any) =>
          `${s.playerId} ${s.holeCards.map((c: Card) => fmtCard(c)).join(" ")}${s.handRank ? ` (${s.handRank})` : ""}`
        ).join(", ");
        console.log(`  Showdown — Board: ${board}  ·  ${hands}`);
      }

    } else if (msg.type === "bounty_announced") {
      if (msg.targetId === AGENT_ID)
        console.log(`\n⚠️ BOUNTY ON ME! +${msg.reward} chips, expires h.${msg.expiresAfterHand}\n`);
      else
        console.log(`💰 Bounty: ${msg.targetName} +${msg.reward}, exp. h.${msg.expiresAfterHand}`);

    } else if (msg.type === "bounty_claimed") {
      if (msg.claimedById === AGENT_ID)
        console.log(`🎯 Claimed bounty on ${msg.targetName}! +${msg.reward}`);

    } else if (msg.type === "bounty_expired") {
      console.log(`⌛ Bounty on ${msg.targetName} expired`);

    } else if (msg.type === "bounty_curse_required") {
      const target = (msg.availableTargets as any[]).reduce((best: any, t: any) => t.stack > best.stack ? t : best);
      ws.send(JSON.stringify({ type: "bounty_curse", targetId: target.id }));
      console.log(`💀 Cursing ${target.name} (-${msg.curseAmount} chips)`);

    } else if (msg.type === "bounty_cursed") {
      if (msg.targetId === AGENT_ID)
        console.log(`😤 Cursed by ${msg.curserName} — -${msg.amount} chips!`);

    } else if (msg.type === "tournament_update") {
      const me = msg.standings?.find((p: any) => p.playerId === AGENT_ID);
      if (me) console.log(`Stack: ${me.stack.toLocaleString()}  |  Blinds ${msg.smallBlind}/${msg.bigBlind}`);

    } else if (msg.type === "tournament_end") {
      if (msg.result === "won")
        console.log(`\n🏆 Tournament WINNER!  Final stack: ${msg.finalStack.toLocaleString()}\n`);
      else
        console.log(`\nTournament ended.  Place: #${msg.place}  Final stack: ${msg.finalStack.toLocaleString()}\n`);
      ws.close();

    } else if (msg.type === "error") {
      console.log(`Server error: ${msg.message}`);
    }
  });

  ws.on("close", () => console.log("Disconnected."));
  ws.on("error", (err: Error) => console.error("WebSocket error:", err.message));
}

run();
