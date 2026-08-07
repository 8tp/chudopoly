// table/hand.js — the fan. Your hand is the only zone that is a SHAPE rather
// than a stack, and it is laid out entirely in rest-pose numbers (--tilt/--fy
// per card) because the transform contract (§5) leaves .card's transform to the
// flight engine. No CSS rule fans anything; the flex row still owns the
// horizontal spacing, this file owns the arc.
//
// Measurements (390×844 phone, hand card 66×92px in a 379px-wide zone):
//   the zone's own -28% overlap needs 414px at 8 cards — one over the hand
//   limit and the hand becomes a horizontal scroller, so tighten() takes the
//   step down instead (see below).
//   Fan spread capped at 24° total: at 4.6°/card an 8-card hand reached 32°
//   and the outermost card's tilt cost 18px of the zone's 126px height.
//   Edge drop 0.055 × card height, centred: below 0.04 the arc is invisible at
//   66px wide; hanging it all downward put the outer cards at the dock's edge.

import { setRest } from './cardnode.js';
import { setStyle } from '../core/dom.js';
import { DEG } from '../core/math.js';
import * as flight from '../anim/flight.js';

const SPREAD_PER_CARD = 4.6;      // degrees
const SPREAD_MAX = 24;            // degrees, total
const EDGE_DROP = 0.055;          // × card height
const LIFT = 0.20;                // × card height, for .is-lifted (tap-selected)
const PICK_LIFT = 0.11;           // × card height, for .is-picked (pay/discard)
const REFLOW_MIN = 2;             // px — under this a "shift" is rotation noise
const REFLOW_TILT_MIN = 0.8;      // deg — the flatten has to survive this floor

// ART-DIRECTION §5.5: "Hand retracts 24px and flattens on drag start, opening
// the path." Retract is +y because the dock is at the BOTTOM of the screen —
// away from the board is down. The flatten is the same 24° of fan going to 0,
// which on a 92px card moves the outermost card's top corner 9.6px inboard and
// is what actually opens the lane, more than the 24px does.
//
// CLAMPED TO THE ROOM THERE ACTUALLY IS (table.liftCard measures it). §10's
// ship gate already records "Phone: is the hand fully on-screen? Current: no",
// and pushing the fan a further 24px down would deepen the one defect the gate
// is watching. Measured room under the fan on the current build: desktop
// 1280×720 = 18px, phone 390×844 = 18px — so the ratified 24 clamps to 18 on
// both until §5's three-column table gives the hand the 150px it specifies.
// The flatten is NOT clamped and does the larger half of the job: 12° → 0°
// takes 9.6px of tilt overhang off the top of every outer card.
const RETRACT_PX = 24;

// Preallocated: reflow runs on every reconcile and must not allocate (§0.8).
let lx = new Float64Array(32);
let ly = new Float64Array(32);

function grow(n) {
  if (n <= lx.length) return;
  let size = lx.length;
  while (size < n) size *= 2;
  lx = new Float64Array(size);
  ly = new Float64Array(size);
}

/* ── the fan's three modal states ──────────────────────────────────────────
   All three are POSE, never layout: nothing here writes a margin, a width or a
   display, so a card under a finger keeps the layout box its --fx/--fy delta
   was captured against (interact/drag.js dragStart) and cannot jump.

   held     the node currently out of the fan (a finger has it)
   openness 1 = the fan still holds a slot for it, 0 = the gap is closed
   retracted the whole hand is back 24px and flat (§5.5) */
let held = null;
let openness = 1;
let retracted = false;

export function heldNode() { return held; }
export function isRetracted() { return retracted; }

/** @returns {boolean} true if the fan's shape changed and needs a relayout. */
export function setHeld(node) {
  if (held === node) return false;
  held = node || null;
  return true;
}

/** 0 = closed over the gap, 1 = open and waiting to receive the card back. */
export function setOpenness(v) {
  const o = v < 0 ? 0 : v > 1 ? 1 : v;
  if (o === openness) return false;
  openness = o;
  return true;
}

/**
 * @param {boolean} on
 * @param {number} [roomPx] how far the fan may travel before it leaves the
 *        viewport. Measured once per lift by table.liftCard, not here: it costs
 *        one rect per card and layout() runs on every reconcile.
 */
