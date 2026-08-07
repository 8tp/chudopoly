// anim/flight.js — the one card-motion engine (§0.6, §0.8, §6).
//
// Every card that moves on this table is a record in `live`, stepped by ONE
// core/clock subscriber. No CSS transition and no WAAPI animation ever touches
// a .card, for two reasons: a second timeline is a second clock (§0.6), and a
// flight has to be interruptible at any frame — a card can be stolen while it
// is still landing, and the new flight must start from where the old one had
// actually got to, not from where CSS thinks it is.
//
// TRANSFORM CONTRACT (§5). A card's transform is exclusively
//     translate(var(--fx),var(--fy)) rotate(var(--tilt)) scale(var(--fs))
// and this file is the only writer of those four vars while a card is moving.
// Because translate is outermost, adding dx to --fx moves the card's centroid
// by exactly dx whatever its tilt or scale — which is what makes the measured
// FLIP in table/moveCard exact rather than approximately exact.
//
// REST. Each card node carries its resting pose as three numbers written by
// table/cardnode.js: __rx, __ry (px offsets from its layout box) and __rt
// (degrees). A discard card rests tilted; a hand card rests fanned. Flights
// land ON the rest pose, never on zero, so the fan and the flight compose
// instead of fighting. setRest() during a flight retargets it in place.
//
// ALLOCATION (§0.8). Records are pooled; the live list is compacted by
// swap-remove (splice returns an array — that is a per-frame allocation).
// The only per-frame allocation left is the string a CSS var write demands,
// and those are guarded on the QUANTISED value: 0.1px, 0.1deg, 0.001 scale.
// A settled card costs 0 writes/frame; a moving card costs at most 4.

import { subscribe, unsubscribe } from '../core/clock.js';
import { clamp01, easeOutCubic, easeOutBack, hash1 } from '../core/math.js';
import { setStyle } from '../core/dom.js';
import { cue, CUE } from './cues.js';

const K_FLY = 0, K_FLIP = 1, K_FADE = 2;

// §10's ceiling, enforced here rather than trusted at 20 call sites: a
// staggered event's LAST card must still be settled 600ms after the event.
// Measured before this existed: a 3-card set_stolen (80ms base + 60ms/card +
// a 462ms flight) committed the table to 602ms. Late cards lose stagger, not
// duration — a caravan that bunches up still reads; a caravan whose last card
// crawls does not.
const MAX_EVENT_MS = 600;

// 0.9 lands with ~4.5% overshoot. 1.70158 (the classic constant) put a card
// 19px past a bank slot on a 1280px table and read as a bounce, not a landing.
const BACK = 0.9;
const SCALE_BACK = 0.55;  // see step(): the landing squash, measured in the comment there

const pool = [];
const live = [];
let running = false;

/* ── record lifecycle ──────────────────────────────────────────────────── */

function take() {
  const r = pool.pop();
  if (r) return r;
  return {
    kind: K_FLY, node: null, t: 0, delay: 0, dur: 0.3, started: false,
    x0: 0, y0: 0, x1: 0, y1: 0, s0: 1, s1: 1, r0: 0, r1: 0,
    ax: 0, ay: 0, env: 1, spin: 0, bump: 0,
    flipAt: -1, flipUp: true,
    cx0: 0, cy0: 0, cx1: 0, cy1: 0,
    mine: false, big: false, quiet: false,
    from: 0, to: 0,
    wx: NaN, wy: NaN, ws: NaN, wr: NaN,
    onDone: null,
  };
}

/** Seconds of delay this record may have and still land inside the budget. */
function budgetDelay(ms, durSec) {
  const room = MAX_EVENT_MS - durSec * 1000;
  const d = ms || 0;
  return (d < room ? d : Math.max(0, room)) / 1000;
}

function slotOf(kind) { return kind === K_FLIP ? '__moF' : '__moT'; }

function attach(r) {
  const node = r.node;
  // interact/drag.js leaves a CSS transition on a card when its own spring-back
  // fallback runs. A transition on --fx/--fy turns every frame we write into a
  // lagged interpolation of a frame we already superseded.
  if (node.style.transition) node.style.transition = '';
  const slot = slotOf(r.kind);
  const prev = node[slot];
  if (prev && prev !== r) drop(prev, false);
  node[slot] = r;
  live.push(r);
  if (!running) { running = true; subscribe(tick); }
}

