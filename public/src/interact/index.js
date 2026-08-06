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
import * as drag from './drag.js';

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

/**
 * Answer the current `needs` step with a value. The ONE place a pick is
 * recorded — a tap on the table, a drop on the table and (P4) a keyboard
 * activation all arrive here, so there is no second path to the server.
 * @returns {boolean} true when the step was consumed
 */
export function pick(step, value) {
  if (mode.kind !== 'target' || mode.needs[0] !== step) return false;
  switch (step) {
    case 'player':
      if (!value) return false;
      mode.picks.targetId = value;
      break;
    case 'myColor':
    case 'mySet':
    case 'theirSet':
      if (!value) return false;
      mode.picks.targetColor = value;
      break;
    case 'theirCard':
      if (!Number.isInteger(value)) return false;
      mode.picks.targetCardId = value;
      break;
    case 'myCard':
      if (!Number.isInteger(value)) return false;
      mode.picks.myCardId = value;
      break;
    default: return false;
  }
  advance();
  return true;
}

function handleTargetTap(el) {
  const step = mode.needs[0];
  if (!step) return;
  if (step === 'player') { pick(step, el.getAttribute('data-player')); return; }
  if (step === 'myColor' || step === 'mySet' || step === 'theirSet') {
    pick(step, el.getAttribute('data-color'));
    return;
  }
  pick(step, Number(el.getAttribute('data-card-id')));
}

/* ── drag (P4) ─────────────────────────────────────────────────────────── */

/** Boards this card may legally be aimed at — the same filter applyMarks uses. */
function playerEligible(card, player) {
  const action = card?.action;
  if (action === 'inspector_general') return sel.completeSetsOf(player.id).length > 0;
  if (action === 'midnight_requisition' || action === 'chud' || action === 'tdy_orders') {
    return sel.stealableCards(player.id, action).length > 0;
  }
  return true;
}

/** What a press on this card would pick up, or null if it is not draggable. */
export function dragCandidate(cardId) {
  if (mode.kind === 'payment' || mode.kind === 'discard') return null;   // tap-to-toggle owns these
  const inHand = sel.handCard(cardId);
  if (inHand) return sel.canPlay() ? { source: 'hand', card: inHand } : null;
  const mine = sel.myPropertyCard(cardId);
  if (mine && mine.card.type === 'wild_property' && sel.canPlay()
      && sel.moveColors(mine.card, mine.color).length) {
    return { source: 'board', card: mine.card, from: mine.color };
  }
  return null;
}

/**
 * Legal landing places for a dragged card, as elements.
 *   rank 0 — a precise target: a set column, a board, the bank, a card
 *   rank 1 — a region that means "play it": your own board, the table centre.
 * drag.js resolves a release inside a region to the nearest precise target it
 * contains, so a rough drop still lands somewhere the player meant.
 * An empty target list is legal: the card is draggable but nothing it could do
 * is legal right now, and `reason` says why.
 */
export function dragPlan(cardId) {
  const cand = dragCandidate(cardId);
  if (!cand) return null;

  const targets = [];
  const seen = new Set();
  const push = (el, drop, rank = 0) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    targets.push({ el, drop, rank });
  };

  const myBoard = table.boardEl(store.self.id);
  const col = (color) => myBoard?.querySelector(`.propcol[data-color="${color}"]`);
  const card = cand.card;

  if (cand.source === 'board') {
    for (const color of sel.moveColors(card, cand.from)) push(col(color), { kind: 'move', value: color });
    return { source: 'board', card, targets, reason: '' };
  }

  // `reason` is '' only when the card can be PLAYED. Money always has one
  // ("banked, not played") and a blocked action still banks fine, so the bank
  // target is decided separately from playability.
  const reason = sel.blockedReason(card);
  const bankable = !isPropertyCard(card);

  if (!reason && isPropertyCard(card)) {
    for (const color of sel.placementColors(card)) {
      push(col(color), { kind: 'need', step: 'myColor', value: color });
    }
    push(myBoard, { kind: 'play' }, 1);
  } else if (!reason) {
    // action / rent: the centre of the table always means "play it, I will aim
    // on the table"; every precise target answers the FIRST thing it needs.
    const step = (sel.requirementsFor(card) || [])[0];
    if (step === 'player') {
      for (const p of sel.opponents()) {
        if (playerEligible(card, p)) push(table.boardEl(p.id), { kind: 'need', step, value: p.id });
      }
    } else if (step === 'myColor') {
      for (const color of sel.rentColors(card)) push(col(color), { kind: 'need', step, value: color });
    } else if (step === 'mySet') {
      const needsHouse = card.action === 'foc';
      for (const color of sel.myCompleteSets({ needsHouse, needsNoHouse: !needsHouse })) {
        push(col(color), { kind: 'need', step, value: color });
      }
    } else if (step === 'myCard') {
      const me = selfPlayer();
      for (const color of COLOR_KEYS) {
        for (const c of me?.properties?.[color] || []) push(getNode(c.id), { kind: 'need', step, value: c.id });
      }
    }
    push(document.getElementById('table-center'), { kind: 'play' }, 1);
  }

  if (bankable) {
    push(bankEl(), { kind: 'bank' });
    push(myBoard, { kind: 'bank' }, 1);
  }
  return { source: 'hand', card, targets, reason };
}

