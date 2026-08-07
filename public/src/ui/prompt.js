// ui/prompt.js — the one contextual bar above the hand.
//
// It is a bar and not a modal on purpose (§5): every prompt here needs the
// table visible behind it, because the answer is on the table — which card to
// pay with, which board to hit, which set to place on.
//
// P7: the bar is RECONCILED, never rebuilt. Measured before that: selecting
// four payment cards produced prompt node identities 1→2→3→4→5, and
// tools/touchtest.mjs documents the trap in its own comment — a state broadcast
// landing between pointerdown and click detaches the button and the tap is
// eaten by a node that is no longer in the document. Same rule as §0.4's card
// zones, for the same reason.

import { $, el, setHidden, setText, setAttr } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store, seatName } from '../state/store.js';
import * as sel from '../state/selectors.js';
import * as interact from '../interact/index.js';
import { mode } from '../interact/index.js';
import * as pointer from '../interact/pointer.js';
import { colorName, cardName } from '../core/cards.js';
import * as details from './details.js';

const ACTION_TITLE = {
  rent: 'Rent', finance_office: 'Finance Office', roll_call: 'Roll Call',
  midnight_requisition: 'Midnight Requisition', chud: 'THE CHUD CARD',
  inspector_general: 'Inspector General', tdy_orders: 'TDY Orders',
};

/* ── the item vocabulary ───────────────────────────────────────────────────
 * render() returns a list of these; paint() makes the DOM equal to it. A key is
 * stable across renders for the SAME control, which is the whole point. */

const text = (key, str, cls = 'prompt-text') => ({ key, tag: 'span', cls, text: str });
const chip = (key, str, cls) => ({ key, tag: 'span', cls, text: str });
const button = (key, str, action, cls = 'btn', extra = {}) =>
  ({ key, tag: 'button', cls, text: str, action, ...extra });

function describePending(pa) {
  const who = seatName(pa.sourceId);
  const title = ACTION_TITLE[pa.action] || pa.action;
  if (pa.type === 'payment') {
    const on = pa.color ? ` on ${colorName(pa.color)}` : '';
    return `${who} charges ${pa.amount}M — ${title}${on}${pa.doubled ? ' (DOUBLED)' : ''}`;
  }
  if (pa.type === 'steal_set') return `${who} is seizing your ${colorName(pa.color)} set — ${title}`;
  if (pa.type === 'steal_property') return `${who} is taking one of your properties — ${title}`;
  if (pa.type === 'swap') return `${who} wants to swap properties — ${title}`;
  return `${who} plays ${title}`;
}

/**
 * A player on final approach who pays with a property loses the set and is
 * disarmed (processPayment → syncSets(payer)). Worth saying out loud at the one
 * moment it can happen by accident.
 */
function approachWarning() {
  const me = store.snapshot?.players?.find(p => p.id === store.self.id);
  if (!me?.finalApproach) return null;
  return text('approach',
    'You are on FINAL APPROACH — paying with a card out of a complete set ends it.',
    'prompt-why is-approach');
}

/* ── the timer that belongs to the ATTACK, not to the HUD (§5, §P7.7) ──────
 *
 * MEASURED: the respond prompt rendered with #hud-timer hidden, so the one
 * moment §5 demands a ring with urgency — "you are under attack, answer" — had
 * no clock at all. The HUD ring is 2.35em of chrome at the top of a 390px
 * phone; the decision is at the bottom. So the response countdown renders IN
 * the bar that is asking the question, and ui/hud.js's single clock subscriber
 * paints both rings from the same tick (there is only one clock, §0.6).
 */
function timerItem() {
  if (!store.timers.response) return null;
  return { key: 'timer', tag: 'span', cls: 'timer prompt-timer', id: 'prompt-timer', ring: true };
}

