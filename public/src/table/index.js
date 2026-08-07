// table/index.js — the §5 table API.
//
//   zoneFor(kind, ownerId, color)         → zone element
//   spawnCard(card, zoneKey)              → node, parented to the zone
//   moveCard(id, zoneKey, {animate, ...}) → reparent + measured flight
//   reconcile(snapshot, {expected})       → snapshot wins; count what surprised us
//
// The snapshot is truth and animation is presentation (§10). reconcile()
// therefore never asks how a card got somewhere — it computes where every card
// belongs and puts it there. `driftCount` counts only the corrections the
// choreographer did NOT claim: a nonzero count means the animation told the
// player a different story than the server did.
//
// P4: the FLIP invert is no longer a CSS transition. moveCard measures, then
// hands the invert to anim/flight.js, which owns --fx/--fy/--fs/--tilt on the
// one clock until the card lands on its rest pose (see cardnode.js).

import { orderChildren, setText, setAttr, setClass, prefersReducedMotion } from '../core/dom.js';
import { COLOR_KEYS } from '../core/cards.js';
import { hash1, clamp } from '../core/math.js';
import { cardNode, getNode, allNodes, forgetNode, refresh, syncBacks, tilt, setRest } from './cardnode.js';
import * as layout from './layout.js';
import * as hand from './hand.js';
import * as flight from '../anim/flight.js';
import { cue, CUE } from '../anim/cues.js';

export const zoneFor = layout.zoneFor;
export const zoneKeyFor = layout.zoneKeyFor;
export const boardEl = layout.boardEl;
export const allBoards = layout.allBoards;

const DECK_DEPTH = 6;         // §5: a real stack, up to 6 back nodes + count
const HAND_BACKS = 9;         // §5: count-accurate to 9, then a counter
const DISCARD_VISIBLE = 4;    // deeper cards are invisible anyway; 50 nodes was 3ms/reconcile
const DECK_LIFT = -1.5;       // px per card of stack depth
const DISCARD_TILT = 7;       // §5: seeded per card id, deterministic

// Flight duration from measured distance (§6 wants 180–420ms). 0.42ms/px puts
// deck→hand (≈250px on a 390px phone) at 285ms and the longest cross-table
// steal (≈580px on desktop) at the 420 ceiling.
const MS_MIN = 180, MS_MAX = 420, MS_PER_PX = 0.42;

// Apex width of a hero flight (a steal, a set being taken, a swap). 92px puts
// the card's name band at ~13px on a 1280×720 table — the smallest size the
// name was still readable at in the frame captures. Bigger than ~110 and the
// card covers the board it is being taken from.
const HERO_APEX_PX = 92;

const EMPTY = new Set();

const metrics = { drift: 0, lastCorrections: [] };
let selfId = null;
let reduceMotion = false;

