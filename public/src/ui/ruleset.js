// ui/ruleset.js — what ruleset is ACTUALLY running, for the copy that describes it.
//
// §3.9's bar is "no rule may exist that the help screen doesn't state". That was
// written when there was exactly one ruleset, so the brief, the win overlay and
// the HUD all hard-coded Final Approach and the number 3. The engine now
// resolves a per-game ruleset (game.js resolveRules → RULE_PRESETS) and ships
// `winRule` + `setsToWin` on every broadcast, so a game of Blitz was being
// described to its own players as a game of Chudopoly.
//
// This module is the ONE place the client asks "which rules are we playing?".
// It reads the snapshot and nothing else, so it cannot drift from the engine.
//
// ── FIELD ORDER, and why it is defensive ──────────────────────────────────
// A concurrent engine round is adding the full resolved ruleset as one object
// (`rules: {preset, winRule, setsToWin, pureSetRequired, passGoRestartsTurn}`).
// getPlayerView today ships only the two flat aliases. So: read `rules` first
// (it will be authoritative the moment it lands and needs no client change),
// then the flat aliases that ship today, then the core/cards.js constants —
// which are only ever reached with NO game on screen (the home-screen help).

import { store } from '../state/store.js';
import { SETS_TO_WIN } from '../core/cards.js';

export const WIN_RULES = Object.freeze(['finalApproach', 'mdFaithful', 'instant']);
const DEFAULT_WIN_RULE = 'finalApproach';         // game.js DEFAULT_WIN_RULE

/**
 * @returns {{winRule:string, setsToWin:number, preset:string|null,
 *            pureSetRequired:boolean|null, passGoRestartsTurn:boolean|null,
 *            live:boolean}}
 *   `live` is false when there is no game on screen — the copy then describes
 *   the DEFAULT ruleset and says so, rather than asserting a rule for a game
 *   that has not been created yet.
 */
export function activeRules() {
  const snap = store.snapshot;
  const r = (snap && typeof snap.rules === 'object' && snap.rules) || null;
  const winRule = r?.winRule ?? snap?.winRule;
  const setsToWin = r?.setsToWin ?? snap?.setsToWin;
  return {
    winRule: WIN_RULES.includes(winRule) ? winRule : DEFAULT_WIN_RULE,
    setsToWin: Number.isInteger(setsToWin) && setsToWin > 0 ? setsToWin : SETS_TO_WIN,
    preset: r?.preset ?? null,
    pureSetRequired: r ? !!r.pureSetRequired : null,
    passGoRestartsTurn: r ? !!r.passGoRestartsTurn : null,
    live: !!snap,
  };
}

/** The number of sets this game is played to. Never write "3" anywhere. */
export function setsToWin() { return activeRules().setsToWin; }

/** The active win rule id. */
export function winRule() { return activeRules().winRule; }

/** English word for a set count, so copy reads like copy. */
export function countWord(n) {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][n] || String(n);
}

export const WIN_RULE_NAMES = Object.freeze({
  finalApproach: 'Final Approach',
  mdFaithful: 'MD Faithful',
  instant: 'Blitz — instant win',
});

/* ── the LOBBY's side of the same rules (P8 picker) ────────────────────────
 *
 * Everything above answers "what are we playing?" from a broadcast. A lobby has
 * no broadcast to read — the `state` message carries no ruleset until a game
 * exists (server/broadcast.js sends code/phase/players/hostId/game and nothing
 * else), so the host's PENDING choice is client-side by necessity.
 *
 * The four rows below are a MIRROR of game.js RULE_PRESETS, pinned by
 * test/houserules.test.js:291-297. The server is still authoritative (§0.1):
 * the lobby sends a preset name or the four toggles, resolveRules() resolves
 * them, and the very first broadcast replaces this label with the server's.
 * matchPreset() below is resolveRules()'s preset-detection loop, character for
 * character, so the label the host reads never disagrees with the label the
 * table will show.
 */

export const RULE_KEYS = Object.freeze(
  ['winRule', 'setsToWin', 'pureSetRequired', 'passGoRestartsTurn']);