function bankEl() {
  const zone = table.zoneFor('bank', store.self.id);
  return zone?.closest('.board-bank') || zone;
}

/**
 * A landed drag. Deliberately goes through selectHandCard → play/bank →
 * pick(): the drag is a shortcut for the taps, never a second route to
 * net/send.js.
 * @returns {boolean} true if the machine took it (dispatched, or now targeting)
 */
export function dropCommit(cardId, drop) {
  if (!drop) return false;

  if (drop.kind === 'move') {
    beginMove(cardId);
    return pick('myColor', drop.value);
  }

  // A tap may already have this card selected; selectHandCard would toggle it off.
  if (!(mode.kind === 'strip' && mode.cardId === cardId)) selectHandCard(cardId);
  if (mode.cardId !== cardId) return false;

  if (drop.kind === 'bank') {
    if (isPropertyCard(mode.card)) return false;
    bankSelected();
    return mode.kind === 'idle';
  }

  playSelected();
  if (mode.kind === 'strip') return false;                 // refused, still selected
  if (drop.step) pick(drop.step, drop.value);
  return true;
}

/* ── marks ─────────────────────────────────────────────────────────────── */

function clearMarks() {
  for (const el of qsa('[data-targetable="1"]')) el.removeAttribute('data-targetable');
  for (const el of qsa('[data-payable="1"]')) el.removeAttribute('data-payable');
  for (const el of qsa('.is-picked')) el.classList.remove('is-picked');
  // A card under the finger keeps its lift: applyMarks runs on every snapshot
  // and a mid-drag state broadcast would otherwise drop the card flat.
  for (const el of qsa('.is-lifted')) {
    if (!el.classList.contains('is-dragging')) el.classList.remove('is-lifted');
  }
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
        if (playerEligible(mode.card, p)) mark(table.boardEl(p.id));
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
  drag.mount({ dragPlan, dropCommit, dragCandidate, refreshMarks: applyMarks });
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
  // scooped, the pending action resolved while the sheet was open. A reset here
  // must fall through to the owed check below — a snapshot can BOTH invalidate
  // the old mode and demand payment (fixture jumps, missed broadcasts).
  const syncMode = () => {
    if (mode.kind === 'strip' || mode.kind === 'target') {
      if (mode.intent !== 'move' && mode.cardId != null && !sel.handCard(mode.cardId)) reset();
    }
    if (mode.kind === 'payment' && sel.owedAmount() === 0) reset();
    if (mode.kind === 'discard' && sel.myHand().length <= (store.snapshot?.handLimit || 7)) reset();
    if (mode.kind === 'idle' && sel.owedAmount() > 0) { beginPayment(sel.owedAmount()); return; }
    applyMarks();
  };
  bus.on(EVENTS.STATE_APPLIED, () => { drag.revalidate(); syncMode(); });

  // On a fixture/snap load STATE_APPLIED fires before reconcile has created any
  // card node, so marks (and payment auto-entry) found nothing to act on.
  // Re-sync when the table settles.
  bus.on(EVENTS.CHOREO_IDLE, () => syncMode());
}
