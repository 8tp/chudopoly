// ui/peek.js — reading a card costs zero taps.
//
// Owner directive (P7 round 1): "I want a good hover state too at least on
// desktop / on mobile if you touch and hold, but it should render the card so
// you can actually view it and read what it does without having to click on it
// and then click on details."
//
// So: hover (desktop) or touch-and-hold (phone) raises a LARGE, fully legible
// rendering of the card with its real rule text and its live context — what
// that rent would charge right now, how far that set has come, where that wild
// can legally go. The peek is transient by construction: it appears while you
// are pointing at the card and it is gone the moment you are not. The details
// SHEET stays, as the deliberate act it always was (tap a table card, or the
// Details control on the strip).
//
// Three hard rules, all of them things a hover layer normally gets wrong:
//   • It never intercepts input. `.peek` is pointer-events:none, so a drag can
//     start from under it and a click passes straight through.
//   • It never covers the thing you are pointing at. placement() flips the card
//     to whichever side of the anchor has room, then clamps to the viewport.
//   • It never strobes. HOVER_IN_MS is an intent delay, so sweeping across a
//     fanned hand shows nothing until you stop on a card.
//
// ── THE FACE ───────────────────────────────────────────────────────────────
// The peek does NOT draw its own card. It deep-clones the live card node built
// by table/cardnode.js and strips the identity + interaction state off the
// clone, so it is literally the shipped renderer at a bigger size and cannot
// drift from it. An SVG card-art system is being built concurrently: call
// `peek.setFaceRenderer(fn)` with `(card) => Element` and it takes over
// completely — that is the whole seam, and nothing else in this file changes.

