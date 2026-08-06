// interact/index.js — the interaction state machine.
//
// One mode at a time, and the mode is data, not DOM state: ui/ renders from it
// and the table marks eligible things from it. §5's rule that targeting happens
// ON THE TABLE (not in a modal) is why picking a target is a `needs` queue
// consumed by taps on boards/columns/cards instead of a dialog per action.
//
// P3 ships tap. The drag path (P4, interaction agent) should push into the same
// machine: begin(card) → needs → dispatch, so nothing else has to change.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { setAttr, setClass, qsa } from '../core/dom.js';
import * as send from '../net/send.js';
import { store, selfPlayer } from '../state/store.js';
import * as sel from '../state/selectors.js';
import * as table from '../table/index.js';
import { getNode } from '../table/cardnode.js';
import { isPropertyCard, COLOR_KEYS } from '../core/cards.js';
import * as pointer from './pointer.js';

export const mode = {
  kind: 'idle',            // idle | strip | target | payment | discard | details
  cardId: null,
  card: null,
  intent: null,            // 'property' | 'action' | 'move'
  needs: [],
  picks: {},
  selected: new Set(),
  amount: 0,
  excess: 0,
  hint: '',
};

const HINTS = {
  player: 'Tap a player board to choose your target',
  theirCard: 'Tap the property you want',
  theirSet: 'Tap the complete set to seize',
  myCard: 'Tap one of your properties to offer',
  mySet: 'Tap one of your complete sets',
  myColor: 'Tap the set column to place it on',
};

function changed() {
  applyMarks();
  bus.emit(EVENTS.INTERACT_CHANGED, mode);
}

export function reset() {
  mode.kind = 'idle';
  mode.cardId = null;
  mode.card = null;
  mode.intent = null;
  mode.needs = [];
  mode.picks = {};
  mode.selected = new Set();
  mode.amount = 0;
  mode.excess = 0;
  mode.hint = '';
  changed();
}

export function cancel() {
  if (mode.kind === 'payment' || mode.kind === 'discard') {
    mode.selected = new Set();
    changed();
    return;
  }
  reset();
}

/* ── entering modes ────────────────────────────────────────────────────── */

export function selectHandCard(cardId) {
  if (mode.kind === 'discard') { toggleSelected(cardId); return; }
  const card = sel.handCard(cardId);
  if (!card) return;
  if (mode.kind === 'strip' && mode.cardId === cardId) { reset(); return; }
  mode.kind = 'strip';
  mode.cardId = cardId;
  mode.card = card;
  mode.needs = [];
  mode.picks = {};
  mode.hint = '';
  changed();
}

/** "Play" on the action strip. Collects what the engine needs, then fires. */
export function playSelected() {
  const card = mode.card;
  if (!card) return;
  const reason = sel.blockedReason(card);
  if (reason) { bus.emit(EVENTS.TOAST, reason); return; }

  if (isPropertyCard(card)) {
    mode.intent = 'property';
    if (card.type === 'property') return dispatch();
    const colors = sel.placementColors(card);
    if (colors.length === 1) { mode.picks.targetColor = colors[0]; return dispatch(); }
    mode.needs = ['myColor'];
  } else if (card.type === 'action' || card.type === 'rent') {
    mode.intent = 'action';
    const needs = sel.requirementsFor(card);
    if (!needs) { bus.emit(EVENTS.TOAST, 'That card cannot be played now'); return; }
    mode.needs = needs;
  } else {
    bus.emit(EVENTS.TOAST, 'Money cards are banked, not played');
    return;
  }

  if (mode.needs.length === 0) return dispatch();
  mode.kind = 'target';
  mode.hint = HINTS[mode.needs[0]] || 'Choose a target';
  changed();
}

export function bankSelected() {
  const card = mode.card;
  if (!card) return;
  if (isPropertyCard(card)) { bus.emit(EVENTS.TOAST, 'Properties cannot be banked'); return; }
  if (!sel.canPlay()) { bus.emit(EVENTS.TOAST, 'Not your turn to play'); return; }
  const index = sel.handIndexOf(card.id);
  if (index < 0) return;
  send.playMoney(index);
  reset();
}

