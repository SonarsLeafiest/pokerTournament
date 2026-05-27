#!/usr/bin/env php
<?php
/**
 * GitHub Models Poker Agent (PHP)
 *
 * Uses the GitHub Models inference API (OpenAI-compatible) with your GITHUB_TOKEN.
 * No paid subscription needed — a free GitHub personal access token is enough.
 *
 * Available models: gpt-4o, gpt-4o-mini, meta-llama-3.1-70b-instruct, mistral-large, and more.
 * Full list: https://github.com/marketplace/models
 *
 * Setup:
 *   cp .env.example .env   # fill in GITHUB_TOKEN and a unique AGENT_ID
 *   composer install
 *   php agent.php
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
        $val = trim(preg_replace('/#.*$/', '', $val));
        putenv("$key=$val");
    }
}

$SERVER_URL   = getenv('POKER_SERVER')  ?: 'ws://localhost:3000';
$AGENT_ID     = getenv('AGENT_ID')     ?: 'php-gh-1';
$AGENT_NAME   = getenv('AGENT_NAME')   ?: 'PHPGitHubBot';
$GITHUB_TOKEN = getenv('GITHUB_TOKEN') ?: '';
$MODEL        = getenv('GITHUB_MODEL') ?: 'gpt-4o-mini';

const GH_API_URL = 'https://models.inference.ai.azure.com/chat/completions';

$RANK_LABELS = [14 => 'A', 13 => 'K', 12 => 'Q', 11 => 'J', 10 => 'T'];
$SUIT_LABELS = ['s' => '♠', 'h' => '♥', 'd' => '♦', 'c' => '♣'];

function fmtCard(array $card): string {
    global $RANK_LABELS, $SUIT_LABELS;
    $r = $RANK_LABELS[$card['rank']] ?? (string)$card['rank'];
    $s = $SUIT_LABELS[$card['suit']] ?? $card['suit'];
    return $r . $s;
}

function fmtCards(array $cards): string {
    return $cards ? implode(' ', array_map('fmtCard', $cards)) : 'none';
}

function buildPrompt(array $state): string {
    $raiseInfo = in_array('RAISE', $state['validActions'])
        ? "\n  Raise range: {$state['minRaise']} – {$state['maxRaise']}"
        : '';

    $opponents = implode("\n", array_map(function ($p) {
        $status = $p['folded'] ? 'folded' : ($p['allIn'] ? 'all-in' : 'active');
        return "  - {$p['id']}: stack=" . number_format($p['stack']) . ", bet={$p['bet']}, $status";
    }, $state['players'] ?? []));

    return "You are playing Texas Hold'em in a poker tournament. Make the best play.

YOUR HAND:    " . fmtCards($state['holeCards']) . "
COMMUNITY:    " . fmtCards($state['communityCards']) . "
STAGE:        {$state['stage']}
POSITION:     {$state['position']}
POT:          " . number_format($state['pot']) . "
MY STACK:     " . number_format($state['myStack']) . "
MY BET:       " . number_format($state['myBet']) . "
CURRENT BET:  " . number_format($state['currentBet']) . "
OPPONENTS:
" . ($opponents ?: '  (none visible)') . "

VALID ACTIONS: " . implode(', ', $state['validActions']) . $raiseInfo . "

Respond with JSON only:
{\"action\": \"FOLD|CHECK|CALL|RAISE\", \"amount\": <chips if RAISE>, \"reasoning\": \"<one sentence>\"}";
}

function callGitHubModels(string $prompt): array {
    global $GITHUB_TOKEN, $MODEL;

    $isGpt = str_contains(strtolower($MODEL), 'gpt');

    $body = [
        'model'       => $MODEL,
        'messages'    => [
            ['role' => 'system', 'content' => 'You are a poker expert. Always respond with valid JSON.'],
            ['role' => 'user',   'content' => $prompt],
        ],
        'temperature' => 0.7,
        'max_tokens'  => 150,
    ];
    if ($isGpt) $body['response_format'] = ['type' => 'json_object'];

    $ch = curl_init(GH_API_URL);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($body),
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . $GITHUB_TOKEN,
        ],
        CURLOPT_TIMEOUT        => 30,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($response === false || $httpCode !== 200) {
        throw new RuntimeException("GitHub Models API error ($httpCode): $response");
    }

    return json_decode($response, true, 512, JSON_THROW_ON_ERROR);
}

function decide(array $state): array {
    global $AGENT_NAME, $GITHUB_TOKEN;

    if (!$GITHUB_TOKEN) {
        echo "  [$AGENT_NAME] ⚠ GITHUB_TOKEN not set — folding\n";
        return ['action' => 'FOLD'];
    }

    try {
        $result = callGitHubModels(buildPrompt($state));
        $text   = trim($result['choices'][0]['message']['content'] ?? '');

        if (str_starts_with($text, '```')) {
            $text = explode('```', $text)[1];
            $text = ltrim(preg_replace('/^json\s*/i', '', $text));
        }

        $decision  = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
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
    }
}

// ── WebSocket loop ────────────────────────────────────────────────────────────

echo "Connecting to $SERVER_URL as $AGENT_NAME ($AGENT_ID) via GitHub Models [$MODEL]\n";
if (!$GITHUB_TOKEN) {
    echo "  ⚠  WARNING: GITHUB_TOKEN not set.\n";
    echo "  Get a free token at https://github.com/settings/tokens (no scopes needed for public models)\n";
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
