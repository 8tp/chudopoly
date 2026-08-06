// fx/index.js — the cue → effect map, and the four-call public interface.
//
// ── TWO INPUT CHANNELS, AND WHY ───────────────────────────────────────────
//
// anim/cues.js (FX_CUE) is the WHERE and WHEN: one message per physical beat,
// carrying viewport coordinates. It cannot carry direction — the choreographer
// flags a steal `mine` when EITHER the thief or the victim is you, because
// audio only needs to know "this concerns me".
//
// bus CHOREO_EVENT is the WHO and HOW MUCH: the engine event itself, with
// `from`/`to`/`total`/`action`. It is emitted by choreographer.runJobAsync
// IMMEDIATELY after applyEvent, in the SAME synchronous task as the cue, so a
// cue that needs direction can be held for exactly one event without ever
// crossing a frame boundary (`beat` below). If the event never arrives — an
// interact/-emitted cue, a cue the engine has no event for — `beat` expires on
// the next clock tick and the neutral form of the effect plays.
//
// Being red-shifted for the victim rather than for everyone is the whole point
// of the exercise: a table where every steal flashes red teaches the player
// nothing, and a table where only the ones aimed at them do is a table they can
// read out of the corner of their eye.
//
// ── RESTRAINT (the rule the tuning table below obeys) ─────────────────────
//
// Most beats get nothing. `card_landed` fires 40+ times a turn across a
// 5-player table; sparking on all of them makes the felt glitter permanently
// and destroys the signal value of the beats that matter. So: your card landing
// sparks, everyone else's does not. Opponents' turns are QUIET, and the game's
// three loud moments (a steal against you, the final approach, the win) stay
// loud because nothing else has spent the attention.
//
// ── THE TUNING TABLE ──────────────────────────────────────────────────────
// Sizes are CSS px, speeds px/s, lives ms, ring radii "from→to" px. Flash is a
// peak opacity on the screen-blend plate. Trauma decays at 1.5/s and displaces
// by trauma² × 15px (fx/shake.js) — so .30 is 1.4px and .60 is 5.4px.
//
//  cue               condition       particles                              flash       trauma  haptic
//  ───────────────── ─────────────── ────────────────────────────────────── ─────────── ─────── ───────────
//  card_flight_start —               —                                      —           0       —
//  card_landed       yours           5 dots ø7, 150px/s, 300ms              —           0       land 10ms
//  card_landed       anyone else's   NOTHING                                —           0       —
//  card_flip         yours + big     2 glints ø20, 380ms                    —           0       —
//  deal_done         —               —                                      —           0       —
//  shuffle           —               5 grey puffs 12→40, α.18               —           0       —
//  set_completed     any             flare ø74 + ring 14→78 gold lw4.2      gold .26*   .12*    setComplete*
//                                    440ms + 9 glints ø28, 620ms
//  steal_landed      you stole       ring 12→52 steel lw3.0 320ms + 6 dots  —           .08     —
//  steal_landed      AGAINST YOU     flare ø62 + ring 10→86 red lw5.5       red .30     .30     targeted
//                                    460ms + 12 red dots ø9.5, 250px/s
//  steal_landed      …by a CHUD      + 4 more dots, "CHUD!" float           red .38     .45     targeted
//  opsec_clash       involving you   4-arm spark cross 5/arm white ø8.5     steel .16   .14     targeted
//                                    360px/s + flare ø54; "OPSEC!" float
//  opsec_clash       others'         same cross, 3/arm at α.5, no flare     —           0       —
//  action_blocked    involving you   6 grey puffs 14→46, α.34, 550ms        —           .10     —
//  denied            —               2 red dots ø6.5, 220ms                 —           0       denied 12ms
//  payment_done      ≥4 cards        10 gold chips ø9 along the caravan     —           0       —
//  payment_done      you paid/were paid  float −NM red / +NM gold           —           0       —
//  turn_start        —               —                                      —           0       —
//  final_approach    any             ring 24→62% of the viewport diagonal   amber .22   .15     —
//                                    lw4.4, 800ms
//  final_approach    AGAINST YOU     + 6 amber glints ø32                   amber .26   .15     3×60ms
//  approach_broken   any             ring 18→34% of the diagonal, 550ms     steel .12   .08     —
//  win               yours           380 confetti, 3.2s                     gold .30    .60     win
//  win               someone else's  150 confetti, 2.6s                     gold .12    .12     —
//  stalemate         any             42 grey settle puffs, 1.0–1.8s         —           0       —
//  card_pickup       —               —                                      —           0       —
//  card_details      —               —                                      —           0       —
//
//  * set_completed's flash/trauma/haptic are yours only. Somebody else
//    completing a set gets the ring and the glints and nothing that touches
//    your hands or your screen.
//
// Everything in the "particles" column was doubled or tripled from a first pass
// that looked correct in the source and was invisible in the capture: a 3.4px
// additive dot and a 2.5px single-stroke ring do not exist against navy felt
// with SVG grain on it. The three fixes were plateau cores instead of gaussian
// ones, a two-stroke ring (band + filament), and a stationary flare at the
// epicentre of the two beats that have to be located precisely.
//
// ── §0.9 REDUCED MOTION ───────────────────────────────────────────────────
// Particles and shake are skipped entirely; the flash stays (softened to 55%
// and stretched 1.6×, which is an opacity-only cue) and floating text stays
// without the rise. Every cue is still logged, so the harness sees the same
// sequence either way.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { subscribe, unsubscribe } from '../core/clock.js';
import { prefersReducedMotion } from '../core/dom.js';
import { CUE } from '../anim/cues.js';
import * as choreographer from '../anim/choreographer.js';
import * as table from '../table/index.js';
import { store } from '../state/store.js';