export const PRESETS = Object.freeze({
  chudopoly:  Object.freeze({ winRule: 'finalApproach', setsToWin: 3, pureSetRequired: false, passGoRestartsTurn: false }),
  mdFaithful: Object.freeze({ winRule: 'mdFaithful',    setsToWin: 3, pureSetRequired: true,  passGoRestartsTurn: false }),
  blitz:      Object.freeze({ winRule: 'instant',       setsToWin: 3, pureSetRequired: false, passGoRestartsTurn: true }),
  longGame:   Object.freeze({ winRule: 'finalApproach', setsToWin: 5, pureSetRequired: false, passGoRestartsTurn: false }),
});
/** Presentation order. Default first — it is the one most tables want. */
export const PRESET_ORDER = Object.freeze(['chudopoly', 'mdFaithful', 'blitz', 'longGame']);
export const SETS_TO_WIN_CHOICES = Object.freeze([3, 4, 5]);   // server/protocol.js SETS_TO_WIN

/**
 * `length` is MEASURED, not guessed: mean turns per game over the balance sim
 * (simulate.js, 4-player mixed bots). Chudopoly 34.5 · MD Faithful 35.1 ·
 * Blitz 25.1 · Long Game 66.8. Blitz is 27% shorter than the default; Long
 * Game is 1.94× it and 6.8% of those games run the deck out and are decided on
 * points instead of a win (§3.6 stalemate end), which is a real thing to know
 * before you pick it, so it is on the card rather than in the help screen.
 */
export const PRESET_COPY = Object.freeze({
  chudopoly: Object.freeze({
    name: 'Chudopoly',
    tag: 'Default',
    turns: '≈35 turns',
    line: 'Three sets, then every other player gets one full turn to shoot you down.',
  }),
  mdFaithful: Object.freeze({
    name: 'MD Faithful',
    tag: 'By the book',
    turns: '≈35 turns',
    line: 'Monopoly Deal as written: you declare on your own next turn, and a set needs at '
      + 'least one real property in it.',
  }),
  blitz: Object.freeze({
    name: 'Blitz',
    tag: 'Fastest',
    turns: '≈25 turns',
    line: 'The third set wins the instant it lands, on anyone\'s turn, and PCS Orders hands '
      + 'your whole turn back. About a third shorter.',
  }),
  longGame: Object.freeze({
    name: 'Long Game',
    tag: 'Longest',
    turns: '≈67 turns',
    line: 'Five sets — nearly twice the length, and about 1 game in 15 runs the deck out and '
      + 'is decided on points.',
  }),
});

/** The label for a resolved preset id, including the server's 'custom'. */
export function presetLabel(name) {
  return PRESET_COPY[name]?.name || 'Custom';
}

/**
 * One sentence per win rule, for the picker. The help screen carries the
 * detail (ui/help.js pageGoal branches on all three); this is the choosing
 * copy, and the only claim it makes that is not about our engine is a
 * provenance claim, which is checked:
 *
 * Monopoly Deal's two rulebook editions disagree with each other. The classic
 * sheet carries "if you realize you've won during someone else's turn, you
 * must wait until it's your turn to say it"; the modern E3113 foldout drops
 * that sentence entirely. So `instant` is how the CURRENT rulebook reads,
 * `mdFaithful` is how the ORIGINAL reads, and neither of them is our
 * invention. Final Approach is (ARCHITECTURE §3.10) — it is strictly the most
 * generous of the three to the defenders.
 */
export const WIN_RULE_LINE = Object.freeze({
  instant: 'You win the moment your last set lands, on anybody\'s turn — how the current '
    + 'Hasbro rulebook reads.',
  mdFaithful: 'You wait for your own next turn to declare — the sentence the original '
    + 'rulebook has and the current one drops.',
  finalApproach: 'Every other player gets one full turn to break you first — ours, and the '
    + 'only one of the three that guarantees a reply.',
});

