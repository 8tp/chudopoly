// interact/drag.js — direct manipulation: the card follows the finger.
//
// This file owns the CHOREOGRAPHY of a drag (lift, drop-target marking,
// hit-testing, spring-back). It owns none of the rules: what may be picked up,
// where it may land and what a landing means all come from the mode machine in
// interact/index.js through the small api passed to mount(). A drop is
// therefore the same code path as a tap — select → play → satisfy a need —
// which is the only way the server ever hears about it (§5).
//
// Transform contract (§P4): while a card is `.is-dragging` this file drives
// --fx/--fy/--fs directly and the motion agent leaves it alone. On release the
// props are left where the finger dropped them, so the choreographer's FLIP
// measures its `first` rect AT THE DROP POINT and the card flies on from there
// instead of teleporting home first.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { setAttr, setStyle, setClass, qsa, prefersReducedMotion } from '../core/dom.js';
import * as table from '../table/index.js';
import * as pointer from './pointer.js';

// The motion agent owns this channel (anim/cues.js) and its payload shape
// {kind, mine, big, at:{x,y}}; the three interaction beats below are not in its
// CUE table yet, and a subscriber that switches on `kind` ignores what it does
// not know. Named by string so this file does not break if EVENTS predates it.
const FX_CUE = EVENTS.FX_CUE || 'fx:cue';
const CUE_PICKUP = 'card_pickup';
const CUE_DENIED = 'denied';        // the §P4 brief names this one
const CUE_DETAILS = 'card_details';
// ui/peek.js listens on these. core/bus.js is architect-owned, so they follow
// the same "string literal until the constant exists" pattern as FX_CUE.
const UI_PEEK = EVENTS.UI_PEEK || 'ui:peek';
const UI_PEEK_END = EVENTS.UI_PEEK_END || 'ui:peek_end';

/** One cue per BEAT — two small allocations, never per frame (§0.8). */
function cue(kind, x, y) {
  bus.emit(FX_CUE, { kind, mine: true, big: false, at: { x: Math.round(x) || 0, y: Math.round(y) || 0 } });
}

function cueAt(kind, el) {
  const r = el ? el.getBoundingClientRect() : null;
  cue(kind, r ? r.left + r.width / 2 : 0, r ? r.top + r.height / 2 : 0);
}

const LIFT_RATIO = 0.62;    // of card height — a 5:7 card at 62% clears an adult thumb
const MOUSE_LIFT = 8;       // a cursor hides nothing; just enough to read as "held"
const SCALE = 1.06;
const SPRING_MS = 200;
const COMMIT_HOLD_MS = 900;  // an accepted drop keeps its offset this long, then
                             // gives up on the server and springs home anyway

let api = null;
let live = null;             // the active drag, or null

export function mount(machineApi) {
  api = machineApi;
  pointer.onGesture({
    press, release, dragStart, dragMove, dragEnd, dragCancel, longPress, longPressEnd,
  });
}

/* ── the ≤1-frame acknowledgement (§P7.2) ──────────────────────────────────
 * Measured before this existed: pointerdown → first feedback of ANY kind was
 * 427ms+ (the click), sfxLog 0, fxLog 0, no class on the node. card_pickup
 * fired only past the 8px slop, so a tap-first player heard it 0 times in a
 * 274-sound game. The press paints and sounds; what the press MEANS is still
 * decided later by the tap/drag split. */
function press(cardId, node) {
  if (!node) return;
  node.classList.add('is-pressed');
  cueAt(CUE_PICKUP, node);
}

function release(cardId, node, info) {
  node?.classList.remove('is-pressed');
  if (info?.phase === 'held') bus.emit(UI_PEEK_END, null);
}

/* ── hold → PEEK (owner directive P7; was: → details sheet, §P4.3) ────────
 *
 * "on mobile if you touch and hold ... it should render the card so you can
 * actually view it and read what it does without having to click on it and
 * then click on details."
 *
 * So the hold is now a PEEK: it appears while the finger is down and it is
 * gone on release. The full details sheet is still reachable, but only as a
 * deliberate act — tapping a table card, or the Details control on the strip. */
function longPress(cardId, node) {
  bus.emit(UI_PEEK, { cardId, node });
  cueAt(CUE_DETAILS, node);
}

function longPressEnd() {
  bus.emit(UI_PEEK_END, null);
}

/* ── drag ──────────────────────────────────────────────────────────────── */