import * as overlay from './overlay.js';
import * as P from './particles.js';
import { COL, KIND } from './particles.js';
import * as B from './bursts.js';
import * as shakeSys from './shake.js';
import * as floaters from './floaters.js';
import * as hap from './haptics.js';

/* ── reduced motion ─────────────────────────────────────────────────────── */

let reduced = prefersReducedMotion();
shakeSys.setReduced(reduced);
floaters.setReduced(reduced);
if (typeof matchMedia === 'function') {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const onChange = () => {
    reduced = mq.matches;
    shakeSys.setReduced(reduced);
    floaters.setReduced(reduced);
    if (reduced) P.clear();
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/* ── harness cue log (§9) ───────────────────────────────────────────────── */

const CUE_LOG_CAP = 800;
export const cueLog = [];

function logCue(kind, mine, big, x, y) {
  cueLog.push({ kind, mine: !!mine, big: !!big, x, y, t: Math.round(performance.now()) });
  if (cueLog.length > CUE_LOG_CAP) cueLog.shift();
  // harness.js (§9, architect-owned) does not know about fx's log yet. Adopting
  // `fxLog` into the bridge alongside sfxLog/hapticLog is a P3 request in the
  // agent report; until then fx attaches it itself, test-only and idempotent.
  const bridge = typeof window !== 'undefined' ? window.__CHUD : null;
  if (bridge && !bridge.fxLog) bridge.fxLog = cueLog;
}

/* ── the clock pump ─────────────────────────────────────────────────────── */

let pumping = false;
let painted = false;

function busy() {
  return P.count() > 0 || painted || shakeSys.active()
    || shakeSys.flashActive() || floaters.active();
}

// setActive is OUTSIDE the `pumping` guard on purpose. It used to be inside,
// and the bug that produced was invisible effects: reset() hides the overlay
// without dropping the clock subscription, so the next spawn found pumping ===
// true, returned early, and painted a full chip caravan into a display:none
// canvas. Showing the overlay is idempotent and costs a class-list compare.
function pump() {
  overlay.ensure();
  overlay.setActive(true);
  if (pumping) return;
  pumping = true;
  subscribe(tick);
}

function tick(dt) {
  if (beat.live) expireBeat();

  const g = overlay.ctx();
  const live = P.count() > 0;
  if (g && (live || painted)) {
    overlay.clear();
    P.update(dt);
    P.draw(g);
    painted = P.count() > 0;
  }
  shakeSys.tick(dt);
  shakeSys.tickFlash(dt);
  floaters.tick(dt);

  if (!busy()) {
    pumping = false;
    unsubscribe(tick);
    overlay.setActive(false);
  }
}

/* ── public interface (unchanged signatures — call sites live outside fx/) ─ */

/**
 * Celebration burst at a screen point.
 * @param {number} x @param {number} y
 * @param {{count?:number, color?:number, kind?:number, confetti?:boolean,
 *          speed?:number, life?:number, size?:number}} [opts]
 */
export function burst(x, y, opts = null) {
  if (reduced) return;
  const o = opts || EMPTY;
  overlay.ensure();
  if (o.confetti) B.confetti(overlay.width(), overlay.height(), o.count || 300, o);
  else if (o.kind === KIND.GLINT) B.glints(x, y, o.count || 8, o.color == null ? COL.GOLD : o.color, o);
  else if (o.kind === KIND.PUFF) B.puff(x, y, o.count || 6, o.color == null ? COL.GRAY : o.color, o);
  else B.sparks(x, y, o.count || 6, o.color == null ? COL.WHITE : o.color, o);
  pump();
}
const EMPTY = Object.freeze({});

/**
 * Screen flash. `el` is a focus hint only — the gradient centres on it; the
 * plate is always full-viewport (fx/shake.js explains the screen blend).
 * @param {Element|{x:number,y:number}|null} el
 * @param {'gold'|'red'|'steel'|'amber'} [tone]
 * @param {number} [strength] peak opacity
 * @param {number} [dur] seconds
 */
export function flash(el, tone = 'gold', strength = 0.16, dur = 0.45) {
  overlay.ensure();
  shakeSys.flash(strength, tone, dur, focusOf(el));
  pump();
}

const _focus = { x: 0, y: 0 };
function focusOf(el) {
  if (!el) return null;
  if (typeof el.x === 'number') { _focus.x = el.x; _focus.y = el.y; return _focus; }
  if (typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  _focus.x = r.left + r.width / 2;
  _focus.y = r.top + r.height / 2;
  return _focus;
}

/** Camera-style shake of the table root. @param {number} strength trauma 0..1 */
export function shake(strength) {
  if (!(strength > 0) || reduced) return;
  shakeSys.add(strength);
  pump();
}

/** Floating "+5M" style text at a point. */
export function floatText(text, x, y, tone = 'steel', scale = 1) {
  if (!text) return;
  overlay.ensure();
  floaters.spawn(text, x, y, tone, scale);
  pump();
}

export function setHapticRecorder(fn) { hap.setRecorder(fn); }
export const haptic = hap.haptic;
export const HAPTICS = hap.HAPTICS;

/** Test/driver affordance: what is actually live right now. */
export function stats() {
  return {
    particles: P.count(), peak: P.peakCount(), cap: P.CAP,
    floats: floaters.count(), trauma: shakeSys.level(),
    flash: shakeSys.flashActive(), cues: cueLog.length, haptics: hap.count(),
  };
}

export function reset() {
  P.clear();
  P.resetJitter();
  floaters.reset();
  shakeSys.reset();
  hap.reset();
  painted = false;
  beat.live = false;
  if (pumping) { pumping = false; unsubscribe(tick); }
  overlay.clear();
  overlay.setActive(false);
}

/* ── the held beat ──────────────────────────────────────────────────────── */

const beat = { live: false, kind: '', x: 0, y: 0, mine: false, big: false };

function hold(kind, mine, big, x, y) {
  beat.live = true; beat.kind = kind; beat.x = x; beat.y = y;
  beat.mine = !!mine; beat.big = !!big;
}

/** No event claimed the beat — play the neutral form and move on. */
function expireBeat() {
  const kind = beat.kind;
  beat.live = false;
  if (kind === CUE.STEAL_LANDED) stealFx(beat.x, beat.y, false, false);
}

/* ── geometry ───────────────────────────────────────────────────────────── */

const _pt = { x: 0, y: 0 };
function centreOf(el) {
  if (!el) { _pt.x = overlay.width() / 2; _pt.y = overlay.height() / 2; return _pt; }
  const r = el.getBoundingClientRect();
  _pt.x = r.left + r.width / 2;
  _pt.y = r.top + r.height / 2;
  return _pt;
}

function diag() {
  const w = overlay.width(), h = overlay.height();
  return Math.sqrt(w * w + h * h);
}

/* ── the effects ────────────────────────────────────────────────────────── */

const _at = { x: 0, y: 0 };
function at(x, y) { _at.x = x; _at.y = y; return _at; }

function stealFx(x, y, victim, chud) {
  if (!reduced) {
    if (victim) {
      // Harder than the neutral ring in all three dimensions a ring has:
      // 4px of stroke instead of 2.4, 86px of travel instead of 52, and 340ms
      // instead of 260 — it arrives slower and stays longer, which is what
      // makes it read as "this one was aimed at you" and not as more sparkle.
      B.flare(x, y, 62, COL.RED, 0.3);
      B.ring(x, y, 10, 86, COL.RED, 0.46, 5.5, 1);
      B.sparks(x, y, chud ? 16 : 12, COL.RED, { speed: 250, life: 0.44, size: 9.5, grav: 300 });
    } else {
      B.ring(x, y, 12, 52, COL.STEEL, 0.32, 3.0, 0.85);
      B.sparks(x, y, 6, COL.STEEL, { speed: 170, life: 0.32, size: 8 });
    }
  }
  if (victim) {
    flash(at(x, y), 'red', chud ? 0.38 : 0.30, 0.5);
    shake(chud ? 0.45 : 0.30);
    hap.haptic(hap.HAPTICS.targeted);
  } else {
    shake(0.08);
  }
  pump();
}

function onCue(payload) {
  if (!payload) return;
  const { kind, mine, big } = payload;
  const x = payload.at ? payload.at.x : 0;
  const y = payload.at ? payload.at.y : 0;
  logCue(kind, mine, big, x, y);

  // The harness bridge sets choreographer instant mode: the table is being
  // PLACED from a fixture, not performed. Particles then depend on when the
  // tool happened to call applyState, which makes tools/screenshot.mjs
  // non-reproducible. Cues and haptics are still logged — only the pixels stop.
  if (choreographer.isInstant()) {
    if (kind === CUE.WIN && mine) hap.haptic(hap.HAPTICS.win);
    else if (kind === CUE.SET_COMPLETED && mine) hap.haptic(hap.HAPTICS.setComplete);
    else if (kind === CUE.LANDED && mine) hap.haptic(hap.HAPTICS.land);
    return;
  }

  // Guard BEFORE the overlay is built: the cues fx deliberately ignores are the
  // frequent ones (flight_start, deal_done, turn_start, pickup, details, and
  // every card landing that is not yours), and a game that only ever fires
  // those must never allocate a canvas backing store. §0.8's idle-cost rule.
  if (!EFFECTFUL[kind]) return;
  if (kind === CUE.LANDED && !mine) return;

  if (beat.live) expireBeat();
  overlay.ensure();

  switch (kind) {
    case CUE.LANDED:
      if (!reduced) B.sparks(x, y, 5, COL.WHITE, { speed: 150, life: 0.30, size: 7 });
      hap.haptic(hap.HAPTICS.land);
      break;

    case CUE.FLIP:
      if (!mine || !big || reduced) return;
      B.glints(x, y, 2, COL.GOLD_HI, { size: 20, life: 0.38, radius: 10 });
      break;

    case CUE.SHUFFLE:
      if (reduced) return;
      B.puff(x, y, 5, COL.GRAY, { size0: 12, size1: 40, alpha: 0.18, life: 0.55 });
      break;

    case CUE.SET_COMPLETED:
      if (!reduced) {
        B.flare(x, y, 74, COL.GOLD_HI, 0.34);
        B.ring(x, y, 14, 78, COL.GOLD, 0.44, 4.2, 1);
        B.glints(x, y, 9, COL.GOLD_HI, { size: 28, life: 0.62, radius: 30, rise: 26 });
      }
      if (mine) {
        flash(at(x, y), 'gold', 0.26, 0.55);
        shake(0.12);
        hap.haptic(hap.HAPTICS.setComplete);
      }
      break;

    case CUE.STEAL_LANDED:
      // Direction unknowable from the cue — see the two-channel note above.
      hold(kind, mine, big, x, y);
      return;

    case CUE.OPSEC_CLASH:
      // Two fans at right angles: metal met metal and neither gave way.
      if (!reduced) {
        B.sparkCross(x, y, mine ? 5 : 3, COL.WHITE, { speed: mine ? 360 : 260, size: 8.5, alpha: mine ? 1 : 0.5 });
        if (mine) B.flare(x, y, 54, COL.STEEL, 0.24);
      }
      if (mine) {
        flash(at(x, y), 'steel', 0.16, 0.34);
        shake(0.14);
        hap.haptic(hap.HAPTICS.targeted);
      }
      break;

    case CUE.ACTION_BLOCKED:
      if (!reduced) B.puff(x, y, 6, COL.GRAY, { size0: 14, size1: 46, alpha: 0.34, life: 0.55 });
      if (mine) shake(0.10);
      break;

    case CUE.DENIED:
      if (!reduced) B.sparks(x, y, 2, COL.RED, { speed: 70, life: 0.22, size: 6.5, grav: 200 });
      hap.haptic(hap.HAPTICS.denied);
      break;

    case CUE.PAYMENT_DONE:
      hold(kind, mine, big, x, y);
      return;

    case CUE.FINAL_APPROACH: {
      // ONE sweep. §3.10's arming is a state, not an event you can loop on —
      // the ongoing tension belongs to the board treatment and to audio. A
      // particle loop here would still be running when the player has to make
      // the decision it is warning them about.
      if (!reduced) {
        B.ring(x, y, 24, diag() * 0.62, COL.GOLD, 0.8, 4.4, 0.95);
        if (!mine) B.glints(x, y, 6, COL.GOLD, { size: 32, life: 0.7, radius: 34, rise: 10 });
      }
      flash(at(x, y), 'amber', mine ? 0.22 : 0.26, 0.9);
      shake(0.15);
      if (!mine) hap.haptic(hap.HAPTICS.finalApproach);
      break;
    }

    case CUE.APPROACH_BROKEN:
      if (!reduced) B.ring(x, y, 18, diag() * 0.34, COL.STEEL, 0.55, 3.0, 0.8);
      flash(at(x, y), 'steel', 0.12, 0.34);
      shake(0.08);
      break;

    case CUE.WIN:
      if (!reduced) B.confetti(overlay.width(), overlay.height(), mine ? 380 : 150, { life: mine ? 3.2 : 2.6 });
      flash(null, 'gold', mine ? 0.30 : 0.12, mine ? 0.8 : 0.6);
      shake(mine ? 0.60 : 0.12);
      if (mine) hap.haptic(hap.HAPTICS.win);
      break;

    case CUE.STALEMATE:
      if (!reduced) B.settle(overlay.width(), overlay.height(), 42);
      break;

    default:
      return;
  }
  pump();
}

/**
 * The cues that can produce something. Everything absent from this map is
 * deliberately silent: flight_start (audio's beat), deal_done, turn_start (the
 * HUD already says whose it is), card_pickup and card_details (the finger under
 * the card is the feedback).
 */
const EFFECTFUL = Object.freeze({
  [CUE.LANDED]: 1, [CUE.FLIP]: 1, [CUE.SHUFFLE]: 1, [CUE.SET_COMPLETED]: 1,
  [CUE.STEAL_LANDED]: 1, [CUE.OPSEC_CLASH]: 1, [CUE.ACTION_BLOCKED]: 1,
  [CUE.DENIED]: 1, [CUE.PAYMENT_DONE]: 1, [CUE.FINAL_APPROACH]: 1,
  [CUE.APPROACH_BROKEN]: 1, [CUE.WIN]: 1, [CUE.STALEMATE]: 1,
});

/* ── the event layer: who, and how much ─────────────────────────────────── */

function onEvent(ev) {
  if (!ev || choreographer.isInstant()) return;
  const self = store.self.id;

  switch (ev.t) {
    case 'steal':
    case 'set_stolen': {
      if (!claim(CUE.STEAL_LANDED)) break;
      stealFx(beat.x, beat.y, ev.from === self, ev.action === 'chud');
      break;
    }

    case 'swap': {
      if (!claim(CUE.STEAL_LANDED)) break;
      stealFx(beat.x, beat.y, ev.target === self, false);
      break;
    }

    case 'payment': {
      if (!claim(CUE.PAYMENT_DONE)) break;
      const total = ev.total || 0;
      const from = centreOf(table.boardEl(ev.from));
      const fx0 = from.x, fy0 = from.y;
      const to = centreOf(table.boardEl(ev.to));
      // Chips only on the caravans that hurt (the cue's `big` = ≥4 cards).
      if (beat.big && !reduced) B.chipTrail(fx0, fy0, to.x, to.y, 10, COL.GOLD);
      if (total > 0) {
        if (ev.from === self) floatText(`-${total}M`, fx0, fy0, 'red');
        else if (ev.to === self) floatText(`+${total}M`, to.x, to.y, 'gold');
      }
      pump();
      break;
    }

    // No cue exists for play_action (the card is already on the discard pile by
    // the time the engine says who it was aimed at). The label is the whole
    // effect: CHUD is the one card that can take a property out of a finished
    // set, and it should announce itself.
    case 'play_action':
      if (ev.action === 'chud') {
        const at = centreOf(table.boardEl(ev.actor));
        floatText('CHUD!', at.x, at.y, 'red', 1.35);
      }
      break;

    case 'opsec': {
      const at = centreOf(table.zoneFor('discard'));
      floatText('OPSEC!', at.x, at.y, 'steel', 1.35);
      break;
    }

    default:
      break;
  }
}

/** Consume the held beat if it is the one this event produced. */
function claim(kind) {
  if (!beat.live || beat.kind !== kind) return false;
  beat.live = false;
  return true;
}

/* ── wiring ─────────────────────────────────────────────────────────────── */
// Module scope, not a mount() call: nothing in the client calls fx.mount(), and
// a cue that arrives before a mount would be a silent hole. Subscribing costs
// two array pushes; the DOM and the canvas are still built lazily on the first
// effect, so the idle cost of importing fx/ is those two pushes.

bus.on(EVENTS.FX_CUE, onCue);
bus.on(EVENTS.CHOREO_EVENT, onEvent);

export { CUE, COL, KIND };