export function mount(mySeatId) {
  selfId = mySeatId;
  reduceMotion = prefersReducedMotion();
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => { reduceMotion = mq.matches; if (reduceMotion) flight.finishAll(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  layout.mount(document.getElementById('table'), mySeatId);
}

export function setSelf(id) {
  selfId = id;
  // layout.js keys every zone off the seat id ('hand' vs 'hand:<uuid>'), and it
  // used to learn that id only at mount() — before `joined` arrives — and then
  // only inside syncSeats(), which first runs at the job-ENDING reconcile. The
  // whole opening deal therefore addressed `hand:<uuid>`, got null, and did not
  // move. Propagating here is the fix; see layout.setSelf.
  layout.setSelf(id);
}
export function driftCount() { return metrics.drift; }
export function resetDrift() { metrics.drift = 0; metrics.lastCorrections.length = 0; }
export function lastCorrections() { return metrics.lastCorrections.slice(); }
export function reducedMotion() { return reduceMotion; }

/**
 * Build the STRUCTURE a job's choreography is about to address, before any of
 * its events run. Nothing here places a card — it seats the boards and paints
 * the piles so that zoneEl()/boardEl() answer during the very first job.
 *
 * Measured: without it the first job of every game ran against zero boards, so
 * every cue anchored on boardEl(actor) fired at viewport (0,0) and the opening
 * deal had nowhere to deal TO. reconcile() called syncSeats itself, at the end,
 * which is 1.9s too late.
 */
export function prepare(snapshot) {
  if (!snapshot) return false;
  const rebuilt = layout.syncSeats(snapshot, selfId);
  if (rebuilt) structuralPending = true;
  // A deal has to come off a visible deck. The count is the POST-deal number —
  // the same "snapshot is truth" lie the whole animation tells — and it beats
  // the measured alternative, which was dealing 20 cards off a stack labelled
  // "DECK 0".
  syncBacks(layout.zoneEl('deck'), Math.min(snapshot.deckCount || 0, DECK_DEPTH), { lift: DECK_LIFT });
  setText(document.getElementById('deck-count'), String(snapshot.deckCount ?? 0));
  return rebuilt;
}
let structuralPending = false;

/**
 * Fly `count` face-down backs from the deck into a face-down zone (an opponent's
 * hand). Opponent deals and draws carry no card ids by design (§4 redaction), so
 * there is nothing for moveCard to move — before this they were a `break`, and
 * three of the four events in the opening deal animated nothing at all.
 *
 * The backs it flies ARE the backs reconcile will keep: syncBacks() pools by
 * count, so adding them here and letting the reconcile re-pose them costs no
 * churn and cannot drift (a pooled back has no card id).
 *
 * @returns {number} backs actually launched
 */
export function dealBacks(zoneKey, count, opts = {}) {
  if (!(count > 0)) return 0;
  const zone = layout.zoneEl(zoneKey);
  const deck = layout.zoneEl('deck');
  if (!zone || !deck) return 0;
  const dr = deck.getBoundingClientRect();
  if (!dr.width) return 0;
  const have = zone.childElementCount;
  const want = Math.min(have + count, HAND_BACKS);
  if (want <= have) return 0;
  syncBacks(zone, want, { tilt: 4 });
  if (reduceMotion) return 0;

  const dcx = dr.left + dr.width / 2, dcy = dr.top + dr.height / 2;
  const stagger = opts.stagger || 0;
  let i = 0, launched = 0;
  for (let child = zone.firstElementChild; child; child = child.nextElementSibling, i++) {
    if (i < have) continue;
    const r = child.getBoundingClientRect();
    if (!r.width) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = dcx - cx, dy = dcy - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    flight.fly(child, {
      dx, dy,
      scale: r.width > 0 ? dr.width / r.width : 1,
      dur: clamp(MS_MIN + dist * MS_PER_PX, MS_MIN, MS_MAX),
      delay: launched * stagger,
      spin: (hash1(i + 7) * 2 - 1) * 10,
      mine: false, big: false, key: i,
      cx0: dcx, cy0: dcy, cx1: cx, cy1: cy,
    });
    launched++;
  }
  return launched;
}

export function spawnCard(card, zoneKey, opts = null) {
  const node = cardNode(card);
  if (!node) return null;
  const zone = layout.zoneEl(zoneKey);
  if (zone && node.parentElement !== zone) {
    layout.revealZone(zone);
    zone.appendChild(node);
    setRest(node, 0, 0, 0);
  }
  if (opts && opts.faceDown) flight.setFacing(node, false);
  return node;
}

/** Flip a card face-up/face-down about its Y axis (anim/flight owns the turn). */
export function flipCard(id, faceUp, opts = {}) {
  const node = getNode(id);
  if (!node) return false;
  if (opts.animate === false || reduceMotion) { flight.setFacing(node, faceUp); return true; }
  const r = node.getBoundingClientRect();
  flight.flip(node, faceUp, {
    mine: !!opts.mine, big: !!opts.big, dur: opts.duration,
    cx0: r.left + r.width / 2, cy0: r.top + r.height / 2,
  });
  return true;
}

/**
 * Reparent a card into a zone and fly it there.
 *
 * measure (centroid + offsetWidth, both immune to the transform we are about
 * to write) → reparent → neutralise → measure → launch. Centroids rather than
 * rect corners because a rectangle's AABB centre is its centroid under any
 * rotate/scale, so a card leaving a fanned hand measures exactly.
 *
 * @param {number} id
 * @param {string} zoneKey
 * @param {{animate?:boolean, force?:boolean, springBack?:boolean, delay?:number,
 *          speed?:number, arc?:number, spin?:number, flip?:boolean,
 *          flipAt?:number, mine?:boolean, big?:boolean, hold?:number,
 *          onDone?:Function}} opts
 */
export function moveCard(id, zoneKey, opts = {}) {
  const node = getNode(id);
  const zone = layout.zoneEl(zoneKey);
  if (!node || !zone) return false;
  const same = node.parentElement === zone;

  // The interaction agent's drop-cancel: the card never left the hand, it is
  // just sitting wherever the finger let go of it.
  if (opts.springBack) {
    if (!same) zone.appendChild(node);
    if (reduceMotion || flight.isDragging(node)) { flight.writeRest(node); return true; }
    const r = node.getBoundingClientRect();
    flight.springHome(node, {
      dur: opts.duration || 240, key: id,
      cx1: r.left + r.width / 2, cy1: r.top + r.height / 2,
    });
    return true;
  }
  if (same && !opts.force) return false;

  // `mine` is EITHER END, not the destination. Destination-only got the two
  // moments that matter exactly backwards: your own property being stolen
  // (properties:<you>:<colour> → properties:<thief>:<colour>) and your own CHUD
  // hitting the discard both resolved false, so audio played them −7dB,
  // off-centre and lowpassed as if they had happened to somebody else.
  const fromKey = node.parentElement ? node.parentElement.getAttribute('data-zone') : null;
  const mine = opts.mine == null
    ? (layout.isMineZone(zoneKey) || layout.isMineZone(fromKey))
    : !!opts.mine;

  layout.revealZone(zone);

  if (opts.animate === false || flight.isDragging(node)) {
    zone.appendChild(node);
    flight.cancel(node);
    if (opts.flip != null) flight.setFacing(node, opts.flip);
    setRest(node, 0, 0, 0);
    flight.writeRest(node);
    return true;
  }

  // §0.9: motion collapses to a fade in place; the cue vocabulary does not.
  if (reduceMotion) {
    zone.appendChild(node);
    flight.cancel(node);
    if (opts.flip != null) flight.setFacing(node, opts.flip);
    setRest(node, 0, 0, 0);
    flight.writeRest(node);
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    cue(CUE.FLIGHT_START, mine, !!opts.big, cx, cy);
    // A card that turns over is still a beat even when it does not turn.
    if (opts.flip != null) cue(CUE.FLIP, mine, !!opts.big, cx, cy);
    // LANDED fires NOW, not on the fade's onDone. Under reduced motion the card
    // is already at its destination the instant it is reparented, so hanging the
    // snap 120ms off the back of a purely cosmetic opacity ramp put the sound
    // 120ms behind the truth — §0.9 collapses motion, it does not delay signal.
    cue(CUE.LANDED, mine, !!opts.big, cx, cy);
    flight.fade(node, { dur: 120 });
    return true;
  }

  const first = node.getBoundingClientRect();
  const w0 = node.offsetWidth;
  const t0 = currentTilt(node);

  flight.cancel(node);
  zone.appendChild(node);
  setRest(node, 0, 0, 0);
  flight.writeRest(node);

  if (first.width === 0) {                       // was not rendered — nothing to invert
    if (opts.flip != null) flight.setFacing(node, opts.flip);
    return true;
  }

  const last = node.getBoundingClientRect();
  // The destination is not rendered (a hidden zone, a collapsed board). Inverting
  // against a 0×0 rect is what sent stolen cards flying to viewport (0,0) — the
  // card is placed and the beat is skipped rather than performed into a corner.
  if (last.width === 0) {
    if (opts.flip != null) flight.setFacing(node, opts.flip);
    return true;
  }

  const w1 = node.offsetWidth || w0;
  const dx = (first.left + first.width / 2) - (last.left + last.width / 2);
  const dy = (first.top + first.height / 2) - (last.top + last.height / 2);
  const scale = w1 > 0 ? w0 / w1 : 1;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 1 && Math.abs(scale - 1) < 0.02 && opts.flip == null) return true;

  // speed scales INSIDE the clamp: §6 caps a single flight at 420ms, and the
  // deliberate feel of a steal comes from its 120ms hold, not from a slower
  // card. (Outside the clamp, a 1.12× steal measured 470ms and pushed the
  // event's total commitment to 602ms.)
  const dur = clamp((MS_MIN + dist * MS_PER_PX) * (opts.speed || 1), MS_MIN, MS_MAX);
  // Deterministic per card so a screenshot run reproduces (§5).
  const spin = opts.spin == null
    ? (hash1(id + 3) * 2 - 1) * Math.min(12, 3 + dist * 0.02)
    : opts.spin;

  // HERO LIFT — a big-moment card has to be READABLE while it travels.
  // Measured on a 4-player 1280×720 table: a stolen property is a 14px-wide
  // miniature sliding between two 14px slots, illegible even at 2.8×
  // magnification of the capture, for the 480ms the choreographer spends
  // calling it drama. The bump is an extra scale on a sin envelope, so the card
  // swells at mid-flight and is back to exactly 1 when it lands — the measured
  // FLIP end state is untouched.
  //
  // HERO_APEX_PX is a target width at the apex, not a factor: the same +0.5 that
  // is right for a hand card would do nothing for a 14px mini.
  let bump = opts.bump || 0;
  if (!bump && opts.hero) bump = clamp(HERO_APEX_PX / Math.max(8, w1) - 1, 0.22, 4);
  if (bump > 0) unclip(node, dur + (opts.delay || 0) + 60);

  flight.fly(node, {
    dx, dy, scale, dur, bump,
    delay: opts.delay || 0,
    arc: opts.arc,
    spin,
    tiltFrom: t0,
    flipTo: opts.flip == null ? null : opts.flip,
    flipAt: opts.flipAt,
    mine,
    // A card that crossed a third of the viewport is an event you can feel.
    big: opts.big == null ? dist > Math.min(innerWidth, innerHeight) * 0.34 : !!opts.big,
    key: id,
    cx0: first.left + first.width / 2, cy0: first.top + first.height / 2,
    cx1: last.left + last.width / 2, cy1: last.top + last.height / 2,
    onDone: opts.onDone || null,
  });
  return true;
}

/** A there-and-back shove: the blocked action card, the OPSEC clash. */
export function shoveCard(id, dx, dy, opts = {}) {
  const node = getNode(id);
  if (!node || reduceMotion) return false;
  flight.punch(node, dx, dy, opts);
  return true;
}

/** The deck's riffle: the stack jitters in place. Pooled backs, no ids. */
export function riffleDeck() {
  const zone = layout.zoneEl('deck');
  if (!zone || reduceMotion) return false;
  let i = 0;
  for (let child = zone.firstElementChild; child; child = child.nextElementSibling, i++) {
    const side = i % 2 === 0 ? 1 : -1;
    child.classList.add('is-riffling');
    flight.punch(child, side * (3 + i * 1.6), -2 - i, {
      dur: 240, delay: i * 26, spin: side * (2 + i * 0.8), env: 0.8,
      onDone: (n) => n.classList.remove('is-riffling'),
    });
  }
  return i > 0;
}

/** Re-fan the hand after the interaction agent lifts/picks a card. */
export function relayoutHand() {
  const zone = layout.zoneEl('hand');
  if (!zone) return;
  const nodes = [];
  for (let c = zone.firstElementChild; c; c = c.nextElementSibling) {
    if (c.hasAttribute('data-card-id')) nodes.push(c);
  }
  hand.layout(nodes, !reduceMotion);
}

/* ── hero flights escape their clipping ancestors ──────────────────────────
   Every container a card lands in clips: `.opponents .board` and
   `.board-bank` are overflow:hidden, `.opponents .board-props`, `.zone-hand`,
   `.opponents` and `.self-board` are scroll boxes. A card magnified to 92px
   inside a 14px slot is therefore invisible — which is the whole reason the
   magnification exists.

   So the ancestor chain is opened for exactly the length of the flight and put
   back byte-for-byte, scroll offsets included. Precisely the chain, not a CSS
   class on #table: a blanket `overflow:visible` on the felt spills the
   opponents strip over the centre pile on a phone. Scrollbars are already
   `scrollbar-width:none` on every one of these, so opening them reflows
   nothing. */
const unclipped = new Map();                // element -> {overflow, sl, st, until}
let unclipTimer = 0;

function unclip(node, ms) {
  const until = performance.now() + ms;
  for (let e = node.parentElement; e && e !== document.body; e = e.parentElement) {
    const prev = unclipped.get(e);
    if (prev) { if (until > prev.until) prev.until = until; continue; }
    const cs = getComputedStyle(e);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    unclipped.set(e, { overflow: e.style.overflow, sl: e.scrollLeft, st: e.scrollTop, until });
    e.style.overflow = 'visible';
    if (e.id === 'table') break;
  }
  if (!unclipTimer && unclipped.size) unclipTimer = setTimeout(reclip, ms + 20);
}

function reclip() {
  unclipTimer = 0;
  const now = performance.now();
  let soonest = 0;
  for (const [e, saved] of [...unclipped]) {
    if (saved.until > now) { if (!soonest || saved.until < soonest) soonest = saved.until; continue; }
    unclipped.delete(e);
    if (saved.overflow) e.style.overflow = saved.overflow;
    else e.style.removeProperty('overflow');
    if (e.scrollLeft !== saved.sl) e.scrollLeft = saved.sl;
    if (e.scrollTop !== saved.st) e.scrollTop = saved.st;
  }
  if (soonest) unclipTimer = setTimeout(reclip, Math.max(20, soonest - now) + 20);
}

function currentTilt(node) {
  const v = parseFloat(node.style.getPropertyValue('--tilt'));
  return Number.isFinite(v) ? v : 0;
}

/* ── reconcile ─────────────────────────────────────────────────────────── */

/**
 * @param {object} snapshot  getPlayerView output
 * @param {{expected?:Set<number>, count?:boolean, animate?:boolean}} opts
 * @returns {number} corrections counted this pass
 */
export function reconcile(snapshot, opts = {}) {
  if (!snapshot) return 0;
  const expected = opts.expected || EMPTY;
  // prepare() may already have done the seating for this job; a rebuild is a
  // rebuild whoever ran it, and counting drift across one is meaningless.
  const structural = layout.syncSeats(snapshot, selfId) || structuralPending;
  structuralPending = false;
  const counting = opts.count !== false && !structural;
  const animate = !!opts.animate && !reduceMotion;

  // The two snap paths (reconnect/gap in the choreographer, drainEvents in the
  // harness) both call with count:false + animate:false. Nothing may still be
  // in the air after them, or the next frame animates a game that already
  // moved on. A plain no-event broadcast (count:true) must NOT settle: it
  // arrives mid-flight several times a turn.
  if (opts.count === false && !opts.animate) flight.finishAll();

  let corrections = 0;

  const desired = new Map();     // id -> zoneKey
  const cards = new Map();       // id -> card object
  const cull = new Set();        // in the snapshot but deliberately not rendered
  const order = new Map();       // zoneKey -> [id, ...]

  const put = (zoneKey, card) => {
    if (!card || card.id == null) return;
    desired.set(card.id, zoneKey);
    cards.set(card.id, card);
    let list = order.get(zoneKey);
    if (!list) { list = []; order.set(zoneKey, list); }
    list.push(card.id);
  };

  for (const player of snapshot.players || []) {
    const mine = player.id === selfId;
    if (mine && Array.isArray(player.hand)) {
      for (const card of player.hand) put(layout.zoneKeyFor('hand', player.id), card);
    }
    for (const card of player.bank || []) put(layout.zoneKeyFor('bank', player.id), card);
    for (const color of COLOR_KEYS) {
      for (const card of player.properties?.[color] || []) {
        put(layout.zoneKeyFor('properties', player.id, color), card);
      }
      for (const card of player.upgrades?.[color] || []) {
        put(layout.zoneKeyFor('upgrades', player.id, color), card);
      }
    }
  }

  const discard = snapshot.discardPile || [];
  for (let i = 0; i < discard.length; i++) {
    if (i < DISCARD_VISIBLE) put('discard', discard[i]);
    else if (discard[i]?.id != null) cull.add(discard[i].id);
  }

  // 1. every card the snapshot names goes where the snapshot says
  for (const [id, zoneKey] of desired) {
    const card = cards.get(id);
    let node = getNode(id);
    const isNew = !node;
    if (isNew) node = cardNode(card);
    else refresh(node, card);
    const zone = layout.zoneEl(zoneKey);
    if (!zone) continue;
    if (node.parentElement !== zone) {
      if (animate && expected.has(id)) moveCard(id, zoneKey, { animate: true });
      else { zone.appendChild(node); setRest(node, 0, 0, 0); flight.writeRest(node); }
      if (counting && !expected.has(id)) {
        corrections++;
        metrics.lastCorrections.push(`${isNew ? 'spawn' : 'move'} ${id} → ${zoneKey}`);
      }
    }
    // A card mid-flip is telling the truth on purpose (an opponent's play is
    // face-down until it lands); anything else the snapshot names is face-up.
    if (!flight.isFlipping(node) && !flight.isFlying(node)) flight.setFacing(node, true);
  }

  // 2. anything left over is gone from the game (reshuffled, or out of view)
  for (const id of [...allNodes().keys()]) {
    if (desired.has(id)) continue;
    const silent = cull.has(id) || expected.has(id);
    const node = getNode(id);
    if (node) { flight.cancel(node); hand.forget(node); }
    forgetNode(id);
    if (counting && !silent) {
      corrections++;
      metrics.lastCorrections.push(`remove ${id}`);
    }
  }

  // 3. order, stacking indices, and the rest pose of every zone
  for (const [zoneKey, ids] of order) {
    const zone = layout.zoneEl(zoneKey);
    if (!zone) continue;
    const isHand = zoneKey === 'hand';
    const isDiscard = zoneKey === 'discard';
    const nodes = ids.map(getNode).filter(Boolean);
    // getPlayerView reverses the discard, so ids[0] is the NEWEST card. The
    // pile is absolutely positioned and unlayered, so paint order is DOM order:
    // put the newest last or the top card of the pile is the one you cannot
    // see. It also matches where moveCard's appendChild leaves a fresh discard.
    orderChildren(zone, isDiscard ? nodes.slice().reverse() : nodes);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const value = String(i);
      if (node.style.getPropertyValue('--i') !== value) node.style.setProperty('--i', value);
      if (isDiscard) tilt(node, ids[i], DISCARD_TILT, 1);
      else if (!isHand) { setRest(node, 0, 0, 0); hand.forget(node); }
    }
    if (isHand) hand.layout(nodes, animate);
  }

  // 4. face-down populations: counts, never identities
  syncBacks(layout.zoneEl('deck'), Math.min(snapshot.deckCount || 0, DECK_DEPTH), { lift: DECK_LIFT });
  for (const player of snapshot.players || []) {
    if (player.id === selfId) continue;
    syncBacks(layout.zoneEl(layout.zoneKeyFor('hand', player.id)),
      Math.min(player.handCount || 0, HAND_BACKS), { tilt: 4 });
  }

  // 5. chrome
  setText(document.getElementById('deck-count'), String(snapshot.deckCount ?? 0));
  setText(document.getElementById('discard-count'), String(discard.length));
  for (const player of snapshot.players || []) layout.paintBoard(player, snapshot);
  setClass(document.getElementById('table'), 'deck-empty', (snapshot.deckCount || 0) === 0);

  if (counting && corrections) {
    metrics.drift += corrections;
    if (metrics.lastCorrections.length > 40) metrics.lastCorrections.splice(0, metrics.lastCorrections.length - 40);
  }
  return corrections;
}
