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
  pointer.onGesture({ dragStart, dragMove, dragEnd, dragCancel, longPress });
}

/* ── press → details sheet (§P4.3) ─────────────────────────────────────── */

function longPress(cardId, node) {
  // Reuses the registered details path (ui/prompt.js listens on UI_DETAILS) —
  // there is exactly one details renderer in the client.
  bus.emit(EVENTS.UI_DETAILS, cardId);
  cueAt(CUE_DETAILS, node);
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
    hover: null,
  };

  clearTimeout(node.__dragTimer);
  node.style.transition = 'none';
  node.classList.add('is-dragging', 'is-lifted');
  document.body.classList.add('is-dragging-card');
  setStyle(node, '--fs', String(SCALE));

  for (const t of plan.targets) setAttr(t.el, 'data-droppable', '1');
  cue(CUE_PICKUP, rect.left + rect.width / 2, rect.top + rect.height / 2);
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

/* ── drop resolution ───────────────────────────────────────────────────── */

/**
 * The element under the finger decides, with one forgiving rule: releasing
 * inside a REGION target (rank 1 — "your side of the table", "the centre")
 * that contains precise targets picks the nearest precise one. Dropping a wild
 * roughly on your own board therefore lands it in the closest legal column
 * instead of asking a second question.
 */
function resolve(x, y) {
  if (!live) return null;
  const el = document.elementFromPoint(x, y);
  const hitEl = el && el.closest ? el.closest('[data-droppable="1"]') : null;
  if (!hitEl) return null;
  const hit = live.plan.targets.find(t => t.el === hitEl);
  if (!hit) return null;
  if (hit.rank !== 1) return hit;

  let best = null;
  let bestD = Infinity;
  for (const t of live.plan.targets) {
    if (t.rank === 1 || !hitEl.contains(t.el)) continue;
    const r = t.el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best || hit;
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
  pointer.abortDrag();
  if (live) dragCancel();
  for (const el of qsa('[data-droppable="1"]')) el.removeAttribute('data-droppable');
}