function dragStart(cardId, node, press) {
  if (!api || live) return false;
  const plan = api.dragPlan(cardId);
  if (!plan) return false;                       // not draggable right now

  const rect = node.getBoundingClientRect();
  live = {
    cardId, node, plan,
    lift: press.pointerType === 'touch' ? Math.round(rect.height * LIFT_RATIO) : MOUSE_LIFT,
    // The hand is a fan: every card rests at a NON-ZERO --fx/--fy/--tilt
    // (table/hand.js). A drag is a delta on that pose, never an absolute one,
    // or the card jumps to the fan's centre the moment it is picked up.
    rx: restVar(node, '__rx', '--fx'),
    ry: restVar(node, '__ry', '--fy'),
    snap: press.pointerType === 'touch' ? SNAP_TOUCH : SNAP_MOUSE,
    hover: null,
  };

  clearTimeout(node.__dragTimer);
  node.style.transition = 'none';
  node.classList.add('is-dragging', 'is-lifted');
  document.body.classList.add('is-dragging-card');
  setStyle(node, '--fs', String(SCALE));

  // No pickup cue here: press() already fired it at pointerdown, ~380ms earlier
  // in a real drag. Two cues for one grab read as a stutter.
  // rank 2 is the whole felt — marking it "1" would draw a dashed outline round
  // the entire table, so it is marked and styled separately.
  for (const t of plan.targets) setAttr(t.el, 'data-droppable', t.rank === 2 ? '2' : '1');
  return true;
}

function dragMove(dx, dy, x, y) {
  if (!live) return;
  setStyle(live.node, '--fx', `${Math.round(live.rx + dx)}px`);
  setStyle(live.node, '--fy', `${Math.round(live.ry + dy - live.lift)}px`);
  hover(resolve(x, y));
}

/** The card's rest offset: the motion agent's number if it owns one, else
 *  whatever is on the node right now. */
function restVar(node, prop, cssVar) {
  if (typeof node[prop] === 'number') return node[prop];
  const v = parseFloat(node.style.getPropertyValue(cssVar));
  return Number.isFinite(v) ? v : 0;
}

function dragEnd(x, y) {
  if (!live) return;
  const hit = resolve(x, y);
  const { node, cardId, plan } = live;
  hover(null);
  for (const t of plan.targets) setAttr(t.el, 'data-droppable', null);
  node.classList.remove('is-dragging');
  node.style.transition = '';                  // hand the transform back to the flight engine
  document.body.classList.remove('is-dragging-card');
  live = null;

  const accepted = hit ? api.dropCommit(cardId, hit.drop) : false;
  if (accepted) {
    node.classList.add('is-dropping');
    holdRelease(node, cardId);
    return;                                    // the landing cue belongs to the flight
  }
  springBack(node, cardId, plan.source);
  cue(CUE_DENIED, x, y);
  if (plan.reason) bus.emit(EVENTS.TOAST, plan.reason);
}

function dragCancel() {
  if (!live) return;
  const { node, cardId, plan } = live;
  hover(null);
  for (const t of plan.targets) setAttr(t.el, 'data-droppable', null);
  node.classList.remove('is-dragging');
  node.style.transition = '';                  // hand the transform back to the flight engine
  document.body.classList.remove('is-dragging-card');
  live = null;
  springBack(node, cardId, plan.source);
}

/* ── drop resolution: aim is not the game (owner feedback, P7 round 1) ─────
 *
 * "dragging cards on to the table just feels terrible since its a strip in the
 * middle of the table (at least just on desktop alone)."
 *
 * The old rule was "the element under the pointer decides": a release one pixel
 * outside a `.propcol` — measured 20px tall — or outside the ~64px-tall
 * #table-center strip resolved to null, which meant spring-back plus a refusal
 * for a gesture that was obviously aimed at something. Now:
 *
 *   1. INSIDE a precise target wins outright.
 *   2. INSIDE a REGION (rank 1 — "your side of the table", "the centre") routes
 *      to the nearest precise target that region contains, or means the region.
 *   3. Otherwise the NEAREST precise target within a snap radius wins, measured
 *      edge-to-point, so a near miss still lands.
 *   4. A playable non-property released anywhere else on the felt (rank 2, the
 *      whole #table) just plays and aims on the table, so the neutral drop is
 *      the entire felt instead of a strip.
 *
 * Containment must beat proximity, and that ordering is load-bearing: measured
 * with 3 → 1, a playable action released dead centre on the DISCARD PILE was
 * banked, because the bank happened to sit 100px away and won on distance. You
 * cannot be "near" something you are standing inside.
 *
 * The radius is bigger for a mouse than a finger only because a finger has a
 * 44px contact patch of its own; the effective forgiveness is about the same.
 */
const SNAP_MOUSE = 120;
const SNAP_TOUCH = 90;