/** The two independent toggles, in the words a host chooses them by. */
export const TOGGLE_COPY = Object.freeze({
  pureSetRequired: Object.freeze({
    label: 'Wilds alone cannot finish a set',
    // game.js zoneIsSet(): a full zone with no card of type 'property' is not a set.
    line: 'A full colour only counts if at least one real property card is in it.',
  }),
  passGoRestartsTurn: Object.freeze({
    label: 'PCS Orders restarts your turn',
    // game.js playAction 'pcs_orders': restart → state.playsRemaining = 3.
    line: 'Playing it draws 2 and hands back all three plays. The popular speed house rule.',
  }),
});

/** True when `value` is a legal value for that rule key (server/protocol.js). */
function legal(key, value) {
  switch (key) {
    case 'winRule': return WIN_RULES.includes(value);
    case 'setsToWin': return SETS_TO_WIN_CHOICES.includes(value);
    default: return typeof value === 'boolean';
  }
}

/** Any object → a complete, legal toggle set. Unknown/illegal fields fall back
 *  to the Chudopoly default rather than being sent for the server to reject. */
export function normalizeRules(raw) {
  const out = { ...PRESETS.chudopoly };
  if (raw && typeof raw === 'object') {
    for (const key of RULE_KEYS) if (legal(key, raw[key])) out[key] = raw[key];
  }
  return out;
}

/**
 * The preset a toggle set IS, or 'custom'. Identical to game.js resolveRules()'s
 * final `PRESET_NAMES.find(...)`, so flipping a toggle back onto a preset's
 * exact values re-labels it as that preset — the same way the server would.
 */
export function matchPreset(rules) {
  const r = normalizeRules(rules);
  return PRESET_ORDER.find(name => RULE_KEYS.every(key => PRESETS[name][key] === r[key]))
    || 'custom';
}

/**
 * What to put on the wire. A named preset goes as a preset — one field, and the
 * server resolves it — because sending four toggles that happen to add up to
 * Blitz would never exercise the preset path at all. 'custom' has no wire value
 * (server/protocol.js RULE_PRESETS rejects it), so it goes as its four toggles,
 * which resolveRules() resolves to exactly the same thing.
 */
export function rulesPayload(rules) {
  const r = normalizeRules(rules);
  const preset = matchPreset(r);
  return preset === 'custom' ? r : { preset };
}

/* ── persistence ──────────────────────────────────────────────────────────
 * A host who has chosen Blitz once is asked again on every new room and every
 * rematch-into-a-new-lobby otherwise. Same shape as ui/home.js's call-sign key
 * and audio/engine.js's mix key: one JSON blob, every read re-validated
 * through normalizeRules() so a hand-edited or stale value cannot put an
 * illegal ruleset on the wire. */
const RULES_KEY = 'chud.lobbyRules.v1';

export function loadHostRules() {
  try { return normalizeRules(JSON.parse(localStorage.getItem(RULES_KEY) || 'null')); }
  catch { return { ...PRESETS.chudopoly }; }
}

export function saveHostRules(rules) {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(normalizeRules(rules))); }
  catch { /* private mode */ }
}

/** One sentence: what ending this game is playing to. */
export function winRuleSummary(rules = activeRules()) {
  const n = rules.setsToWin;
  switch (rules.winRule) {
    // game.js syncSets(): winRule 'instant' → finishGame the moment the count lands.
    case 'instant':
      return `Completing your ${countWord(n)}th set wins the game on the spot, `
        + 'on anyone\'s turn. There is no grace window and nothing is ever armed.';
    // checkpointThreshold(): 'mdFaithful' → 1, i.e. any LATER own turn start.
    case 'mdFaithful':
      return `Holding ${countWord(n)} complete sets arms you. You win at the start of your `
        + 'very next own turn if you still hold them — the literal Monopoly Deal rule.';
    // checkpointThreshold(): activeCount(state) — a whole cycle of turns.
    default:
      return `Holding ${countWord(n)} complete sets arms your FINAL APPROACH. Every other `
        + 'player gets a full turn to break you; you win at your own turn start after that.';
  }
}
