// fx/haptics.js — §7's haptic vocabulary and the two rules that keep it from
// becoming noise.
//
//   RULE 1 (§7, verbatim): never more than one pattern per event. Enforced
//   structurally — fx/index.js calls haptic() at most once per cue, and the
//   floor below eats the duplicate when main.js's own set_completed/win
//   handlers fire the same beat a few hundred microseconds later.
//
//   RULE 2: a 300ms floor between vibrations. A 5-card payment is five card
//   landings inside 350ms; without the floor that is five motor spin-ups the
//   phone renders as one long ugly rattle, and the actuator on an iPhone
//   ignores the tail anyway. First one wins, the rest are dropped.
//
// Under ?harness=1 nothing vibrates: harness.js installs a recorder and every
// pattern that PASSES the floor is appended to __CHUD.hapticLog, so the log is
// what a player would actually have felt rather than what fx tried to send.

const FLOOR_MS = 300;

let recorder = null;
let lastAt = -1e9;
let sent = 0;

export function setRecorder(fn) { recorder = fn; }
export function count() { return sent; }

/**
 * @param {number|number[]} pattern ms, or an on/off/on… array
 * @returns {boolean} true if it went out (or was recorded)
 */
export function haptic(pattern) {
  if (pattern == null) return false;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastAt < FLOOR_MS) return false;
  lastAt = now;
  sent++;
  if (recorder) { recorder(pattern); return true; }
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try { navigator.vibrate(pattern); } catch { /* Safari, iOS: no vibrate API */ }
  return true;
}

/**
 * §7's four required patterns plus the two the P5 brief adds. Durations are ms.
 *
 *   land          10   — a tick, not a buzz. Your card touching the felt.
 *   targeted   30/40/30 — two knocks: something is being done TO you.
 *   setComplete 20/30/20 — the same shape, shorter and tighter, so "good thing"
 *                          and "bad thing" are distinguishable through a pocket.
 *   finalApproach 3×60 spaced 90 — an alarm. Only ever fires when the armed
 *                          player is somebody else, i.e. against you.
 *   win        40/60/40/60/200 — a roll into a long resolve.
 *   denied        12   — the shortest thing the actuator can render.
 */
export const HAPTICS = Object.freeze({
  land: 10,
  targeted: [30, 40, 30],
  setComplete: [20, 30, 20],
  finalApproach: [60, 90, 60, 90, 60],
  win: [40, 60, 40, 60, 200],
  denied: 12,
});

export function reset() { lastAt = -1e9; sent = 0; }