export function setRetracted(on, roomPx) {
  const v = !!on;
  const r = roomPx == null ? retractRoom : Math.max(0, Math.min(RETRACT_PX, roomPx));
  if (v === retracted && r === retractRoom) return false;
  retracted = v;
  retractRoom = r;
  return true;
}
let retractRoom = RETRACT_PX;

/** The retract actually applied, in px. Measurement hook. */
export function retractPx() { return retracted ? retractRoom : 0; }

/** Everything back to the resting fan. Called by table.releaseCard. */
export function reset() {
  const changed = held !== null || openness !== 1 || retracted;
  held = null; openness = 1; retracted = false; retractRoom = RETRACT_PX;
  return changed;
}

/**
 * Fan `nodes` (already in DOM order inside the hand zone) and animate any card
 * whose LAYOUT box moved — that is the reflow when a card enters or leaves.
 *
 * offsetLeft/offsetTop, not getBoundingClientRect: they are immune to both the
 * transform we are about to write and to the zone's horizontal scroll, so a
 * player scrolling their hand does not trigger a table-wide settle.
 *
 * @param {Element[]} nodes
 * @param {boolean} animate
 */
export function layout(nodes, animate) {
  const n = nodes.length;
  if (n === 0) { if (held && !held.isConnected) reset(); return; }
  grow(n);

  // Squeeze before scrolling. table.css fans the hand at a fixed -28% overlap,
  // which measured 414px of content in a 379px zone at 8 cards on a 390×844
  // phone — the eighth card sat off the right edge and the hand became a
  // scroller at one card over the limit. Tightening the step keeps every card
  // on screen down to a 26px strip, which is still wide enough to tap and
  // wide enough to show a card's colour band. This runs BEFORE the offset
  // reads below, because it is what those offsets have to measure.
  const zone = nodes[0].parentElement;
  const w = nodes[0].offsetWidth || 0;
  const h = nodes[0].offsetHeight || 0;
  const span = n > 1 ? Math.min(SPREAD_MAX, SPREAD_PER_CARD * (n - 1)) : 0;

  // The outermost cards are TILTED, and a tilted card is wider than its layout
  // box by about (h/2)·sin(θ) — 9.6px at 12° on a 92px card. Unreserved, that
  // is exactly what hung over the zone edge and got clipped by its overflow.
  const overhang = (h / 2) * Math.sin(span / 2 * DEG);
  tighten(nodes, n, w, innerWidthOf(zone) - 2 * overhang);

  // Read every geometry first, then write every pose — one layout flush each.
  for (let i = 0; i < n; i++) {
    lx[i] = nodes[i].offsetLeft;
    ly[i] = nodes[i].offsetTop;
  }

  /* ── the gap ────────────────────────────────────────────────────────────
     `out` is the DOM index of the card a finger is holding, or −1. With the
     gap CLOSED the remaining n−1 cards form a complete (n−1)-card fan: the row
     is one step narrower, so re-centring moves its left edge +step/2 and every
     card past the hole moves back one step. That is the whole reflow:

         x(i) = step/2 + (virtualIndex(i) − i) · step
              = +step/2   for i < out
              = −step/2   for i > out

     and the fan's own u/tilt/drop are recomputed over n−1 cards so the arc
     re-forms rather than keeping a notch in it. `openness` lerps that against
     the untouched n-card fan, which is what "opens to receive it" means when
     the card hovers back over the hand.

     A pose, not a layout change: nothing here writes a margin, so the held
     card's own layout box — the origin its --fx delta was captured against —
     cannot move under the finger. */
  const out = held ? nodes.indexOf(held) : -1;
  const step = n > 1 ? lx[1] - lx[0] : 0;
  const closing = out >= 0 ? 1 - openness : 0;
  const vn = n - closing;                                   // fractional on purpose
  const spanV = vn > 1 ? Math.min(SPREAD_MAX, SPREAD_PER_CARD * (vn - 1)) : 0;
  const flat = retracted ? 0 : 1;
  // The fan's lowest point is the OUTERMOST card (+EDGE_DROP·h/2); that is what
  // has to stay inside the zone, not the centre card.
  const pull = retracted ? retractRoom : 0;

  // Pass 2: write.
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (i === out) { node.__vx = undefined; continue; }     // the finger owns it

    // Virtual slot: the card's index in the fan the player is looking at.
    const vi = out >= 0 && i > out ? i - closing : i;
    const half = (vn - 1) / 2;
    const u = half > 0 ? (vi - half) / half : 0;            // -1 … 1
    const x = out >= 0 ? closing * (step / 2) * (i < out ? 1 : -1) : 0;
    // Centred on the row (−half at the middle, +half at the edges) instead of
    // hanging below it: measured on a 390×844 phone, the dock leaves a hand
    // card 93px of a needed 84px, so a fan that only pushed DOWN clipped its
    // outermost cards at the viewport edge.
    let y = EDGE_DROP * h * (u * u - 0.5) + pull;
    // The physical rise for BOTH selection states lives here: the transform
    // contract allows exactly one transform declaration on .card, so design
    // can only light a lifted card (shadow, rim, brightness) — the height has
    // to come from the rest pose.
    if (node.classList.contains('is-lifted')) y -= LIFT * h;
    else if (node.classList.contains('is-picked')) y -= PICK_LIFT * h;
    const deg = (spanV / 2) * u * flat;

    // VISUAL position, not layout position. The old reflow compared offsetLeft
    // alone, which is blind to every pose above — closing the gap moves a card
    // 27px without moving its layout box by a pixel, so it would have snapped.
    const pvx = node.__vx, pvy = node.__vy, pvt = node.__vt;
    setRest(node, x, y, deg);
    const vx = lx[i] + x, vy = ly[i] + y;
    node.__vx = vx; node.__vy = vy; node.__vt = deg;
    if (pvx === undefined) continue;                        // first sight
    if (!animate || flight.isFlying(node) || flight.isDragging(node)) continue;
    const dx = pvx - vx;
    const dy = pvy - vy;
    const dt = pvt - deg;
    if (Math.abs(dx) < REFLOW_MIN && Math.abs(dy) < REFLOW_MIN
      && Math.abs(dt) < REFLOW_TILT_MIN) continue;
    // 190ms: the reflow must be over before the next event's flight starts
    // (draw stagger is 60ms/card, so two draws = 120ms of runway).
    flight.fly(node, {
      dx, dy, dur: 190, arc: 0, quiet: true, key: i, mine: true,
      tiltFrom: deg + dt,
    });
  }
}

