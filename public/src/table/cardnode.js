// table/cardnode.js — persistent card nodes, keyed by card id (§0.4).
//
// A card node is created once and then only ever REPARENTED. Its face is built
// once and cached on the node; the only per-reconcile writes are guarded
// attribute writes (placedColor on a wild, selection flags). Nothing in this
// file writes innerHTML — checkClient greps for it, and a rebuild mid-FLIP
// destroys the node the transform is running on.

import { el, setAttr, setText } from '../core/dom.js';
import { COLORS, kindLabel, isPropertyCard } from '../core/cards.js';
import { stableSpread } from '../core/rng.js';

const nodes = new Map();      // cardId -> element
const backs = [];             // pooled face-down nodes (deck + opponent hands)

export function getNode(id) { return nodes.get(id); }
export function allNodes() { return nodes; }

export function forgetNode(id) {
  const node = nodes.get(id);
  if (node?.parentNode) node.parentNode.removeChild(node);
  nodes.delete(id);
}

export function cardNode(card) {
  if (!card || card.id == null) return null;
  let node = nodes.get(card.id);
  if (!node) {
    node = buildCard(card);
    nodes.set(card.id, node);
  } else {
    refresh(node, card);
  }
  return node;
}

function buildCard(card) {
  const node = el('div', {
    class: 'card',
    attrs: { 'data-card-id': card.id, tabindex: '-1' },
    dataset: { type: card.type || 'unknown' },
  });
  node.__card = card;
  node.appendChild(buildFace(card));
  node.appendChild(el('div', { class: 'card-back' }, [
    el('div', { class: 'card-back-roundel', text: '★' }),
  ]));
  refresh(node, card);
  return node;
}

function buildFace(card) {
  const face = el('div', { class: 'card-face' });
  face.appendChild(el('div', { class: 'card-band', text: kindLabel(card) }));
  face.appendChild(el('div', { class: 'card-name', text: card.name || '' }));
  face.appendChild(el('div', { class: 'card-art' }));

  const foot = el('div', { class: 'card-foot' });
  foot.appendChild(el('span', { class: 'card-ladder', text: ladderText(card) }));
  foot.appendChild(el('span', { class: 'card-coin', text: `${card.value ?? 0}M` }));
  face.appendChild(foot);
  return face;
}

function ladderText(card) {
  if (card.type === 'property') {
    const info = COLORS[card.color];
    return info ? info.rent.join('/') : '';
  }
  if (card.type === 'wild_property') {
    return card.colors?.[0] === 'any' ? 'ANY' : card.colors.map(c => COLORS[c]?.short || c).join('/');
  }
  if (card.type === 'rent') {
    return card.colors?.[0] === 'any' ? 'ANY · 1 PLAYER' : card.colors.map(c => COLORS[c]?.short || c).join('/');
  }
  if (card.type === 'action') return (card.action || '').replace(/_/g, ' ').toUpperCase();
  return '';
}

/** Guarded refresh: a wild's placedColor is the only field that legitimately moves. */
export function refresh(node, card) {
  if (!node || !card) return;
  node.__card = card;
  const color = card.placedColor || card.color || (isPropertyCard(card) ? card.colors?.[0] : null);
  setAttr(node, 'data-color', color && COLORS[color] ? color : null);
  setAttr(node, 'data-action-kind', card.action || null);
  setAttr(node, 'aria-label', `${card.name || 'Card'}, ${card.value ?? 0}M`);
  const band = node.querySelector('.card-band');
  if (band) setText(band, kindLabel(card));
}

/** Deterministic tilt for discard/table scatter — never Math.random (§5). */
export function tilt(node, id, range, salt = 0) {
  const deg = stableSpread(id, range, salt);
  const current = node.style.getPropertyValue('--tilt');
  const next = `${deg.toFixed(2)}deg`;
  if (current !== next) node.style.setProperty('--tilt', next);
}

/* ── Face-down pool ──────────────────────────────────────────────────────
   Deck stack and opponent hands are COUNTS, not identities. Pooling them keeps
   the id-keyed registry honest: a pooled back is never mistaken for a card that
   drifted, because it has no card id to drift with. */

export function takeBack() {
  const node = backs.pop() || el('div', {
    class: 'card card-facedown',
    attrs: { 'data-back': '1', 'aria-hidden': 'true' },
  }, [el('div', { class: 'card-back' }, [el('div', { class: 'card-back-roundel', text: '★' })])]);
  return node;
}

export function releaseBack(node) {
  if (!node) return;
  if (node.parentNode) node.parentNode.removeChild(node);
  node.style.cssText = '';
  if (backs.length < 64) backs.push(node);
}

/** Set a zone's face-down child count to exactly `count`, reusing pooled nodes. */
export function syncBacks(zone, count, tiltRange = 0) {
  if (!zone) return;
  let have = zone.childElementCount;
  while (have > count) { releaseBack(zone.lastElementChild); have--; }
  while (have < count) {
    const back = takeBack();
    zone.appendChild(back);
    have++;
  }
  if (tiltRange > 0) {
    let i = 0;
    for (let child = zone.firstElementChild; child; child = child.nextElementSibling, i++) {
      const deg = (i - (count - 1) / 2) * tiltRange;
      const value = `${deg.toFixed(2)}deg`;
      if (child.style.getPropertyValue('--tilt') !== value) child.style.setProperty('--tilt', value);
      const value2 = String(i);
      if (child.style.getPropertyValue('--i') !== value2) child.style.setProperty('--i', value2);
    }
  }
}