/** Remove a record from the live list without finishing it. */
function drop(r, applyEnd) {
  const i = live.indexOf(r);
  if (i >= 0) { live[i] = live[live.length - 1]; live.pop(); }
  if (applyEnd) finish(r);
  else {
    abort(r);
    if (r.node && r.node[slotOf(r.kind)] === r) r.node[slotOf(r.kind)] = null;
  }
  recycle(r);
}

/**
 * EVERY STARTED FLIGHT RESOLVES. Measured over a full seeded game: 173
 * card_slide cues against 159 card_snap cues — 14 swishes a game that begin and
 * are never answered, because the card was superseded mid-air (stolen while
 * landing, re-flown by a reconcile, picked up by a finger) and the record was
 * dropped without finish(). An unanswered swish is a sound with no consequence,
 * which is the definition of noise.
 *
 * So a dropped K_FLY that had already announced itself announces its ending
 * too. It is a distinct cue, not a fake landing: nothing touched the felt.
 */
function abort(r) {
  if (!r.node || r.kind !== K_FLY || !r.started || r.quiet) return;
  r.quiet = true;                                        // never twice
  r.node.classList.remove('is-flying');
  r.node.classList.remove('is-hero');
  cue(CUE.FLIGHT_ABORT, r.mine, r.big, r.cx1 || r.cx0, r.cy1 || r.cy0);
}

function recycle(r) {
  r.node = null;
  r.onDone = null;
  r.started = false;
  r.bump = 0;                              // pooled: a hero must not haunt the next flight
  r.wx = r.wy = r.ws = r.wr = NaN;
  if (pool.length < 96) pool.push(r);
}

/* ── the tick ──────────────────────────────────────────────────────────── */

function tick(dt) {
  for (let i = live.length - 1; i >= 0; i--) {
    const r = live[i];
    const node = r.node;

    // The interaction agent owns a card under a finger: it writes --fx/--fy
    // directly. Anything we write there is a tug-of-war the player feels.
    if (!node || !node.isConnected || node.classList.contains('is-dragging')) {
      live[i] = live[live.length - 1]; live.pop();
      abort(r);
      if (node && node[slotOf(r.kind)] === r) node[slotOf(r.kind)] = null;
      if (node && r.kind === K_FLY) { node.classList.remove('is-flying'); node.classList.remove('is-hero'); }
      recycle(r);
      continue;
    }

    r.t += dt;
    if (r.t < r.delay) continue;
    if (!r.started) begin(r);

    const p = r.dur > 0 ? clamp01((r.t - r.delay) / r.dur) : 1;
    step(r, p);

    if (p >= 1) {
      live[i] = live[live.length - 1]; live.pop();
      finish(r);
      recycle(r);
    }
  }
  if (live.length === 0) { running = false; unsubscribe(tick); }
}

function begin(r) {
  r.started = true;
  const node = r.node;
  if (r.kind === K_FLY) {
    if (!r.quiet) cue(CUE.FLIGHT_START, r.mine, r.big, r.cx0, r.cy0);
  } else if (r.kind === K_FLIP) {
    cue(CUE.FLIP, r.mine, r.big, r.cx0, r.cy0);
  }
}

