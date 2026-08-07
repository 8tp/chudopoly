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
import { setAttr, setClass, qsa, prefersReducedMotion } from '../core/dom.js';
import * as send from '../net/send.js';
import { store, selfPlayer, playerById } from '../state/store.js';
import * as sel from '../state/selectors.js';
import * as table from '../table/index.js';
import { getNode } from '../table/cardnode.js';
import { isPropertyCard, COLOR_KEYS } from '../core/cards.js';
import * as pointer from './pointer.js';
import * as drag from './drag.js';
import { CUE, cueEl } from '../anim/cues.js';

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

/* ── refusal (§5 "invalid targets shake their head", §P7.3) ────────────────
 *
 * Before this existed, the ONLY refusal the client could express was
 * `<button disabled title="…">`: a measured full game produced 0 `denied`
 * sounds because CUE.DENIED fired from exactly one place (a failed drag-drop).
 * Every "no" now goes through here, so a refusal is a shake + the sour cue +
 * the haptic + the sentence, wherever it was asked for.
 *
 * @param {string} reason  the sentence — never empty, never a bare "invalid"
 * @param {Element|null} el  what to shake; the card node when nothing better
 */
export function refuse(reason, el) {
  const node = el || (mode.cardId != null ? getNode(mode.cardId) : null);
  shakeHead(node);
  cueEl(CUE.DENIED, true, false, node);
  if (reason) bus.emit(EVENTS.TOAST, reason);
}

/** One class, self-cleaning. Re-triggering mid-shake restarts it (a second
 *  refusal must be visible, not swallowed by the running animation). */