function render() {
  const bar = $('prompt');
  if (!bar) return;
  const snap = store.snapshot;
  const items = [];

  // §P7.9 + owner directive: THE DRAW IS GONE FROM THE UI. The engine draws at
  // turn start for every seat (game.js beginTurn, 65e36ef), so `turnPhase` is
  // always broadcast as 'play' and there is nothing for a player to press.
  // Two enabled DRAW buttons 57px apart on every turn start — the measured
  // defect — cannot recur, because neither exists. #btn-draw in the hand bar is
  // suppressed here rather than in ui/hud.js so exactly one module decides.

  if (snap && sel.iMustRespond() && mode.kind !== 'payment') {
    const pa = snap.pendingAction;
    const entry = sel.myPendingEntry();
    if (pa && entry) {
      items.push(timerItem());
      if (!sel.acceptMeansSuffer(entry)) {
        // respondToAction(): at an odd depth I am the attacker, and 'accept'
        // means the defender's OPSEC stands — my own card is cancelled.
        items.push(text('why', `${seatName(entry.id)} played OPSEC on your `
          + `${ACTION_TITLE[pa.action] || pa.action}. Letting it stand cancels your card.`));
        items.push(button('accept', 'Let it stand', 'respond-accept', 'btn btn-primary'));
        if (sel.hasOpsec()) items.push(button('opsec', 'Counter OPSEC', 'respond-opsec'));
      } else if (pa.type === 'payment') {
        items.push(text('why', describePending(pa)));
        items.push(button('pay', 'Pay', 'begin-payment', 'btn btn-primary'));
        if (sel.hasOpsec()) items.push(button('opsec', 'OPSEC', 'respond-opsec'));
        items.push(approachWarning());
      } else {
        items.push(text('why', describePending(pa)));
        items.push(button('accept', 'Accept', 'respond-accept', 'btn btn-primary'));
        if (sel.hasOpsec()) items.push(button('opsec', 'OPSEC', 'respond-opsec'));
      }
    }
  } else if (mode.kind === 'payment') {
    const total = interact.selectedTotal();
    items.push(timerItem());
    items.push(text('why', `Owed ${mode.amount}M — tap your bank and properties`));
    items.push(chip('total', `${total}M selected`,
      `chip total${total >= mode.amount ? ' is-enough' : ''}`));
    items.push(button('confirm', 'Confirm payment', 'confirm-payment', 'btn btn-primary'));
    if (interact.payableTotal() < mode.amount) {
      items.push(button('payall', 'Surrender everything', 'pay-all', 'btn btn-danger'));
    }
    if (sel.hasOpsec()) items.push(button('opsec', 'OPSEC instead', 'respond-opsec'));
    items.push(approachWarning());
  } else if (mode.kind === 'discard') {
    items.push(text('why', `${mode.hint} — ${mode.selected.size}/${mode.excess} chosen`));
    items.push(button('confirm', 'Confirm discard', 'confirm-discard', 'btn btn-primary'));
    items.push(button('cancel', 'Cancel', 'cancel-selection', 'btn btn-ghost'));
  } else if (mode.kind === 'target') {
    items.push(text('why', mode.hint));
    items.push(button('cancel', 'Cancel', 'cancel-targeting', 'btn btn-ghost'));
  } else if (mode.kind === 'strip' && mode.card) {
    const card = mode.card;
    const bankable = card.type !== 'property' && card.type !== 'wild_property';
    const playable = card.type !== 'money';       // money has exactly one move
    const reason = playable ? sel.blockedReason(card) : '';
    items.push(text('why', cardName(card)));
    if (playable) {
      // §P7.3: NOT disabled. A disabled button is the deadest possible refusal —
      // no shake, no cue, no haptic, no sentence. It stays live and refuses out
      // loud through interact.refuse(), so the player learns why.
      items.push(button('play', 'Play', 'play-card',
        `btn btn-primary${reason ? ' is-refusing' : ''}`,
        reason ? { title: reason } : {}));
    }
    if (bankable) {
      items.push(button('bank', `Bank ${card.value}M`, 'bank-card',
        playable ? 'btn' : 'btn btn-primary'));
    }
    items.push(button('details', 'Details', 'card-details'));
    items.push(button('cancel', 'Cancel', 'cancel-selection', 'btn btn-ghost'));
    if (reason) items.push(text('reason', reason, 'prompt-why'));
  }

  const list = items.filter(Boolean);
  setHidden($('btn-draw'), true);

  if (!list.length) { setHidden(bar, true); paint(bar, []); return; }
  paint(bar, list);
  setHidden(bar, false);
}

/* ── reconcile, never rebuild ──────────────────────────────────────────── */

function make(item) {
  const node = document.createElement(item.tag);
  node.dataset.key = item.key;
  if (item.id) node.id = item.id;
  if (item.action) node.dataset.action = item.action;
  if (item.tag === 'button') node.type = 'button';
  if (item.ring) node.appendChild(el('span', { class: 'timer-text', attrs: { id: `${item.id}-text` } }));
  return node;
}

function update(node, item) {
  if (node.className !== item.cls) node.className = item.cls || '';
  // The ring's text is written per tick by ui/hud.js; never clobber it here.
  if (!item.ring) setText(node, item.text ?? '');
  if (item.action && node.dataset.action !== item.action) node.dataset.action = item.action;
  setAttr(node, 'title', item.title || null);
  // Never disabled (§P7.3) — a refusal must be able to speak.
  if (node.tagName === 'BUTTON' && node.disabled) node.disabled = false;
}

/**
 * Make `bar`'s children equal `items`, keeping every node whose key survives.
 * A node that survives keeps its identity, so a tap that started on it before a
 * broadcast still lands on it after.
 */
function paint(bar, items) {
  const have = new Map();
  for (const node of bar.children) if (node.dataset.key) have.set(node.dataset.key, node);

  let cursor = bar.firstChild;
  for (const item of items) {
    const node = have.get(item.key) || make(item);
    update(node, item);
    if (node === cursor) { cursor = cursor.nextSibling; continue; }
    bar.insertBefore(node, cursor);
  }

  const keep = new Set(items.map(i => i.key));
  for (const node of [...bar.children]) if (!keep.has(node.dataset.key)) node.remove();
}

export function mount() {
  pointer.registerActions({
    'respond-accept': () => send.respond('accept'),
    'respond-opsec': () => { send.respond('opsec'); interact.reset(); },
    'begin-payment': () => interact.beginPayment(sel.owedAmount()),
    'pay-all': () => { interact.selectAllPayable(); interact.confirmPayment(); },
    'card-details': () => details.show(mode.card),
  });
  bus.on(EVENTS.UI_DETAILS, (cardId) => details.show(sel.findCard(cardId)));
  bus.on(EVENTS.INTERACT_CHANGED, render);
  bus.on(EVENTS.STATE_APPLIED, render);
}