function step(r, p) {
  const node = r.node;
  if (r.kind === K_FLY) {
    const e = easeOutBack(p, BACK);
    const env = r.env === 1 ? Math.sin(Math.PI * p) : Math.sin(Math.PI * Math.pow(p, r.env));
    // CONTACT. Scale used easeOutCubic — monotonic, so a card arrived at its
    // final size and simply stopped, and every landing on this table read as a
    // teleport with a sound on it. easeOutBack on the SAME axis costs nothing
    // and gives the landing a direction: a card growing (deck 26px → hand 62px)
    // overshoots ~2.5% and settles back, a card shrinking (hand 62px → a 14px
    // property slot) undershoots and springs open. That is a squash, and it is
    // free. SCALE_BACK 0.55 not 0.9: at 0.9 a hand card's 4.5% overshoot was
    // 2.8px of edge movement and read as a bounce.
    write(r, node,
      r.x0 + (r.x1 - r.x0) * e + r.ax * env,
      r.y0 + (r.y1 - r.y0) * e + r.ay * env,
      r.s0 + (r.s1 - r.s0) * easeOutBack(p, SCALE_BACK) + r.bump * env,
      r.r0 + (r.r1 - r.r0) * e + r.spin * env);
    if (r.flipAt >= 0 && p >= r.flipAt) {
      const at = r.flipAt; r.flipAt = -1;
      flip(node, r.flipUp, { mine: r.mine, big: r.big, dur: Math.max(120, r.dur * 1000 * (1 - at)) });
    }
    return;
  }
  if (r.kind === K_FLIP) {
    const smooth = p * p * (3 - 2 * p);
    const deg = r.from + (r.to - r.from) * smooth;
    const q = Math.round(deg * 10) / 10;
    if (q !== r.wr) { r.wr = q; node.style.setProperty('--flip', q + 'deg'); }
    // Swap the truth at the half-turn, where the face actually changes.
    if (p >= 0.5 && node.getAttribute('data-facing') !== (r.flipUp ? 'up' : 'down')) {
      node.setAttribute('data-facing', r.flipUp ? 'up' : 'down');
    }
    return;
  }
  // K_FADE — the prefers-reduced-motion collapse (§0.9): in place, ≤120ms.
  const o = Math.round((r.from + (r.to - r.from) * p) * 100) / 100;
  if (o !== r.wr) { r.wr = o; node.style.opacity = o >= 1 ? '' : String(o); }
}

function finish(r) {
  const node = r.node;
  if (!node) return;
  if (node[slotOf(r.kind)] === r) node[slotOf(r.kind)] = null;

  if (r.kind === K_FLY) {
    write(r, node, r.x1, r.y1, r.s1, r.r1);
    node.classList.remove('is-flying');
    node.classList.remove('is-hero');
    if (r.flipAt >= 0) { const up = r.flipUp; r.flipAt = -1; setFacing(node, up); }
    // The travel vector rides along so fx/ can spray the impact in the direction
    // the card was going instead of in a full circle (which reads as sparkle).
    if (!r.quiet) cue(CUE.LANDED, r.mine, r.big, r.cx1, r.cy1, r.cx1 - r.cx0, r.cy1 - r.cy0);
  } else if (r.kind === K_FLIP) {
    node.style.removeProperty('--flip');
    node.setAttribute('data-facing', r.flipUp ? 'up' : 'down');
  } else {
    node.style.opacity = '';
  }
  const done = r.onDone;
  r.onDone = null;
  if (done) done(node);
}

/** Guarded, quantised var writes — the whole hot path's DOM cost. */
function write(r, node, x, y, s, rot) {
  const qx = Math.round(x * 10) / 10;
  if (qx !== r.wx) { r.wx = qx; node.style.setProperty('--fx', qx + 'px'); }
  const qy = Math.round(y * 10) / 10;
  if (qy !== r.wy) { r.wy = qy; node.style.setProperty('--fy', qy + 'px'); }
  const qs = Math.round(s * 1000) / 1000;
  if (qs !== r.ws) { r.ws = qs; node.style.setProperty('--fs', qs === 1 ? '1' : String(qs)); }
  const qr = Math.round(rot * 10) / 10;
  if (qr !== r.wr) { r.wr = qr; node.style.setProperty('--tilt', qr + 'deg'); }
}

/* ── rest pose ─────────────────────────────────────────────────────────── */

export function restX(node) { return node.__rx || 0; }
export function restY(node) { return node.__ry || 0; }
export function restTilt(node) { return node.__rt || 0; }

/** Write the resting pose now. No-op while the card is under a finger. */
export function writeRest(node) {
  if (!node || node.classList.contains('is-dragging')) return;
  const x = node.__rx || 0, y = node.__ry || 0, t = node.__rt || 0;
  setStyle(node, '--fx', x === 0 ? '0px' : Math.round(x * 10) / 10 + 'px');
  setStyle(node, '--fy', y === 0 ? '0px' : Math.round(y * 10) / 10 + 'px');
  setStyle(node, '--tilt', t === 0 ? '0deg' : Math.round(t * 100) / 100 + 'deg');
  setStyle(node, '--fs', '1');
}