export function shakeHead(el) {
  if (!el) return;
  el.classList.remove('is-refused');
  void el.offsetWidth;                       // one forced reflow per refusal beat
  el.classList.add('is-refused');
  clearTimeout(el.__refuseTimer);
  el.__refuseTimer = setTimeout(() => el.classList.remove('is-refused'), 420);
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
  if (reason) { refuse(reason); return; }

  if (isPropertyCard(card)) {
    mode.intent = 'property';
    if (card.type === 'property') return dispatch();
    const colors = sel.placementColors(card);
    if (colors.length === 1) { mode.picks.targetColor = colors[0]; return dispatch(); }
    mode.needs = ['myColor'];
  } else if (card.type === 'action' || card.type === 'rent') {
    mode.intent = 'action';
    const needs = sel.requirementsFor(card);
    if (!needs) { refuse('That card cannot be played now'); return; }
    mode.needs = needs;
  } else {
    refuse('Money cards are banked, not played');
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
  if (isPropertyCard(card)) { refuse('Properties cannot be banked'); return; }
  if (!sel.canPlay()) { refuse(sel.cannotPlayReason()); return; }
  const index = sel.handIndexOf(card.id);
  if (index < 0) return;
  send.playMoney(index);
  reset();
}

/**
 * Free rearrange — begins from a card already on my board.
 * §3.8 for a wild; §3.1b for an Upgrade/FOC, which game.js moveProperty()
 * (1543-1548) routes to moveUpgrade() off the same `move_property` command and
 * which likewise costs no play.
 */
export function beginMove(cardId) {
  const found = sel.boardMoveTarget(cardId);
  if (!found) return;
  if (!sel.canPlay()) { refuse(sel.cannotPlayReason(), getNode(cardId)); return; }
  if (!found.colors.length) {
    refuse(found.isUpgrade
      ? 'Nowhere legal to move it — you need a second complete set that has room for it'
      : 'Nowhere legal to move it — every other set is full', getNode(cardId));
    return;
  }
  mode.kind = 'target';
  mode.intent = 'move';
  mode.cardId = cardId;
  mode.card = found.card;
  mode.needs = ['myColor'];
  mode.picks = {};
  mode.hint = found.isUpgrade
    ? 'Tap the complete set to move it onto'
    : 'Tap the set column to move it to';
  changed();
}

export function beginPayment(amount) {
  mode.kind = 'payment';
  mode.amount = amount || sel.owedAmount();
  mode.selected = new Set();
  mode.hint = `Select at least ${mode.amount}M to pay`;
  changed();
}

/* ── the end-of-turn discard (§P8, owner: "make it obviously easy") ─────────
 *
 * Before: beginDiscard set a mode, hand cards toggled, a Confirm button
 * appeared. Nothing said how many had to go, nothing said how many were chosen,
 * the confirm looked identical whether it would work or refuse, and there was
 * no default — every discard was N taps of arithmetic at the end of a turn.
 *
 * Now: the count is stated and live (ui/prompt.js), the confirm carries its own
 * refusal (§P7.3 — never `disabled`, always a sentence + shake + cue), the
 * chosen cards read as LEAVING rather than merely picked (`is-discarding`), and
 * one tap fills a sensible default the player can then adjust.
 */
export function beginDiscard(excess) {
  mode.kind = 'discard';
  mode.excess = excess;
  mode.selected = new Set();
  mode.hint = `Discard ${excess} card${excess === 1 ? '' : 's'} to reach the hand limit`;
  changed();
}

/**
 * "Discard my cheapest N" — the one-tap default.
 *
 * Face value ascending is the obvious rule and it is wrong on its own: the
 * `any` wild is 0M and is the single most valuable card in the deck, so a pure
 * value sort would offer it up first every time. So cards split into two bands
 * and the PROTECTED band is only touched when the unprotected one runs out:
 *   protected — properties and wilds (they are how you win) and OPSEC (it is
 *               the only card that answers an attack on someone else's turn)
 *   the rest  — money, rent, every other action: cheapest first
 * Within a band, ties break toward the card with the least reach (a rent card
 * for colours you do not own goes before one you can charge with).
 * It is a SUGGESTION: it fills the selection, and every card stays toggleable.
 */
export function suggestDiscard() {
  if (mode.kind !== 'discard') return;
  const protectedCard = (c) =>
    isPropertyCard(c) || (c.type === 'action' && c.action === 'opsec');
  const reach = (c) => (c.type === 'rent' ? sel.rentColors(c).length : 1);
  const ranked = sel.myHand().slice().sort((a, b) =>
    (protectedCard(a) ? 1 : 0) - (protectedCard(b) ? 1 : 0)
    || (a.value || 0) - (b.value || 0)
    || reach(a) - reach(b)
    || a.id - b.id);
  mode.selected = new Set(ranked.slice(0, mode.excess).map(c => c.id));
  changed();
}

/** The sentence the confirm refuses with, or '' when it will go through. */
export function discardBlockedReason() {
  const need = mode.excess;
  const have = mode.selected.size;
  if (have === need) return '';
  if (have < need) {
    const short = need - have;
    return `Choose ${short} more card${short === 1 ? '' : 's'} — ${have} of ${need} picked.`;
  }
  const over = have - need;
  return `That is ${over} too many — the engine takes exactly ${need}. Tap ${over} back.`;
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
  const bar = document.getElementById('prompt');
  if (!ids.length && payable.length) {
    refuse('Tap your bank, property and Upgrade cards to choose what to hand over', bar);
    return;
  }
  if (selectedTotal() < mode.amount && ids.length < payable.length) {
    refuse(`${selectedTotal()}M is short of ${mode.amount}M — add cards, or surrender everything`, bar);
    return;
  }
  send.respond('accept', ids);
  reset();
}

export function confirmDiscard() {
  if (mode.kind !== 'discard') return;
  const why = discardBlockedReason();
  if (why) {
    // §P7.3: the button is never `disabled`, so the refusal can shake, sound
    // and say what is wrong instead of being a dead control.
    refuse(why, document.querySelector('[data-action="confirm-discard"]')
      || document.getElementById('prompt'));
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
    refuse('That card left your hand before the play landed');
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
  // A wild (§3.8) or an Upgrade/FOC (§3.1b) already on my board — both are
  // free rearranges over the same command.
  const mine = sel.boardMoveTarget(cardId);
  if (mine && sel.canPlay() && mine.colors.length) {
    return { source: 'board', card: mine.card, from: mine.from };
  }
  return null;
}

/**
 * Legal landing places for a dragged card, as elements.
 *   rank 0 — a precise target: a set column, a board, the bank, a card
 *   rank 1 — a region that means "play it": your own board, the table centre.
 *   rank 2 — the whole felt, as the LAST resort, for cards whose neutral
 *            meaning is unambiguous ("play it and I will aim on the table").
 * drag.js resolves a release to the nearest rank-0 target within a snap radius
 * first, then to a region's nearest precise child, then to rank 2 — so a rough
 * drop still lands somewhere the player meant (owner feedback: aiming at a
 * 20px column strip "feels terrible").
 * An empty target list is legal: the card is draggable but nothing it could do
 * is legal right now, and `reason` says why.
 * `myBoard` rides along so interact/drag.js can mark the columns that are NOT
 * targets as illegal (ART §5.1) without re-deriving the seat.
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
    for (const color of sel.boardMoveTarget(cardId)?.colors || []) {
      push(col(color), { kind: 'move', value: color });
    }
    return { source: 'board', card, targets, reason: '', myBoard };
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
      // 'myCard' is TDY Orders only, and §3.1 now guards MY side of the trade
      // too (game.js playAction 'tdy_orders': zoneRequisitionable(p, mine.color)
      // → "You cannot trade a card out of one of your complete sets"). Glowing
      // a complete-set card here promised a move the engine refuses.
      for (const { card: c } of sel.tradeableProps()) {
        push(getNode(c.id), { kind: 'need', step, value: c.id });
      }
    }
    push(document.getElementById('table-center'), { kind: 'play' }, 1);
    // The neutral "play it" target is the FELT, not the 64px-tall deck strip.
    push(document.getElementById('table'), { kind: 'play' }, 2);
  }

  if (bankable) {
    push(bankEl(), { kind: 'bank' });
    push(myBoard, { kind: 'bank' }, 1);
  }
  return { source: 'hand', card, targets, reason, myBoard };
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
  for (const el of qsa('[data-payable="1"]')) {
    el.removeAttribute('data-payable');
    // cardnode.js parks every card at tabindex -1; selection modes are the only
    // time a card is a control in its own right, so the reach is lent, not kept.
    if (el.getAttribute('tabindex') === '0') el.setAttribute('tabindex', '-1');
  }
  for (const el of qsa('.is-picked')) el.classList.remove('is-picked');
  for (const el of qsa('.is-discarding')) el.classList.remove('is-discarding');
  // A card under the finger keeps its lift: applyMarks runs on every snapshot
  // and a mid-drag state broadcast would otherwise drop the card flat.
  for (const el of qsa('.is-lifted')) {
    if (!el.classList.contains('is-dragging')) el.classList.remove('is-lifted');
  }
}

function mark(el) { if (el) setAttr(el, 'data-targetable', '1'); }

/* ── lending a card node keyboard focus (§0.9) ─────────────────────────────
 * table/cardnode.js parks every card at tabindex -1. Selection modes are the
 * only time a card is a control in its own right, so the reach is lent for the
 * mode and taken back in clearMarks().
 *
 * MEASURED: lending it unconditionally turned tools/touchtest.mjs's tap-target
 * scan red — a payment surface promoted 25×53 and 38×53 bank cards to controls
 * (§0.9 floor is 44), and landscape promoted 31×45 property cards. A card that
 * is too small to be a tap target must not become one by being focusable, so
 * the promotion is gated on the box the player would actually have to hit.
 * The hand cards the discard flow needs are 58px+ on a 390px phone and always
 * qualify. REQUEST to the table agent: `.zone-bank` cards expose a 23–25px
 * strip at the -0.35em overlap and `.opponents`/landscape `.propcol` cards run
 * to 31px — until those clear 44, payment selection has no keyboard route.
 */
const TAP_FLOOR = 44;

function lendFocus(node) {
  if (!node) return;
  const r = node.getBoundingClientRect();
  if (Math.min(r.width, r.height) >= TAP_FLOOR) setAttr(node, 'tabindex', '0');
}

function markPropColumns(ownerId, colors) {
  const board = table.boardEl(ownerId);
  if (!board) return;
  for (const color of colors) mark(board.querySelector(`.propcol[data-color="${color}"]`));
}

/* ── a target you cannot see is not a target (§P9 FEEL round 3, landscape) ──
 *
 * MEASURED on 844×390: `#opponents` is a 97px rail with 77% of its content
 * scrolled out of view, and picking a steal target marks boards whose CENTRE is
 * outside it. Three real taps aimed at a marked board sent nothing — correctly,
 * because the point tapped was not on the board — and the only recovery was
 * three blind flicks along a 97px rail with no indication of which way to go.
 * Nothing in the client called scrollIntoView when targeting armed.
 *
 * So arming a step brings its targets to the player. Two rules keep it from
 * being a nuisance:
 *   • it fires on a STEP CHANGE, never on a redraw — applyMarks() runs on every
 *     broadcast, and a rail that re-centres itself under the thumb once per bot
 *     turn is worse than one that never moves;
 *   • it does nothing when a target is already reachable (≥60% of one marked
 *     box on screen). The common case — a 3-player desktop table where every
 *     board is visible — never scrolls at all.
 * `block:'nearest'` so the horizontal rail moves and the page does not.
 */
let revealKey = '';

function visibleEnough(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const x = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
  const y = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
  return (x * y) / (r.width * r.height) >= 0.6;
}

function revealMarks(key) {
  if (key === revealKey) return;
  revealKey = key;
  if (!key) return;
  // qsa() returns a raw NodeList (core/dom.js), which has forEach but NOT some —
  // this threw `marks.some is not a function` on every desktop and phone run,
  // and went unnoticed because the two gates that would have caught it were red
  // for unrelated layout reasons.
  const marks = [...qsa('[data-targetable="1"]')];
  if (!marks.length || marks.some(visibleEnough)) return;
  try {
    marks[0].scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  } catch { marks[0].scrollIntoView(false); }
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
      // Same §3.1 guard as dragPlan(): my side of a TDY trade cannot come out
      // of one of my own complete sets.
      for (const { card } of sel.tradeableProps()) mark(getNode(card.id));
    } else if (step === 'mySet') {
      const needsHouse = mode.card?.action === 'foc';
      markPropColumns(store.self.id, sel.myCompleteSets({ needsHouse, needsNoHouse: !needsHouse }));
    } else if (step === 'myColor') {
      const colors = mode.intent === 'move'
        ? (sel.boardMoveTarget(mode.cardId)?.colors || [])
        : (mode.card?.type === 'rent' ? sel.rentColors(mode.card) : sel.placementColors(mode.card));
      markPropColumns(store.self.id, colors);
    }
  }

  if (mode.kind === 'payment') {
    for (const card of sel.payableCards()) {
      const node = getNode(card.id);
      if (!node) continue;
      setAttr(node, 'data-payable', '1');
      lendFocus(node);
      setClass(node, 'is-picked', mode.selected.has(card.id));
    }
  }

  if (mode.kind === 'discard') {
    for (const card of sel.myHand()) {
      const node = getNode(card.id);
      if (!node) continue;
      const picked = mode.selected.has(card.id);
      setAttr(node, 'data-payable', '1');
      lendFocus(node);
      setClass(node, 'is-picked', picked);
      // A payment selection and a discard selection are different promises: one
      // buys you out of a demand, the other throws the card away. They must not
      // look the same (interact.css `.card.is-discarding`).
      setClass(node, 'is-discarding', picked);
    }
  }

  revealMarks(mode.kind === 'target'
    ? `${mode.needs[0] || ''}:${mode.cardId ?? ''}:${mode.picks.targetId ?? ''}`
    : '');
}