const MIN_STRIP = 26;             // px of each card that must stay visible
let cssStep = 0;                  // the stylesheet's natural step, learned once
let padW = -1, padPx = 0;         // zone padding, re-read only when width changes

/** clientWidth is the padding box; the cards live in the content box. Missing
 *  that was 8.6px of overflow — one card's worth of scroll at eight cards. */
function innerWidthOf(zone) {
  if (!zone) return 0;
  const w = zone.clientWidth;
  if (w !== padW) {
    const cs = getComputedStyle(zone);
    padPx = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    padW = w;
  }
  return w - padPx;
}

/**
 * Narrow the gap between hand cards until the whole hand fits the zone, and
 * not one pixel narrower — an inline margin is only written while the CSS
 * default would overflow, so the stylesheet stays in charge of the normal case.
 */
function tighten(nodes, n, w, zoneW) {
  if (n < 2 || !w || !zoneW) return;
  if (!cssStep && !nodes[1].style.marginLeft) cssStep = nodes[1].offsetLeft - nodes[0].offsetLeft;
  const natural = cssStep || w * 0.72;
  const room = (zoneW - w) / (n - 1);
  const fits = room >= natural;
  const step = fits ? natural : Math.max(MIN_STRIP, room);
  for (let i = 1; i < n; i++) {
    setStyle(nodes[i], 'margin-left', fits ? '' : `${Math.round(step - w)}px`);
  }
}

/** A card left the hand: forget its pose so it does not "reflow" back. */
export function forget(node) {
  if (!node) return;
  node.__vx = undefined;
  node.__vy = undefined;
  node.__vt = undefined;
  if (held === node) held = null;
}