/**
 * The rest pose changed (fan reflow, a card left the hand, a discard settled).
 * A card in the air is retargeted in place — it lands on the NEW pose instead
 * of landing on the old one and then jumping.
 */
export function retarget(node) {
  const r = node && node.__moT;
  if (r && r.kind === K_FLY) {
    r.x1 = node.__rx || 0;
    r.y1 = node.__ry || 0;
    r.r1 = node.__rt || 0;
    return;
  }
  writeRest(node);
}

/* ── public motion ─────────────────────────────────────────────────────── */

export function isFlying(node) { return !!(node && node.__moT && node.__moT.kind === K_FLY); }
export function isFlipping(node) { return !!(node && node.__moF); }
export function isDragging(node) { return !!node && node.classList.contains('is-dragging'); }
export function liveCount() { return live.length; }

/**
 * Milliseconds until nothing is moving. This is the number §10's "≤600ms per
 * event, interruptible" is measured against: read it straight after an event's
 * choreography is scheduled and it is exactly how long the table has committed
 * to being in motion. 0 = settled.
 */
export function busyUntil() {
  let ms = 0;
  for (let i = 0; i < live.length; i++) {
    const r = live[i];
    const left = (r.delay + r.dur - r.t) * 1000;
    if (left > ms) ms = left;
  }
  return ms;
}

export function cancel(node) {
  if (!node) return;
  if (node.__moT) drop(node.__moT, false);
  if (node.__moF) drop(node.__moF, false);
  node.classList.remove('is-flying');
}

/** Snap every live record to its end state. Reconnect, fixture load, win (§5). */
export function finishAll() {
  while (live.length) {
    const r = live[live.length - 1];
    live.pop();
    // Silent: a snap is not a performance, and a reconnect that lands nine
    // cards in one frame must not fire nine landing cues at the audio bus.
    r.quiet = true;
    finish(r);
    recycle(r);
  }
  running = false;
  unsubscribe(tick);
}

/**
 * Launch a card. `o.dx/o.dy` is where the card IS relative to where it belongs
 * (the FLIP invert, measured by table/moveCard); it flies from there to rest.
 *
 * @param {Element} node
 * @param {{dx:number, dy:number, scale?:number, dur?:number, delay?:number,
 *          arc?:number, spin?:number, env?:number, tiltFrom?:number,
 *          flipTo?:boolean|null, flipAt?:number, mine?:boolean, big?:boolean,
 *          quiet?:boolean, cx0?:number, cy0?:number, cx1?:number, cy1?:number,
 *          key?:number, onDone?:Function}} o
 */
