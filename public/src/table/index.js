// table/index.js — the §5 table API.
//
//   zoneFor(kind, ownerId, color)         → zone element
//   spawnCard(card, zoneKey)              → node, parented to the zone
//   moveCard(id, zoneKey, {animate, ...}) → reparent + FLIP
//   reconcile(snapshot, {expected})       → snapshot wins; count what surprised us
//
// The snapshot is truth and animation is presentation (§10). reconcile()
// therefore never asks how a card got somewhere — it computes where every card
// belongs and puts it there. `driftCount` counts only the corrections the
// choreographer did NOT claim: a nonzero count means the animation told the
// player a different story than the server did.

import { orderChildren, setText, setAttr, setClass, prefersReducedMotion } from '../core/dom.js';
import { COLOR_KEYS } from '../core/cards.js';
import { cardNode, getNode, allNodes, forgetNode, refresh, syncBacks, tilt } from './cardnode.js';
import * as layout from './layout.js';

export const zoneFor = layout.zoneFor;
export const zoneKeyFor = layout.zoneKeyFor;
export const boardEl = layout.boardEl;
export const allBoards = layout.allBoards;

const DECK_DEPTH = 6;         // §5: a real stack, up to 6 back nodes + count
const HAND_BACKS = 9;         // §5: count-accurate to 9, then a counter
const DISCARD_VISIBLE = 4;    // deeper cards are invisible anyway; 50 nodes was 3ms/reconcile
const FLIP_MS = 260;

const EMPTY = new Set();

const metrics = { drift: 0, lastCorrections: [] };
let selfId = null;
let reduceMotion = false;

export function mount(mySeatId) {
  selfId = mySeatId;
  reduceMotion = prefersReducedMotion();
  layout.mount(document.getElementById('table'), mySeatId);
}

export function setSelf(id) { selfId = id; }
export function driftCount() { return metrics.drift; }
export function resetDrift() { metrics.drift = 0; metrics.lastCorrections.length = 0; }
export function lastCorrections() { return metrics.lastCorrections.slice(); }

export function spawnCard(card, zoneKey) {
  const node = cardNode(card);
  if (!node) return null;
  const zone = layout.zoneEl(zoneKey);
  if (zone && node.parentElement !== zone) zone.appendChild(node);
  return node;
}

export function flipCard(id, faceUp) {
  const node = getNode(id);
  if (!node) return false;
  return setAttr(node, 'data-facing', faceUp ? 'up' : 'down');
}

/**
 * Reparent a card into a zone, FLIP-animated.
 * measure → reparent → invert (CSS custom props the base transform reads) →
 * release. The base rule is
 *   transform: translate(var(--fx),var(--fy)) rotate(var(--tilt)) scale(var(--fs))
 * so the resting tilt of a discard card composes with the flight instead of
 * fighting it.
 */
export function moveCard(id, zoneKey, opts = {}) {
  const node = getNode(id);
  const zone = layout.zoneEl(zoneKey);
  if (!node || !zone) return false;
  if (node.parentElement === zone && !opts.force) return false;

  const animate = opts.animate !== false && !reduceMotion;
  const first = animate ? node.getBoundingClientRect() : null;

  zone.appendChild(node);

  if (!first || first.width === 0) return true;
  const last = node.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const scale = last.width > 0 ? first.width / last.width : 1;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.02) return true;

  const duration = Math.min(600, opts.duration || FLIP_MS);
  node.style.transition = 'none';
  node.style.setProperty('--fx', `${dx.toFixed(1)}px`);
  node.style.setProperty('--fy', `${dy.toFixed(1)}px`);
  node.style.setProperty('--fs', scale.toFixed(3));
  node.classList.add('is-flying');
  void node.offsetWidth;                                    // commit the invert
  node.style.transition = `transform ${duration}ms cubic-bezier(.18,1.15,.4,1)`;
  node.style.setProperty('--fx', '0px');
  node.style.setProperty('--fy', '0px');
  node.style.setProperty('--fs', '1');

  clearTimeout(node.__flipTimer);
  node.__flipTimer = setTimeout(() => {
    node.style.transition = '';
    node.classList.remove('is-flying');
  }, duration + 40);
  return true;
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
  const structural = layout.syncSeats(snapshot, selfId);
  const counting = opts.count !== false && !structural;
  const animate = !!opts.animate;
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
      else zone.appendChild(node);
      if (counting && !expected.has(id)) {
        corrections++;
        metrics.lastCorrections.push(`${isNew ? 'spawn' : 'move'} ${id} → ${zoneKey}`);
      }
    }
    setAttr(node, 'data-facing', 'up');
  }

  // 2. anything left over is gone from the game (reshuffled, or out of view)
  for (const id of [...allNodes().keys()]) {
    if (desired.has(id)) continue;
    const silent = cull.has(id) || expected.has(id);
    forgetNode(id);
    if (counting && !silent) {
      corrections++;
      metrics.lastCorrections.push(`remove ${id}`);
    }
  }

  // 3. order + stacking indices inside each zone
  for (const [zoneKey, ids] of order) {
    const zone = layout.zoneEl(zoneKey);
    if (!zone) continue;
    const nodes = ids.map(getNode).filter(Boolean);
    orderChildren(zone, nodes);
    for (let i = 0; i < nodes.length; i++) {
      const value = String(i);
      if (nodes[i].style.getPropertyValue('--i') !== value) nodes[i].style.setProperty('--i', value);
      if (zoneKey === 'discard') tilt(nodes[i], ids[i], 7, 1);
    }
  }

  // 4. face-down populations: counts, never identities
  syncBacks(layout.zoneEl('deck'), Math.min(snapshot.deckCount || 0, DECK_DEPTH));
  for (const player of snapshot.players || []) {
    if (player.id === selfId) continue;
    syncBacks(layout.zoneEl(layout.zoneKeyFor('hand', player.id)), Math.min(player.handCount || 0, HAND_BACKS), 4);
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