/** Distance from a point to a rect: 0 inside, edge distance outside. */
function rectDist(r, x, y) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/** The nearest rank-0 target to (x,y), optionally restricted to a container. */
function nearestPrecise(x, y, within) {
  let best = null;
  let bestD = Infinity;
  for (const t of live.plan.targets) {
    if (t.rank !== 0) continue;
    if (within && !within.contains(t.el)) continue;
    const r = t.el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const d = rectDist(r, x, y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return { best, dist: bestD };
}

function resolve(x, y) {
  if (!live) return null;
  const { best, dist } = nearestPrecise(x, y);

  // 1 — standing inside a precise target.
  if (best && dist === 0) return best;

  // 2 — standing inside a region: route to the nearest precise target it holds.
  const el = document.elementFromPoint(x, y);
  const hitEl = el && el.closest ? el.closest('[data-droppable="1"]') : null;
  const hit = hitEl ? live.plan.targets.find(t => t.el === hitEl) : null;
  if (hit && hit.rank === 0) return hit;
  if (hit) {
    const inside = nearestPrecise(x, y, hit.el);
    return inside.best || hit;
  }

  // 3 — near enough to a precise target that this is obviously what was meant.
  if (best && dist <= live.snap) return best;

  // 4 — the felt itself, for cards whose neutral meaning is "play it".
  const fallback = live.plan.targets.find(t => t.rank === 2);
  if (fallback) {
    const r = fallback.el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return fallback;
  }
  return null;
}

function hover(hit) {
  const el = hit ? hit.el : null;
  if (!live || live.hover === el) return;
  if (live.hover) setClass(live.hover, 'is-drop-hover', false);
  live.hover = el;
  if (el) setClass(el, 'is-drop-hover', true);
}

/* ── landing ───────────────────────────────────────────────────────────── */

/** An accepted drop keeps the card where it was dropped so the choreographer's
 *  FLIP can continue the motion from there. If the server refuses (illegal
 *  actions get {type:'error'} and NO rebroadcast — net/socket.js) nothing would
 *  ever move it back, so the offset is only held for COMMIT_HOLD_MS. */
function holdRelease(node, cardId) {
  if (prefersReducedMotion()) { rest(node); return; }     // §0.9: no flourish to continue
  const parent = node.parentElement;
  clearTimeout(node.__dragTimer);
  node.__dragTimer = setTimeout(() => {
    node.classList.remove('is-dropping');
    if (node.classList.contains('is-flying')) return;     // the FLIP owns it now
    if (node.parentElement !== parent) { rest(node); return; }  // already re-homed, no flight to fake
    springBack(node, cardId, 'hand');
  }, COMMIT_HOLD_MS);
}

function springBack(node, cardId, source) {
  if (!node) return;
  // §P4 contract: the motion agent's table.moveCard(id,'hand',{springBack:true})
  // reads the --fx/--fy this file left on the node and springs it to the card's
  // rest pose in the fan. A wild dragged around my own board never left its
  // column, so that call does not apply to it — the CSS spring below does.
  let handled = false;
  if (source === 'hand') {
    try { handled = table.moveCard(cardId, 'hand', { springBack: true }) === true; } catch { handled = false; }
  }
  if (handled) { watchdog(node); return; }

  node.style.transition = `transform ${SPRING_MS}ms cubic-bezier(.18,1.15,.4,1)`;
  setStyle(node, '--fx', `${homeX(node)}px`);
  setStyle(node, '--fy', `${homeY(node)}px`);
  setStyle(node, '--fs', '1');
  clearTimeout(node.__dragTimer);
  node.__dragTimer = setTimeout(() => rest(node), SPRING_MS + 40);
}

/** Last resort: whatever anyone else did, a card may not stay displaced. */
function watchdog(node) {
  clearTimeout(node.__dragTimer);
  node.__dragTimer = setTimeout(() => {
    if (node.classList.contains('is-flying')) return;
    rest(node);
  }, 500);
}

const homeX = (node) => (typeof node.__rx === 'number' ? Math.round(node.__rx * 10) / 10 : 0);
const homeY = (node) => (typeof node.__ry === 'number' ? Math.round(node.__ry * 10) / 10 : 0);

/** Back to the pose table/ says the card should be in, wherever it now lives. */
function rest(node) {
  node.style.transition = '';
  node.classList.remove('is-lifted', 'is-dropping');
  setStyle(node, '--fs', '1');
  setStyle(node, '--fx', `${homeX(node)}px`);
  setStyle(node, '--fy', `${homeY(node)}px`);
  // A refused drop can leave the card SELECTED (the strip is open on it): the
  // machine, not this file, decides whether it should still read as lifted.
  api?.refreshMarks?.();
}

/** A new snapshot can invalidate a live drag (the card was paid away, the turn
 *  passed, a target scooped). Only cancel when the card really stopped being
 *  draggable — a broadcast per bot turn must not shake the card out of a hand. */
export function revalidate() {
  if (!live || !api) return;
  if (api.dragCandidate(live.cardId)) return;
  const cardId = live.cardId;
  pointer.abortDrag();
  if (live) dragCancel();
  for (const el of qsa('[data-droppable]')) el.removeAttribute('data-droppable');
  // §P7.11: measured `dragging true→false, mode→payment, no toast` — the card
  // left the finger silently. Correct behaviour, unexplained, reads as a bug.
  api.yanked?.(cardId);
}

/** Is a card under the finger right now? Callers use it to tell "the state
 *  broadcast interrupted me" from "I put it down". */
export function holding() { return !!live; }
