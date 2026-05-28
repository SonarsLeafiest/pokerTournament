#!/usr/bin/env php
<?php
/**
 * Claude Code Poker Agent (PHP)
 *
 * Uses the `claude` CLI (Claude Code) — no API key config needed beyond
 * what Claude Code already has set up.
 *
 * Setup:
 *   cp .env.example .env   # set POKER_SERVER and a unique AGENT_ID
 *   composer install
 *   php agent.php
 *
 * Requires: Claude Code CLI installed and authenticated (`claude --version`)
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Ratchet\Client\WebSocket;
use React\EventLoop\Loop;

// Load .env
if (file_exists(__DIR__ . '/.env')) {
    foreach (file(__DIR__ . '/.env') as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) continue;
        [$key, $val] = array_map('trim', explode('=', $line, 2));
        // strip inline comments
        $val = preg_replace('/#.*$/', '', $val);
        $val = trim($val);
        putenv("$key=$val");
    }
}

$SERVER_URL = getenv('POKER_SERVER')   ?: 'ws://localhost:3000';
$AGENT_ID   = getenv('AGENT_ID')      ?: 'php-claude-1';
$AGENT_NAME = getenv('AGENT_NAME')    ?: 'PHPClaudeBot';
$MODEL      = getenv('CLAUDE_MODEL')  ?: 'sonnet'; // sonnet | opus | haiku

$RANK_LABELS = [14 => 'A', 13 => 'K', 12 => 'Q', 11 => 'J', 10 => 'T'];
$SUIT_LABELS = ['s' => '♠', 'h' => '♥', 'd' => '♦', 'c' => '♣'];

$ACTION_SCHEMA = json_encode([
    'type'       => 'object',
    'properties' => [
        'action'    => ['type' => 'string', 'enum' => ['FOLD', 'CHECK', 'CALL', 'RAISE']],
        'amount'    => ['type' => 'integer', 'description' => 'Chips to raise (only when action=RAISE)'],
        'reasoning' => ['type' => 'string',  'description' => 'One sentence explaining the decision'],
    ],
    'required' => ['action', 'reasoning'],
]);

function fmtCard(array $card): string {
    global $RANK_LABELS, $SUIT_LABELS;
    $r = $RANK_LABELS[$card['rank']] ?? (string)$card['rank'];
    $s = $SUIT_LABELS[$card['suit']] ?? $card['suit'];
    return $r . $s;
}

function fmtCards(array $cards): string {
    return $cards ? implode(' ', array_map('fmtCard', $cards)) : 'none';
}

function buildBountySection(array $state): string {
    global $AGENT_ID;
    $b = $state['activeBounty'] ?? null;
    if (!$b) return '';

    $reward     = number_format((int)$b['reward']);
    $expires    = $b['expiresAfterHand'];
    $targetId   = $b['targetId'];
    $targetName = $b['targetName'];

    if ($targetId === $AGENT_ID) {
        return "\n⚠️  BOUNTY ON YOU: You are the current bounty target! "
             . "Opponents earn $reward bonus chips if they eliminate you before hand $expires. "
             . "Play conservatively — avoid large all-in confrontations unless you have a very strong hand.\n";
    }

    $atTable = !empty(array_filter($state['players'] ?? [], fn($p) => $p['id'] === $targetId));
    if ($atTable) {
        return "\n💰 BOUNTY TARGET HERE: $targetName is the bounty target at this table. "
             . "You earn $reward bonus chips if you eliminate them before hand $expires. "
             . "Widen your calling/raising range against $targetName to pressure them out of chips.\n";
    }

    return "\n💰 ACTIVE BOUNTY: $targetName has a bounty at another table "
         . "($reward chips, expires hand $expires). Focus on standard play.\n";
}

function buildPrompt(array $state): string {
    $raiseInfo = in_array('RAISE', $state['validActions'])
        ? "\n  Raise range: {$state['minRaise']} – {$state['maxRaise']}"
        : '';

    $opponents = implode("\n", array_map(function ($p) {
        $status = $p['folded'] ? 'folded' : ($p['allIn'] ? 'all-in' : 'active');
        return "  - {$p['id']}: stack=" . number_format($p['stack']) . ", bet={$p['bet']}, $status";
    }, $state['players'] ?? []));

    $bountySection = buildBountySection($state);
    $handNum = $state['handNumber'] ?? '?';

    return "You are playing Texas Hold'em in a poker tournament. Make the best play.
{$bountySection}
YOUR HAND:    " . fmtCards($state['holeCards']) . "
COMMUNITY:    " . fmtCards($state['communityCards']) . "
STAGE:        {$state['stage']}   (hand #{$handNum})
POSITION:     {$state['position']}
POT:          " . number_format($state['pot']) . "
MY STACK:     " . number_format($state['myStack']) . "
MY BET:       " . number_format($state['myBet']) . "
CURRENT BET:  " . number_format($state['currentBet']) . "
OPPONENTS:
" . ($opponents ?: '  (none visible)') . "

VALID ACTIONS: " . implode(', ', $state['validActions']) . $raiseInfo . "

Choose the best action. If raising, pick a strategically sound bet size.";
}

function decide(array $state): array {
    global $AGENT_NAME, $MODEL, $ACTION_SCHEMA;

    if (!shell_exec('which claude 2>/dev/null')) {
        echo "  [$AGENT_NAME] ⚠ claude CLI not found — folding\n";
        return ['action' => 'FOLD'];
    }

    $prompt = buildPrompt($state);
    $tmpPrompt = tempnam(sys_get_temp_dir(), 'poker_prompt_');
    file_put_contents($tmpPrompt, $prompt);

    try {
        $cmd = sprintf(
            'claude -p %s --model %s --output-format json --json-schema %s 2>&1',
            escapeshellarg($prompt),
            escapeshellarg($MODEL),
            escapeshellarg($ACTION_SCHEMA)
        );

        $output = shell_exec($cmd);
        if ($output === null) throw new RuntimeException('claude CLI returned no output');

        $data     = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
        $decision = $data['structured_output']
            ?? json_decode(preg_replace('/^```json?\s*/i', '', rtrim($data['result'] ?? '{}', '` ')), true, 512, JSON_THROW_ON_ERROR);

        $action    = strtoupper($decision['action'] ?? 'FOLD');
        $reasoning = $decision['reasoning'] ?? '';

        if ($reasoning) {
            $amtStr = ($action === 'RAISE' && isset($decision['amount'])) ? " {$decision['amount']}" : '';
            echo "  [$AGENT_NAME] $action$amtStr — $reasoning\n";
        }

        if (!in_array($action, $state['validActions'])) {
            echo "  [$AGENT_NAME] invalid action '$action', folding\n";
            return ['action' => 'FOLD'];
        }

        $out = ['action' => $action];
        if ($action === 'RAISE' && isset($decision['amount'])) {
            $amt = (int)round((float)$decision['amount']);
            $amt = max($state['minRaise'], min($state['maxRaise'], $amt));
            $out['amount'] = $amt;
        }
        return $out;
    } catch (Throwable $e) {
        echo "  [$AGENT_NAME] error: {$e->getMessage()} — folding\n";
        return ['action' => 'FOLD'];
    } finally {
        @unlink($tmpPrompt);
    }
}

// ── WebSocket loop ────────────────────────────────────────────────────────────

echo "Connecting to $SERVER_URL as $AGENT_NAME ($AGENT_ID) via claude CLI [$MODEL]\n";
if (!shell_exec('which claude 2>/dev/null')) {
    echo "  ⚠  WARNING: claude CLI not found. Install Claude Code first.\n";
}

$loop = Loop::get();

\Ratchet\Client\connect($SERVER_URL, [], [], $loop)->then(
    function (WebSocket $ws) use ($AGENT_ID, $AGENT_NAME) {
        $ws->send(json_encode(['type' => 'register', 'agentId' => $AGENT_ID, 'agentName' => $AGENT_NAME]));
        echo "Registered. Waiting for hands…\n";

        $ws->on('message', function ($raw) use ($ws, $AGENT_ID) {
            $msg = json_decode((string)$raw, true);

            if ($msg['type'] === 'action_required') {
                $action = decide($msg);
                $ws->send(json_encode(array_merge(['type' => 'action', 'gameId' => $msg['gameId']], $action)));

            } elseif ($msg['type'] === 'hand_result') {
                $delta = $msg['deltas'][$AGENT_ID] ?? null;
                if ($delta !== null) {
                    echo ($delta > 0 ? "Won  " : "Lost ") . "hand #{$msg['handNumber']}  "
                       . ($delta > 0 ? "+$delta" : $delta) . "\n";
                }

            } elseif ($msg['type'] === 'bounty_announced') {
                if ($msg['targetId'] === $AGENT_ID) {
                    echo "\n⚠️  BOUNTY ON ME! {$msg['reward']} chips to whoever eliminates me before hand {$msg['expiresAfterHand']}\n\n";
                } else {
                    echo "💰 Bounty on {$msg['targetName']} — {$msg['reward']} chips, expires hand {$msg['expiresAfterHand']}\n";
                }

            } elseif ($msg['type'] === 'bounty_claimed') {
                if ($msg['claimedById'] === $AGENT_ID) {
                    echo "\n🎯 I claimed the bounty! Eliminated {$msg['targetName']} for +{$msg['reward']} bonus chips\n\n";
                } else {
                    echo "💰 Bounty claimed: {$msg['claimedByName']} eliminated {$msg['targetName']} (+{$msg['reward']})\n";
                }

            } elseif ($msg['type'] === 'bounty_expired') {
                echo "⌛ Bounty on {$msg['targetName']} expired unclaimed\n";

            } elseif ($msg['type'] === 'bounty_curse_required') {
                // Curse the player with the most chips — biggest threat
                $target = array_reduce($msg['availableTargets'], function($best, $t) {
                    return (!$best || $t['stack'] > $best['stack']) ? $t : $best;
                }, null);
                if ($target) {
                    $ws->send(json_encode(['type' => 'bounty_curse', 'targetId' => $target['id']]));
                    echo "  [$AGENT_NAME] 💀 Cursing {$target['name']} (-{$msg['curseAmount']} chips)\n";
                }

            } elseif ($msg['type'] === 'bounty_cursed') {
                if ($msg['targetId'] === $AGENT_ID) {
                    echo "  [$AGENT_NAME] 😤 Cursed by {$msg['curserName']} — -{$msg['amount']} chips!\n";
                }

            } elseif ($msg['type'] === 'tournament_update') {
                $me = null;
                foreach ($msg['standings'] as $p) {
                    if ($p['playerId'] === $AGENT_ID) { $me = $p; break; }
                }
                if ($me) echo 'Stack: ' . number_format($me['stack']) . "  |  Blinds {$msg['smallBlind']}/{$msg['bigBlind']}\n";

            } elseif ($msg['type'] === 'tournament_end') {
                if ($msg['result'] === 'won') {
                    echo "\n🏆  Tournament WINNER!  Place: #{$msg['place']}  Final stack: {$msg['finalStack']}\n\n";
                } else {
                    echo "\nTournament ended.  Place: #{$msg['place']}  Final stack: {$msg['finalStack']}\n\n";
                }
                $ws->close();

            } elseif ($msg['type'] === 'error') {
                echo "Server error: {$msg['message']}\n";
            }
        });

        $ws->on('close', fn() => print("Disconnected.\n"));
    },
    function (Throwable $e) {
        echo "Could not connect: {$e->getMessage()}\n";
    }
);

$loop->run();
