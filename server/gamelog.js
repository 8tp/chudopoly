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
//   * it is opt-outable (CHUD_GAME_LOG=0/off/false);
//   * ONE BAD GAME NEVER SILENCES THE REST. A record that cannot be built or serialized
//     skips itself and logging continues — the games most worth recording are the weird
//     ones, so "malformed" is the last thing that should switch forensics off. Only a
//     filesystem error (the one thing retrying cannot fix) hard-disables the module.

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
let fsDisabled = false;      // set ONLY by filesystem failures
let warned = false;
let written = 0;
let skipped = 0;

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn('[GAMELOG] disabled after filesystem failure:', error?.message || error);
}

function stats() { return { written, skipped, disabled: fsDisabled }; }

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

// buildRecord must be TOTAL: a game whose state is structurally odd is exactly the game
// worth recording, so every collection is coerced rather than trusted. (Audited 2026-08-06:
// no engine or server path assigns null to any of these — every assignment is {} or a
// filtered array — so these coercions only ever fire for genuinely corrupt states.)
const asArray = v => (Array.isArray(v) ? v : []);
const asEntries = v => (v && typeof v === 'object' ? Object.entries(v) : []);
const cardId = c => (c && c.id !== undefined ? c.id : null);

function board(player) {
  const p = player && typeof player === 'object' ? player : {};
  return {
    id: p.id ?? null,
    name: p.name ?? null,
    eliminated: !!p.eliminated,
    finalApproach: !!p.finalApproach,
    handCount: asArray(p.hand).length,
    bank: asArray(p.bank).map(cardId),
    properties: Object.fromEntries(asEntries(p.properties)
      .map(([color, cards]) => [color, asArray(cards).map(cardId)])
      .filter(([, ids]) => ids.length)),
    upgrades: Object.fromEntries(asEntries(p.upgrades)
      .map(([color, ups]) => [color, asArray(ups).map(u => (u && u.upgradeType) || 'upgrade')])),
  };
}

function safeValidate(state, G) {
  try { return G ? G.validateState(state) : null; }
  catch (error) { return { error: 'validateState threw: ' + (error?.message || error) }; }
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
    seats: asArray(room.players).map((p, i) => ({
      seat: i, id: p?.id ?? null, name: p?.name ?? null,
      isBot: !!p?.isBot, botMode: p?.botMode || null,
    })),
    stats: state.stats ?? null,
    eventsTotal: state.eventSeq || 0,
    events: asArray(state.events),
    boards: asArray(state.players).map(board),
    // A corrupt state is the most interesting kind to record, so say so in the record
    // rather than losing it: a null players array becomes an explicit marker.
    boardsMissing: Array.isArray(state.players) ? undefined : true,
    log: asArray(state.log),
    integrity: safeValidate(state, G),
  };
}

// Records a finished game exactly once. Safe to call on every broadcast.
function recordFinished(room, G) {
  if (!enabled() || fsDisabled) return false;
  if (!room || !room.state || room.state.phase !== 'finished') return false;
  if (room.state._logged) return false;
  room.state._logged = true;

  // Phase 1 — build and serialize. A failure here is about THIS game only, so it skips
  // itself and logging stays on for every other room on the instance.
  let line;
  try {
    line = JSON.stringify(buildRecord(room, G)) + '\n';
  } catch (error) {
    skipped++;
    console.warn(`[GAMELOG] skipped ${room?.code ?? '?'}: ${error?.message || error}`
      + ' (logging continues)');
    return false;
  }

  // Phase 2 — write. A failure here is the filesystem, which retrying cannot fix.
  try {
    ensureReady();
    if (MAX_BYTES > 0 && bytes >= MAX_BYTES) rotate();
    bytes += Buffer.byteLength(line);
    fs.appendFile(FILE, line, err => { if (err) { fsDisabled = true; warnOnce(err); } });
  } catch (error) {
    fsDisabled = true;
    warnOnce(error);
    return false;
  }

  written++;
  console.log(`[GAME] ${room.code} recorded (${room.state.endReason}, ${room.state.turnCounter} turns)`);
  return true;
}

module.exports = { recordFinished, enabled, stats, FILE, DIR, buildRecord };