/** Free wild rearrange (§3.8) — begins from a wild already on my board. */
export function beginMove(cardId) {
  const found = sel.myPropertyCard(cardId);
  if (!found || found.card.type !== 'wild_property') return;
  if (!sel.canPlay()) { bus.emit(EVENTS.TOAST, 'You can only rearrange on your own turn'); return; }
  const colors = sel.moveColors(found.card, found.color);
  if (!colors.length) { bus.emit(EVENTS.TOAST, 'Nowhere legal to move it'); return; }
  mode.kind = 'target';
  mode.intent = 'move';
  mode.cardId = cardId;
  mode.card = found.card;
  mode.needs = ['myColor'];
  mode.picks = {};
  mode.hint = 'Tap the set column to move it to';
  changed();
}

export function beginPayment(amount) {
  mode.kind = 'payment';
  mode.amount = amount || sel.owedAmount();
  mode.selected = new Set();
  mode.hint = `Select at least ${mode.amount}M to pay`;
  changed();
}

export function beginDiscard(excess) {
  mode.kind = 'discard';
  mode.excess = excess;
  mode.selected = new Set();
  mode.hint = `Discard ${excess} card${excess === 1 ? '' : 's'} to reach the hand limit`;
  changed();
}

/* ── selection ─────────────────────────────────────────────────────────── */

export function toggleSelected(cardId) {
  if (mode.selected.has(cardId)) mode.selected.delete(cardId);
  else mode.selected.add(cardId);
  changed();
}

/** "I cannot cover this" — the engine's only legal short payment is everything. */
export function selectAllPayable() {
  mode.selected = new Set(sel.payableCards().map(c => c.id));
  changed();
}

export function payableTotal() {
  let total = 0;
  for (const card of sel.payableCards()) total += card.value || 0;
  return total;
}

export function selectedTotal() {
  const me = selfPlayer();
  if (!me) return 0;
  let total = 0;
  for (const card of sel.payableCards(me)) if (mode.selected.has(card.id)) total += card.value || 0;
  return total;
}

export function confirmPayment() {
  if (mode.kind !== 'payment') return;
  const ids = [...mode.selected];
  const payable = sel.payableCards();
  if (!ids.length && payable.length) { bus.emit(EVENTS.TOAST, 'Select cards to pay with'); return; }
  if (selectedTotal() < mode.amount && ids.length < payable.length) {
    bus.emit(EVENTS.TOAST, `Pay at least ${mode.amount}M, or surrender everything`);
    return;
  }
  send.respond('accept', ids);
  reset();
}

export function confirmDiscard() {
  if (mode.kind !== 'discard') return;
  if (mode.selected.size !== mode.excess) {
    bus.emit(EVENTS.TOAST, `Select exactly ${mode.excess}`);
    return;
  }
  send.endTurn([...mode.selected]);
  reset();
}

/* ── targeting ─────────────────────────────────────────────────────────── */

function advance() {
  mode.needs.shift();
  if (mode.needs.length === 0) return dispatch();
  mode.hint = HINTS[mode.needs[0]] || 'Choose a target';
  changed();
}

function dispatch() {
  const index = sel.handIndexOf(mode.cardId);
  if (mode.intent === 'move') {
    send.moveProperty(mode.cardId, mode.picks.targetColor);
  } else if (index < 0) {
    bus.emit(EVENTS.TOAST, 'That card is no longer in your hand');
  } else if (mode.intent === 'property') {
    send.playProperty(index, mode.picks.targetColor);
  } else if (mode.intent === 'action') {
    send.playAction(index, mode.picks);
  }
  reset();
}

function handleTargetTap(el) {
  const step = mode.needs[0];
  if (!step) return;
  switch (step) {
    case 'player': {
      const id = el.getAttribute('data-player');
      if (!id) return;
      mode.picks.targetId = id;
      break;
    }
    case 'myColor':
    case 'mySet':
    case 'theirSet': {
      const color = el.getAttribute('data-color');
      if (!color) return;
      mode.picks.targetColor = color;
      break;
    }
    case 'theirCard': {
      const id = Number(el.getAttribute('data-card-id'));
      if (!Number.isInteger(id)) return;
      mode.picks.targetCardId = id;
      break;
    }
    case 'myCard': {
      const id = Number(el.getAttribute('data-card-id'));
      if (!Number.isInteger(id)) return;
      mode.picks.myCardId = id;
      break;
    }
    default: return;
  }
  advance();
}

/* ── marks ─────────────────────────────────────────────────────────────── */

function clearMarks() {
  for (const el of qsa('[data-targetable="1"]')) el.removeAttribute('data-targetable');
  for (const el of qsa('[data-payable="1"]')) el.removeAttribute('data-payable');
  for (const el of qsa('.is-picked')) el.classList.remove('is-picked');
  for (const el of qsa('.is-lifted')) el.classList.remove('is-lifted');
}