/* ── wiring ────────────────────────────────────────────────────────────── */

let explained = false;                 // one interruption sentence per broadcast

/** A live drag/selection that a server broadcast just invalidated (§P7.11). */
function yanked(cardId) {
  explained = true;
  refuse(`${interruptedBy()} — your card is back in your hand.`, getNode(cardId));
}

function interruptedBy() {
  const owed = sel.owedAmount();
  if (owed > 0) {
    const pa = store.snapshot?.pendingAction;
    const who = playerById(pa?.sourceId)?.name;
    return `${who || 'Someone'} charges you ${owed}M`;
  }
  return sel.cannotPlayReason();
}

export function mount() {
  drag.mount({ dragPlan, dropCommit, dragCandidate, refreshMarks: applyMarks, yanked });
  pointer.onEscape(() => cancel());
  pointer.onTargetTap((el) => handleTargetTap(el));
  pointer.onCardTap((id, node) => {
    if (mode.kind === 'payment' || mode.kind === 'discard') {
      if (node.getAttribute('data-payable') === '1') toggleSelected(id);
      return;
    }
    if (sel.handCard(id)) { selectHandCard(id); return; }
    // A wild or an Upgrade/FOC on my own board: tapping it begins the free
    // rearrange rather than opening the details sheet. A wild always claims the
    // tap so beginMove() can SAY why it cannot move (§P7.3); an Upgrade only
    // claims it when it has somewhere to go — most of the time it does not, and
    // a refusal there would just be a wall in front of the rules card.
    const movable = sel.boardMoveTarget(id);
    if (movable && sel.canPlay() && (!movable.isUpgrade || movable.colors.length)) {
      beginMove(id);
      return;
    }
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
    // "I was holding something and the table took it away." Captured BEFORE the
    // mode is rewritten, because that is the only moment the difference between
    // "I put it down" and "it was taken" still exists (§P7.11).
    const wasBusy = mode.kind === 'strip' || mode.kind === 'target';
    if (mode.kind === 'strip' || mode.kind === 'target') {
      if (mode.intent !== 'move' && mode.cardId != null && !sel.handCard(mode.cardId)) reset();
    }
    if (mode.kind === 'payment' && sel.owedAmount() === 0) reset();
    if (mode.kind === 'discard' && sel.myHand().length <= (store.snapshot?.handLimit || 7)) reset();
    if (mode.kind === 'idle' && sel.owedAmount() > 0) {
      const held = wasBusy && !explained;
      beginPayment(sel.owedAmount());
      if (held) bus.emit(EVENTS.TOAST, `${interruptedBy()} — answer that first.`);
      return;
    }
    applyMarks();
  };
  bus.on(EVENTS.STATE_APPLIED, () => { explained = false; drag.revalidate(); syncMode(); });

  // On a fixture/snap load STATE_APPLIED fires before reconcile has created any
  // card node, so marks (and payment auto-entry) found nothing to act on.
  // Re-sync when the table settles.
  bus.on(EVENTS.CHOREO_IDLE, () => syncMode());
}
