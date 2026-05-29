/**
 * GitHub Models Poker Agent (TypeScript)
 *
 * Uses the GitHub Models inference API (OpenAI-compatible) with your GITHUB_TOKEN.
 * No paid subscription needed — a free GitHub personal access token is enough.
 *
 * Available models: gpt-4o, gpt-4o-mini, meta-llama-3.1-70b-instruct, mistral-large, and more.
 * Full list: https://github.com/marketplace/models
 *
 * Setup:
 *   cp .env.example .env   # fill in GITHUB_TOKEN and a unique AGENT_ID
 *   npm install
 *   npx ts-node agent.ts   # or: npm start
 */

import WebSocket from "ws";
import OpenAI from "openai";
import { config } from "dotenv";

config();

const SERVER_URL    = process.env.POKER_SERVER   ?? "ws://localhost:3000";
const AGENT_ID      = process.env.AGENT_ID       ?? "ts-gh-1";
const AGENT_NAME    = process.env.AGENT_NAME     ?? "TSGitHubBot";
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN   ?? "";
const MODEL         = process.env.GITHUB_MODEL   ?? "gpt-4o-mini";

const client = new OpenAI({
  baseURL: "https://models.inference.ai.azure.com",
  apiKey: GITHUB_TOKEN,
});

const RANK_LABELS: Record<number, string> = { 14: "A", 13: "K", 12: "Q", 11: "J", 10: "T" };
const SUIT_LABELS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

interface Card { rank: number; suit: string }
interface Player { id: string; stack: number; bet: number; folded: boolean; allIn: boolean }
interface BountyInfo {
  targetId: string;
  targetName: string;
  reward: number;
  expiresAfterHand: number;
}

interface ActionRequired {
  type: "action_required";
  gameId: string;
  handNumber: number;
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
  activeBounty: BountyInfo | null;
}

function fmtCard(c: Card): string {
  const r = RANK_LABELS[c.rank] ?? String(c.rank);
  const s = SUIT_LABELS[c.suit] ?? c.suit;
  return `${r}${s}`;
}

function fmtCards(cards: Card[]): string {
  return cards.length ? cards.map(fmtCard).join(" ") : "none";
}

function buildBountySection(state: ActionRequired): string {
  const b = state.activeBounty;
  if (!b) return "";

  if (b.targetId === AGENT_ID) {
    return `\n⚠️  BOUNTY ON YOU: You are the current bounty target! Opponents earn ${b.reward.toLocaleString()} bonus chips if they eliminate you before hand ${b.expiresAfterHand}. Play conservatively — avoid large all-in confrontations unless you have a very strong hand.\n`;
  }

  const targetAtTable = state.players.some(p => p.id === b.targetId);
  if (targetAtTable) {
    return `\n💰 BOUNTY TARGET HERE: ${b.targetName} is the bounty target at this table. You earn ${b.reward.toLocaleString()} bonus chips if you eliminate them before hand ${b.expiresAfterHand}. Widen your calling/raising range against ${b.targetName} to pressure them out of chips.\n`;
  }

  return `\n💰 ACTIVE BOUNTY: ${b.targetName} has a bounty at another table (${b.reward.toLocaleString()} chips, expires hand ${b.expiresAfterHand}). Focus on standard play.\n`;
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
${buildBountySection(state)}
YOUR HAND:    ${fmtCards(state.holeCards)}
COMMUNITY:    ${fmtCards(state.communityCards)}
STAGE:        ${state.stage}   (hand #${state.handNumber})
POSITION:     ${state.position}
POT:          ${state.pot.toLocaleString()}
MY STACK:     ${state.myStack.toLocaleString()}
MY BET:       ${state.myBet.toLocaleString()}
CURRENT BET:  ${state.currentBet.toLocaleString()}
OPPONENTS:
${opponents || "  (none visible)"}

VALID ACTIONS: ${state.validActions.join(", ")}${raiseInfo}

Respond with JSON only:
{"action": "FOLD|CHECK|CALL|RAISE", "amount": <chips if RAISE>, "reasoning": "<one sentence>"}`;
}

async function decide(state: ActionRequired): Promise<{ action: string; amount?: number }> {
  if (!GITHUB_TOKEN) {
    console.log(`  [${AGENT_NAME}] ⚠ GITHUB_TOKEN not set — folding`);
    return { action: "FOLD" };
  }

  try {
    const isGpt = MODEL.toLowerCase().includes("gpt");
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a poker expert. Always respond with valid JSON." },
        { role: "user",   content: buildPrompt(state) },
      ],
      temperature: 0.7,
      max_tokens: 150,
      ...(isGpt ? { response_format: { type: "json_object" } } : {}),
    });

    let text = response.choices[0].message.content?.trim() ?? "";
    if (text.startsWith("```")) text = text.split("```")[1].replace(/^json\s*/i, "").trim();

    const decision: Record<string, unknown> = JSON.parse(text);
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

async function run(): Promise<void> {
  console.log(`Connecting to ${SERVER_URL} as ${AGENT_NAME} (${AGENT_ID}) via GitHub Models [${MODEL}]`);
  if (!GITHUB_TOKEN) {
    console.log("  ⚠  WARNING: GITHUB_TOKEN not set.");
    console.log("  Get a free token at https://github.com/settings/tokens (no scopes needed for public models)");
  }

  const ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "register", agentId: AGENT_ID, agentName: AGENT_NAME }));
  });

  ws.on("message", async (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "register_ack") {
      console.log(`Registered as ${msg.agentName}. Send action_ack immediately, then reason within ${msg.timeLimitMs}ms (setup window: ${(msg as any).setupMs}ms).`);
      console.log("Waiting for hands…");

    } else if (msg.type === "action_required") {
      ws.send(JSON.stringify({ type: "action_ack", gameId: msg.gameId }))
      const action = await decide(msg as ActionRequired);
      ws.send(JSON.stringify({ type: "action", gameId: msg.gameId, ...action }));

    } else if (msg.type === "hand_result") {
      const delta: number | undefined = msg.deltas?.[AGENT_ID];
      if (delta != null) {
        console.log(delta > 0
          ? `Won  hand #${msg.handNumber}  +${delta}`
          : `Lost hand #${msg.handNumber}  ${delta}`);
      }

    } else if (msg.type === "bounty_announced") {
      if (msg.targetId === AGENT_ID) {
        console.log(`\n⚠️  BOUNTY ON ME! ${msg.reward} chips to whoever eliminates me before hand ${msg.expiresAfterHand}\n`);
      } else {
        console.log(`💰 Bounty on ${msg.targetName} — ${msg.reward} chips, expires hand ${msg.expiresAfterHand}`);
      }

    } else if (msg.type === "bounty_claimed") {
      if (msg.claimedById === AGENT_ID) {
        console.log(`\n🎯 I claimed the bounty! Eliminated ${msg.targetName} for +${msg.reward} bonus chips\n`);
      } else {
        console.log(`💰 Bounty claimed: ${msg.claimedByName} eliminated ${msg.targetName} (+${msg.reward})`);
      }

    } else if (msg.type === "bounty_expired") {
      console.log(`⌛ Bounty on ${msg.targetName} expired unclaimed`);

    } else if (msg.type === "bounty_curse_required") {
      const targets = (msg as any).availableTargets as Array<{id: string; name: string; stack: number}>;
      const target  = targets.reduce((best, t) => t.stack > best.stack ? t : best);
      ws.send(JSON.stringify({ type: "bounty_curse", targetId: target.id }));
      console.log(`💀 Cursing ${target.name} (-${(msg as any).curseAmount} chips)`);

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
