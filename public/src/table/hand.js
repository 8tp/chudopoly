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
  if (n === 0) return;
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
  const centre = (n - 1) / 2;
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

  // Pass 2: write.
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    const u = centre > 0 ? (i - centre) / centre : 0;      // -1 … 1
    // Centred on the row (−half at the middle, +half at the edges) instead of
    // hanging below it: measured on a 390×844 phone, the dock leaves a hand
    // card 93px of a needed 84px, so a fan that only pushed DOWN clipped its
    // outermost cards at the viewport edge.
    let y = EDGE_DROP * h * (u * u - 0.5);
    // The physical rise for BOTH selection states lives here: the transform
    // contract allows exactly one transform declaration on .card, so design
    // can only light a lifted card (shadow, rim, brightness) — the height has
    // to come from the rest pose.
    if (node.classList.contains('is-lifted')) y -= LIFT * h;
    else if (node.classList.contains('is-picked')) y -= PICK_LIFT * h;
    setRest(node, 0, y, (span / 2) * u);

    const px = node.__hx, py = node.__hy;
    node.__hx = lx[i]; node.__hy = ly[i];
    if (px === undefined) continue;                        // first sight
    if (!animate || flight.isFlying(node) || flight.isDragging(node)) continue;
    const dx = px - lx[i];
    const dy = py - ly[i];
    if (Math.abs(dx) < REFLOW_MIN && Math.abs(dy) < REFLOW_MIN) continue;
    // 190ms: the reflow must be over before the next event's flight starts
    // (draw stagger is 60ms/card, so two draws = 120ms of runway).
    flight.fly(node, { dx, dy, dur: 190, arc: 0, quiet: true, key: i, mine: true });
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

/** A card left the hand: forget its layout box so it does not "reflow" back. */
export function forget(node) {
  if (!node) return;
  node.__hx = undefined;
  node.__hy = undefined;
}
