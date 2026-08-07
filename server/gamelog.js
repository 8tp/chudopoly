// server/gamelog.js — durable per-game records so "how did I lose that?" is answerable.
//
// A finished game used to leave five console lines about room lifecycle and nothing about
// the game itself. This appends ONE JSONL line per finished game containing the seed, the
// resolved ruleset, the seat order and bot modes, the retained event stream and the final
// boards — enough to reconstruct the ending, and enough to replay it exactly when the game
// was seeded.
//
// Rules this module lives by:
//   * it can never throw into a room (every entry point is wrapped);
//   * it never blocks the event loop (async append, errors swallowed after one warning);
//   * it is bounded (byte cap with a single rotation, then it stops writing);
//   * it is opt-outable (CHUD_GAME_LOG=0/off/false).

const fs = require('fs');
const path = require('path');

const DIR = process.env.CHUD_GAME_LOG_DIR || path.join(__dirname, '..', 'logs');
const FILE = path.join(DIR, 'games.jsonl');
const ROTATED = path.join(DIR, 'games.1.jsonl');
// 32MB per file, one rotation kept: ~64MB worst case on a single-instance deploy.
const MAX_BYTES = Math.max(0, Number(process.env.CHUD_GAME_LOG_MAX_BYTES) || 32 * 1024 * 1024);

function enabled() {
  const raw = String(process.env.CHUD_GAME_LOG ?? '1').toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(raw);
}

let ready = false;
let bytes = 0;
let stopped = false;
let warned = false;

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn('[GAMELOG] disabled after write failure:', error?.message || error);
}

function ensureReady() {
  if (ready) return true;
  fs.mkdirSync(DIR, { recursive: true });
  try { bytes = fs.statSync(FILE).size; } catch { bytes = 0; }
  ready = true;
  return true;
}

// Appends are asynchronous, so the live file may not exist on disk yet when the in-process
// byte counter says it is time to rotate. A failed rotation must never stop logging — the
// worst case is one oversized file, which the next rotation trims.
function rotate() {
  bytes = 0;
  try {
    if (!fs.existsSync(FILE)) return;
    fs.rmSync(ROTATED, { force: true });
    fs.renameSync(FILE, ROTATED);
  } catch (error) {
    warnOnce(error);   // logged once, but logging continues
  }
}

function board(player) {
  return {
    id: player.id,
    name: player.name,
    eliminated: !!player.eliminated,
    finalApproach: !!player.finalApproach,
    handCount: player.hand.length,
    bank: player.bank.map(c => c.id),
    properties: Object.fromEntries(Object.entries(player.properties || {})
      .filter(([, cards]) => cards.length)
      .map(([color, cards]) => [color, cards.map(c => c.id)])),
    upgrades: Object.fromEntries(Object.entries(player.upgrades || {})
      .map(([color, ups]) => [color, ups.map(u => u.upgradeType || 'upgrade')])),
  };
}

function buildRecord(room, G) {
  const state = room.state;
  return {
    ts: new Date().toISOString(),
    code: room.code,
    seed: state.seed ?? null,
    // Unseeded production games cannot be replayed from the seed; the event stream below
    // is the reconstruction. `eventsTotal` vs `events.length` shows whether it was capped.
    replayable: state.seed != null,
    rules: state.rules,
    turnTimeout: room.turnTimeout ?? null,
    responseTimeout: room.responseTimeout ?? null,
    winner: state.winner,
    endReason: state.endReason,
    stalemateBasis: state._stalemateBasis || null,
    turns: state.turnCounter,
    deckCycles: state.shuffleCount || 0,
    seats: room.players.map((p, i) => ({
      seat: i, id: p.id, name: p.name, isBot: !!p.isBot, botMode: p.botMode || null,
    })),
    stats: state.stats,
    eventsTotal: state.eventSeq || 0,
    events: state.events || [],
    boards: state.players.map(board),
    log: state.log || [],
    integrity: G ? G.validateState(state) : null,
  };
}

// Records a finished game exactly once. Safe to call on every broadcast.
function recordFinished(room, G) {
  try {
    if (!enabled() || stopped) return false;
    if (!room || !room.state || room.state.phase !== 'finished') return false;
    if (room.state._logged) return false;
    room.state._logged = true;

    ensureReady();
    if (MAX_BYTES > 0 && bytes >= MAX_BYTES) rotate();

    const line = JSON.stringify(buildRecord(room, G)) + '\n';
    bytes += Buffer.byteLength(line);
    fs.appendFile(FILE, line, err => { if (err) { stopped = true; warnOnce(err); } });
    console.log(`[GAME] ${room.code} recorded (${room.state.endReason}, ${room.state.turnCounter} turns)`);
    return true;
  } catch (error) {
    stopped = true;
    warnOnce(error);
    return false;
  }
}

module.exports = { recordFinished, enabled, FILE, DIR, buildRecord };