function mark(el) { if (el) setAttr(el, 'data-targetable', '1'); }

function markPropColumns(ownerId, colors) {
  const board = table.boardEl(ownerId);
  if (!board) return;
  for (const color of colors) mark(board.querySelector(`.propcol[data-color="${color}"]`));
}

export function applyMarks() {
  clearMarks();
  const snap = store.snapshot;
  if (!snap) return;
  const me = selfPlayer();

  if (mode.kind === 'strip' && mode.cardId != null) {
    const node = getNode(mode.cardId);
    if (node) node.classList.add('is-lifted');
  }

  if (mode.kind === 'target') {
    const step = mode.needs[0];
    if (step === 'player') {
      for (const p of sel.opponents()) {
        if (mode.card?.action === 'inspector_general' && !sel.completeSetsOf(p.id).length) continue;
        if ((mode.card?.action === 'midnight_requisition' || mode.card?.action === 'chud'
             || mode.card?.action === 'tdy_orders')
            && !sel.stealableCards(p.id, mode.card.action).length) continue;
        mark(table.boardEl(p.id));
      }
    } else if (step === 'theirCard') {
      for (const { card } of sel.stealableCards(mode.picks.targetId, mode.card?.action)) {
        mark(getNode(card.id));
      }
    } else if (step === 'theirSet') {
      markPropColumns(mode.picks.targetId, sel.completeSetsOf(mode.picks.targetId));
    } else if (step === 'myCard') {
      for (const color of COLOR_KEYS) for (const card of me?.properties?.[color] || []) mark(getNode(card.id));
    } else if (step === 'mySet') {
      const needsHouse = mode.card?.action === 'foc';
      markPropColumns(store.self.id, sel.myCompleteSets({ needsHouse, needsNoHouse: !needsHouse }));
    } else if (step === 'myColor') {
      const colors = mode.intent === 'move'
        ? sel.moveColors(mode.card, sel.myPropertyCard(mode.cardId)?.color)
        : (mode.card?.type === 'rent' ? sel.rentColors(mode.card) : sel.placementColors(mode.card));
      markPropColumns(store.self.id, colors);
    }
  }

  if (mode.kind === 'payment') {
    for (const card of sel.payableCards()) {
      const node = getNode(card.id);
      if (!node) continue;
      setAttr(node, 'data-payable', '1');
      setClass(node, 'is-picked', mode.selected.has(card.id));
    }
  }

  if (mode.kind === 'discard') {
    for (const card of sel.myHand()) {
      const node = getNode(card.id);
      if (!node) continue;
      setAttr(node, 'data-payable', '1');
      setClass(node, 'is-picked', mode.selected.has(card.id));
    }
  }
}

/* ── wiring ────────────────────────────────────────────────────────────── */

export function mount() {
  pointer.onEscape(() => cancel());
  pointer.onTargetTap((el) => handleTargetTap(el));
  pointer.onCardTap((id, node) => {
    if (mode.kind === 'payment' || mode.kind === 'discard') {
      if (node.getAttribute('data-payable') === '1') toggleSelected(id);
      return;
    }
    if (sel.handCard(id)) { selectHandCard(id); return; }
    const mine = sel.myPropertyCard(id);
    if (mine && mine.card.type === 'wild_property' && sel.canPlay()) { beginMove(id); return; }
    bus.emit(EVENTS.UI_DETAILS, id);
  });

  pointer.registerActions({
    'play-card': () => playSelected(),
    'bank-card': () => bankSelected(),
    'cancel-selection': () => cancel(),
    'cancel-targeting': () => cancel(),
    'confirm-payment': () => confirmPayment(),
    'confirm-discard': () => confirmDiscard(),
  });

  // A new snapshot can invalidate the mode: the card was paid away, the target
  // scooped, the pending action resolved while the sheet was open.
  bus.on(EVENTS.STATE_APPLIED, () => {
    if (mode.kind === 'strip' || mode.kind === 'target') {
      if (mode.intent !== 'move' && mode.cardId != null && !sel.handCard(mode.cardId)) { reset(); return; }
    }
    if (mode.kind === 'payment' && sel.owedAmount() === 0) { reset(); return; }
    if (mode.kind === 'discard' && sel.myHand().length <= (store.snapshot?.handLimit || 7)) { reset(); return; }
    if (mode.kind === 'idle' && sel.owedAmount() > 0) { beginPayment(sel.owedAmount()); return; }
    applyMarks();
  });
}
