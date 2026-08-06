// fx/index.js — P5 STUB with the real interface.
//
// Every visual garnish and every haptic goes through these four calls, so the
// fx agent adds particles/flash/shake without hunting for call sites. Under
// ?harness=1 haptics are recorded to __CHUD.hapticLog instead of vibrating.

let hapticRecorder = null;
export function setHapticRecorder(fn) { hapticRecorder = fn; }

/** Confetti / celebration burst at a screen point. */
export function burst(_x, _y, _opts) { /* P5 */ }

/** One-frame flash over an element (payment, block, steal). */
export function flash(_el, _tone) { /* P5 */ }

/** Camera-style shake of the table root. */
export function shake(_strength) { /* P5 */ }

/** Floating "+5M" style text at a point. */
export function floatText(_text, _x, _y, _tone) { /* P5 */ }

/**
 * §7: never more than one pattern per event.
 * @param {number|number[]} pattern
 */
export function haptic(pattern) {
  if (hapticRecorder) { hapticRecorder(pattern); return; }
  if (typeof navigator?.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch { /* ignore */ }
}

export const HAPTICS = Object.freeze({
  land: 8,
  targeted: [12, 40, 12],
  setComplete: [10, 30, 10, 30, 20],
  win: 220,
});
