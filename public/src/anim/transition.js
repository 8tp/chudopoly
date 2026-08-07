// anim/transition.js — the ONE wrapper around the View Transitions API.
//
// ART §4 asks for a view transition on SCREEN CHANGES: home → lobby → table,
// and the table → the victory screen. MEASURED before this file existed:
// `grep -r startViewTransition public/` returned nothing, and both changes were
// hard cuts — the win overlay appeared between two consecutive captured frames
// with no transition at all, and lobby → table was a 33ms cut.
//
// ── WHAT IT IS NOT FOR ────────────────────────────────────────────────────
// Never a card. §10 requires card motion to stay interruptible and anim/
// flight.js owns it; a view transition freezes a snapshot of the old page and
// blocks input for its duration, which is the exact opposite of interruptible.
// This is for changes where the WHOLE screen is replaced and there is nothing
// to interrupt.
//
// ── THE THREE GUARDS ──────────────────────────────────────────────────────
//   • capability — Firefox and older Safari have no startViewTransition, so the
//     mutation runs bare. It is a progressive enhancement, never a dependency:
//     `run` is called synchronously in that case, so no caller can end up in a
//     state where its DOM change did not happen.
//   • §0.9 reduced motion — the transition is skipped entirely and the change
//     is instant. The cues around it are somebody else's and are unaffected.
//   • re-entrancy — a second call while one is running skips rather than queues.
//     Screen changes arrive in bursts on a reconnect (home → lobby → game in
//     one tick) and chaining 300ms transitions would hold the screen on a stale
//     frame for the better part of a second.
//
// The LOOK of the transition (durations, easings, which pseudo-elements move)
// lives in public/style/motion.css under ::view-transition-*; this file only
// decides whether one happens at all.

import { prefersReducedMotion } from '../core/dom.js';

let running = false;

/** Is a view transition possible right now? Exposed for the harness. */
export function supported() {
  return typeof document !== 'undefined'
    && typeof document.startViewTransition === 'function';
}

/**
 * Run `mutate` inside a view transition when that is possible and wanted.
 *
 * @param {() => void} mutate the DOM change. ALWAYS runs, exactly once.
 * @param {string} [name] a class put on <html> for the duration, so motion.css
 *        can give different screen changes different choreography.
 * @returns {boolean} true if a transition was actually started.
 */
export function screenChange(mutate, name = '') {
  if (typeof mutate !== 'function') return false;
  if (running || !supported() || prefersReducedMotion()) { mutate(); return false; }
  const root = document.documentElement;
  const cls = name ? `vt-${name}` : '';
  running = true;
  if (cls) root.classList.add(cls);
  let t;
  try {
    t = document.startViewTransition(() => { mutate(); });
  } catch {
    // A browser that has the method but refuses the call (a transition already
    // in flight in another frame) must still get its DOM change.
    running = false;
    if (cls) root.classList.remove(cls);
    mutate();
    return false;
  }
  const done = () => {
    running = false;
    if (cls) root.classList.remove(cls);
  };
  t.finished.then(done, done);
  return true;
}