import { $, el, clear, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { getNode, buildFace } from '../table/cardnode.js';
import { cardName, cardText, kindLabel, opsecFlag } from '../core/cards.js';
import * as sel from '../state/selectors.js';
import { contextRows } from './details.js';

// core/bus.js is architect-owned; these channels are requested in the report.
// Same defensive pattern interact/drag.js already uses for FX_CUE.
const UI_PEEK = EVENTS.UI_PEEK || 'ui:peek';
const UI_PEEK_END = EVENTS.UI_PEEK_END || 'ui:peek_end';

// 140ms: below ~100 a sweep across a fanned hand strobes; above ~200 the peek
// feels like it is lagging the cursor. Out is instant — a delay on the way out
// is the thing that makes hover layers feel sticky.
const HOVER_IN_MS = 140;
const EDGE = 10;                 // px kept between the peek and the viewport

let host = null;
let showing = null;              // card id currently peeked
let inTimer = 0;
let anchorEl = null;
let faceRenderer = null;         // set by setFaceRenderer(); null = clone the live node

/** Swap in a different card-face renderer (the SVG large-tier face).
 *  @param {(card:object)=>Element|null} fn */
export function setFaceRenderer(fn) { faceRenderer = typeof fn === 'function' ? fn : null; }

function container() {
  if (host?.isConnected) return host;
  host = el('div', { class: 'peek', attrs: { 'aria-hidden': 'true' } });
  host.hidden = true;
  ($('app') || document.body).appendChild(host);
  return host;
}

/* ── the face ──────────────────────────────────────────────────────────── */

/** The live node, cloned and de-identified. Never the node itself: it is the
 *  one persistent object for that card id (§0.4) and reparenting it would take
 *  it off the table. */
function faceOf(card) {
  if (faceRenderer) return faceRenderer(card);
  const live = getNode(card.id);
  // A card with no live node is not a card with no face: table/reconcile()
  // forgets every discard past DISCARD_VISIBLE, and ui/discard.js renders those
  // from the same builder. Peeking one used to produce a body with no card at
  // all. Same renderer, so it cannot drift from the table either way.
  if (!live) {
    const fresh = el('div', { class: 'card is-peek', attrs: { 'data-facing': 'up' },
      dataset: { type: card.type || 'unknown' } });
    fresh.appendChild(el('div', { class: 'card-inner' }, [buildFace(card)]));
    const color = card.placedColor || card.color
      || (card.colors && card.colors[0] !== 'any' ? card.colors[0] : null);
    if (color) fresh.setAttribute('data-color', color);
    if (card.action) fresh.setAttribute('data-action-kind', card.action);
    return fresh;
  }
  const copy = live.cloneNode(true);
  copy.removeAttribute('data-card-id');
  copy.removeAttribute('data-targetable');
  copy.removeAttribute('data-droppable');
  copy.removeAttribute('data-payable');
  copy.removeAttribute('tabindex');
  copy.removeAttribute('style');            // --fx/--fy/--tilt/--fs are table poses
  copy.setAttribute('data-facing', 'up');
  copy.className = 'card is-peek';
  for (const node of copy.querySelectorAll('[data-card-id]')) node.removeAttribute('data-card-id');
  return copy;
}

function body(card) {
  const box = el('div', { class: 'peek-body' });
  box.appendChild(el('div', { class: 'peek-kind', text: kindLabel(card) }));
  box.appendChild(el('div', { class: 'peek-name', text: cardName(card) || card.name || '' }));
  box.appendChild(el('p', { class: 'peek-rule', text: cardText(card) }));

  const rows = contextRows(card);
  if (rows.length) {
    const live = el('div', { class: 'dt-rows peek-rows' });
    for (const row of rows) live.appendChild(row);
    box.appendChild(live);
  }

  if (card.type === 'action' || card.type === 'rent') {
    const flag = opsecFlag(card);
    box.appendChild(el('span', { class: `dt-tag is-${flag.kind}`, text: flag.text }));
  }

  // The single most useful sentence a hand card can carry: why you cannot play
  // it. It used to be reachable only by selecting the card and reading a
  // disabled button's tooltip, which a phone has no way to show at all.
  const why = sel.handCard(card.id) ? sel.blockedReason(card) : '';
  if (why) box.appendChild(el('p', { class: 'dt-why', text: why }));
  return box;
}

/* ── placement ─────────────────────────────────────────────────────────── */

/**
 * Put the peek beside its anchor, on whichever side has room, clamped to the
 * viewport. Never over the anchor: the player is pointing at that card and
 * covering it is the one thing a peek must not do.
 */
function place(rect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = host.offsetWidth;
  const h = host.offsetHeight;

  const roomRight = vw - rect.right;
  const roomLeft = rect.left;
  const roomAbove = rect.top;

  let x;
  if (roomRight >= w + EDGE * 2) x = rect.right + EDGE;
  else if (roomLeft >= w + EDGE * 2) x = rect.left - w - EDGE;
  else x = Math.round((vw - w) / 2);           // no side room: centre and go vertical

  let y;
  if (x === rect.right + EDGE || x === rect.left - w - EDGE) {
    y = rect.top + rect.height / 2 - h / 2;    // beside: vertically centred on the card
  } else if (roomAbove >= h + EDGE * 2) {
    y = rect.top - h - EDGE;                   // above the finger — the thumb is below
  } else {
    y = rect.bottom + EDGE;
  }

  host.style.left = `${Math.round(Math.max(EDGE, Math.min(vw - w - EDGE, x)))}px`;
  host.style.top = `${Math.round(Math.max(EDGE, Math.min(vh - h - EDGE, y)))}px`;
}

/* ── show / hide ───────────────────────────────────────────────────────── */

export function show(cardId, node) {
  const card = sel.findCard(cardId) || node?.__card || null;
  if (!card) return false;
  // A face-down card has nothing to read, and showing one would leak the game.
  if (node?.getAttribute('data-facing') === 'down') return false;

  const box = container();
  if (showing === cardId && !box.hidden) { reposition(node); return true; }
  showing = cardId;
  anchorEl = node || null;

  clear(box);
  const face = faceOf(card);
  if (face) box.appendChild(face);
  box.appendChild(body(card));

  box.hidden = false;
  setClass(box, 'is-in', false);
  reposition(node);
  requestAnimationFrame(() => setClass(box, 'is-in', true));
  return true;
}

function reposition(node) {
  const target = node || anchorEl;
  if (!host || host.hidden) return;
  const rect = target?.getBoundingClientRect();
  place(rect && rect.width
    ? rect
    : { left: window.innerWidth / 2, right: window.innerWidth / 2, top: window.innerHeight / 2, bottom: window.innerHeight / 2, width: 0, height: 0 });
}

export function hide() {
  clearTimeout(inTimer);
  inTimer = 0;
  showing = null;
  anchorEl = null;
  if (!host || host.hidden) return;
  setClass(host, 'is-in', false);
  host.hidden = true;
  clear(host);
}

export function isOpen() { return !!showing; }

/* ── wiring ────────────────────────────────────────────────────────────── */

/** `[data-peek-card]` is the identity-free hook: ui/discard.js renders real
 *  card faces that deliberately carry no `data-card-id` (§0.4 — one node per
 *  id), and they must still be readable on hover. */
function cardUnder(target) {
  const el2 = target instanceof Element ? target : null;
  return el2 ? el2.closest('[data-card-id],[data-peek-card]') : null;
}

function peekId(node) {
  return Number(node.getAttribute('data-card-id') ?? node.getAttribute('data-peek-card'));
}

function armHover(node) {
  const id = peekId(node);
  if (!Number.isInteger(id)) return;
  if (showing === id) return;
  clearTimeout(inTimer);
  inTimer = setTimeout(() => { inTimer = 0; show(id, node); }, HOVER_IN_MS);
}

export function mount() {
  // Hover is a pointing-device affordance only (§2 `@media (hover:hover)`); a
  // touch device synthesises mouseover on tap and would flash the peek on every
  // single tap.
  const hoverCapable = window.matchMedia?.('(hover: hover)')?.matches;

  if (hoverCapable) {
    document.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const node = cardUnder(e.target);
      if (!node) { if (showing !== null) hide(); return; }
      armHover(node);
    }, true);

    document.addEventListener('pointerout', (e) => {
      if (e.pointerType === 'touch') return;
      const node = cardUnder(e.target);
      const to = cardUnder(e.relatedTarget);
      if (node && to === node) return;                  // moving within the same card
      if (to) { armHover(to); return; }
      hide();
    }, true);
  }

  // Anything that means "I am doing something now" ends the peek immediately:
  // a press starts a drag or a tap, a scroll moves the anchor out from under it.
  window.addEventListener('pointerdown', () => { if (showing !== null || inTimer) hide(); }, true);
  window.addEventListener('wheel', () => { if (showing !== null) hide(); }, { passive: true });
  window.addEventListener('scroll', () => { if (showing !== null) hide(); }, true);
  window.addEventListener('blur', () => hide());
  window.addEventListener('resize', () => hide());

  // Touch-and-hold, from interact/pointer.js's long-press recogniser. The press
  // hook fires at PEEK_MS with the finger still down; the release ends it.
  bus.on(UI_PEEK, ({ cardId, node }) => show(cardId, node));
  bus.on(UI_PEEK_END, () => hide());

  // A new snapshot can change what the peek is claiming (the rent it would
  // charge, whether the play is still legal), and it can delete the card.
  bus.on(EVENTS.STATE_APPLIED, () => {
    if (showing === null) return;
    if (!sel.findCard(showing)) { hide(); return; }
    const id = showing;
    showing = null;                                     // force a rebuild
    show(id, anchorEl);
  });
  bus.on(EVENTS.STATE_SCREEN, () => hide());
}