export function fly(node, o) {
  if (!node || isDragging(node)) return null;
  const rx = node.__rx || 0, ry = node.__ry || 0, rt = node.__rt || 0;
  const dx = o.dx || 0, dy = o.dy || 0;
  const dist = Math.sqrt(dx * dx + dy * dy);

  const r = take();
  r.kind = K_FLY;
  r.node = node;
  r.t = 0;
  r.dur = Math.max(0.06, (o.dur || 260) / 1000);
  r.delay = budgetDelay(o.delay, r.dur);
  r.started = false;
  r.x0 = rx + dx; r.y0 = ry + dy;
  r.x1 = rx; r.y1 = ry;
  r.s0 = o.scale == null ? 1 : o.scale; r.s1 = 1;
  r.r0 = o.tiltFrom == null ? rt : o.tiltFrom; r.r1 = rt;
  r.env = o.env || 1;
  r.spin = o.spin || 0;
  // Hero lift (table/moveCard sizes it): extra scale on the sin envelope, so it
  // is exactly 0 at both ends and the measured FLIP still lands on 1.
  r.bump = o.bump || 0;
  r.flipAt = o.flipTo == null ? -1 : (o.flipAt == null ? 0.55 : o.flipAt);
  r.flipUp = !!o.flipTo;
  r.mine = !!o.mine; r.big = !!o.big; r.quiet = !!o.quiet;
  r.cx0 = o.cx0 || 0; r.cy0 = o.cy0 || 0; r.cx1 = o.cx1 || 0; r.cy1 = o.cy1 || 0;
  r.onDone = o.onDone || null;
  r.wx = r.wy = r.ws = r.wr = NaN;

  // Arc: a lift PERPENDICULAR to travel, biased upward so a card always rises
  // off the felt rather than sliding sideways through it. Straight-up travel
  // has no upward perpendicular, so the side is picked from the card id and is
  // therefore identical in every screenshot run (§5: no Math.random here).
  const arc = o.arc == null ? Math.min(30, Math.max(5, dist * 0.14)) : o.arc;
  if (arc === 0 && (o.arcX || o.arcY)) {
    r.ax = o.arcX || 0; r.ay = o.arcY || 0;                 // explicit bow
  } else if (arc !== 0 && dist > 0.5) {
    let px = dy / dist, py = -dx / dist;          // travel is (-dx,-dy): perp
    if (py > 0.001) { px = -px; py = -py; }        // prefer the upward normal
    else if (Math.abs(py) <= 0.001) {
      const s = hash1((o.key || 0) + 11) < 0.5 ? -1 : 1;
      px *= s; py *= s;
    }
    r.ax = px * arc; r.ay = py * arc;
  } else if (o.arcX || o.arcY) {
    r.ax = o.arcX || 0; r.ay = o.arcY || 0;
  } else { r.ax = 0; r.ay = 0; }

  // Hold the card at the start of the path through any delay, so a staggered
  // caravan does not show its later cards sitting at the destination first.
  // .is-flying goes on now, not at launch: a card waiting its turn in the
  // caravan still has to sit above the pile it is leaving.
  write(r, node, r.x0, r.y0, r.s0, r.r0);
  node.classList.add('is-flying');
  if (r.bump > 0) node.classList.add('is-hero');
  attach(r);
  return r;
}

/**
 * A one-way trip AWAY from rest, for a card that is about to stop existing:
 * the discard folding home into the deck on a reshuffle. The node keeps its
 * parent (the deck stack is a pooled-back zone with no room for identities)
 * and reconcile removes it a beat later.
 */
export function flyOut(node, dx, dy, o = {}) {
  if (!node || isDragging(node)) return null;
  const rx = node.__rx || 0, ry = node.__ry || 0, rt = node.__rt || 0;
  const r = take();
  r.kind = K_FLY;
  r.node = node;
  r.t = 0;
  r.dur = Math.max(0.06, (o.dur || 260) / 1000);
  r.delay = budgetDelay(o.delay, r.dur);
  r.started = false;
  r.x0 = rx; r.y0 = ry;
  r.x1 = rx + dx; r.y1 = ry + dy;
  r.s0 = 1; r.s1 = o.scale == null ? 0.7 : o.scale;
  r.r0 = rt; r.r1 = rt + (o.turn || 0);
  r.ax = o.arcX || 0; r.ay = o.arcY || 0;
  r.env = o.env || 1;
  r.spin = 0;
  r.flipAt = -1;
  r.mine = !!o.mine; r.big = !!o.big; r.quiet = o.quiet !== false;
  r.cx0 = o.cx0 || 0; r.cy0 = o.cy0 || 0; r.cx1 = o.cx1 || 0; r.cy1 = o.cy1 || 0;
  r.onDone = o.onDone || null;
  r.wx = r.wy = r.ws = r.wr = NaN;
  node.classList.add('is-flying');
  attach(r);
  return r;
}

/**
 * A there-and-back shove with no reparenting: the OPSEC clash and the knocked
 * -back action card. Skewed envelope (peak at ~35%) so it lunges out fast and
 * recovers slowly — a symmetric sine read as a wobble, not a hit.
 */
