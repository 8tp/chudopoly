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