export function punch(node, dx, dy, o = {}) {
  if (!node || isDragging(node)) return null;
  const rx = node.__rx || 0, ry = node.__ry || 0, rt = node.__rt || 0;
  const r = take();
  r.kind = K_FLY;
  r.node = node;
  r.t = 0;
  r.dur = Math.max(0.06, (o.dur || 300) / 1000);
  r.delay = budgetDelay(o.delay, r.dur);
  r.started = false;
  r.x0 = r.x1 = rx; r.y0 = r.y1 = ry;
  r.s0 = o.scale == null ? 1 : o.scale; r.s1 = 1;
  r.r0 = r.r1 = rt;
  r.ax = dx; r.ay = dy;
  r.env = o.env || 0.62;
  r.spin = o.spin || 0;
  r.flipAt = -1;
  r.mine = !!o.mine; r.big = !!o.big; r.quiet = o.quiet !== false;
  r.cx0 = o.cx0 || 0; r.cy0 = o.cy0 || 0; r.cx1 = o.cx1 || 0; r.cy1 = o.cy1 || 0;
  r.onDone = o.onDone || null;
  r.wx = r.wy = r.ws = r.wr = NaN;
  node.classList.add('is-flying');
  attach(r);
  return r;
}

/**
 * Spring a card home from wherever a finger left it. The interaction agent's
 * drop-cancel path (table.moveCard(id,'hand',{springBack:true})).
 */
export function springHome(node, o = {}) {
  if (!node) return null;
  const x = readVar(node, '--fx');
  const y = readVar(node, '--fy');
  const rx = node.__rx || 0, ry = node.__ry || 0;
  return fly(node, {
    dx: x - rx, dy: y - ry,
    dur: o.dur || 240, arc: 0, spin: o.spin || 0,
    mine: true, quiet: !!o.quiet, key: o.key || 0,
    cx0: o.cx0 || 0, cy0: o.cy0 || 0, cx1: o.cx1 || 0, cy1: o.cy1 || 0,
  });
}

function readVar(node, name) {
  const v = parseFloat(node.style.getPropertyValue(name));
  return Number.isFinite(v) ? v : 0;
}

/**
 * Flip a card about its Y axis. The rotation lives on the INNER wrapper
 * (.card-inner) so the outer .card transform stays exactly the contract.
 */
export function flip(node, up, o = {}) {
  if (!node) return null;
  const facing = node.getAttribute('data-facing');
  const already = up ? facing !== 'down' : facing === 'down';
  const inFlight = node.__moF;
  if (already && !inFlight) return null;

  // Reversing mid-flip starts from the degree actually on screen, not from 0.
  const from = inFlight
    ? (Number.isFinite(inFlight.wr) ? inFlight.wr : inFlight.from)
    : (facing === 'down' ? 180 : 0);
  const r = take();
  r.kind = K_FLIP;
  r.node = node;
  r.t = 0;
  r.dur = Math.max(0.06, (o.dur || 190) / 1000);
  r.delay = budgetDelay(o.delay, r.dur);
  r.started = false;
  r.from = from;
  r.to = up ? 0 : 180;
  r.flipUp = !!up;
  r.mine = !!o.mine; r.big = !!o.big;
  r.cx0 = o.cx0 || 0; r.cy0 = o.cy0 || 0;
  r.onDone = o.onDone || null;
  r.wr = NaN;
  node.style.setProperty('--flip', from + 'deg');
  attach(r);
  return r;
}

/** No animation: set the face now. */
export function setFacing(node, up) {
  if (!node) return;
  if (node.__moF) drop(node.__moF, false);
  node.style.removeProperty('--flip');
  const want = up ? 'up' : 'down';
  if (node.getAttribute('data-facing') !== want) node.setAttribute('data-facing', want);
}

/** The reduced-motion collapse: appear in place, ≤120ms, cues unchanged. */
export function fade(node, o = {}) {
  if (!node) return null;
  const r = take();
  r.kind = K_FADE;
  r.node = node;
  r.t = 0;
  r.dur = Math.min(0.12, Math.max(0.04, (o.dur || 120) / 1000));
  r.delay = budgetDelay(o.delay, r.dur);
  r.started = false;
  r.from = o.from == null ? 0.25 : o.from;
  r.to = 1;
  r.mine = !!o.mine; r.big = !!o.big;
  r.onDone = o.onDone || null;
  r.wr = NaN;
  node.style.opacity = String(r.from);
  attach(r);
  return r;
}
