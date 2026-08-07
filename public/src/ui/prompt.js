// ui/prompt.js — the one contextual bar above the hand.
//
// It is a bar and not a modal on purpose (§5): every prompt here needs the
// table visible behind it, because the answer is on the table — which card to
// pay with, which board to hit, which set to place on.

import { $, el, clear, setHidden, setText } from '../core/dom.js';
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

function button(text, action, cls = 'btn') {
  return el('button', { class: cls, text, attrs: { 'data-action': action } });
}

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
  return el('span', {
    class: 'prompt-why is-approach',
    text: 'You are on FINAL APPROACH — paying with a card out of a complete set ends it.',
  });
}

function render() {
  const bar = $('prompt');
  if (!bar) return;
  const snap = store.snapshot;
  const kids = [];

  if (snap && sel.iMustRespond() && mode.kind !== 'payment') {
    const pa = snap.pendingAction;
    const entry = sel.myPendingEntry();
    if (pa && entry) {
      if (!sel.acceptMeansSuffer(entry)) {
        // respondToAction(): at an odd depth I am the attacker, and 'accept'
        // means the defender's OPSEC stands — my own card is cancelled.
        kids.push(el('span', {
          class: 'prompt-text',
          text: `${seatName(entry.id)} played OPSEC on your `
            + `${ACTION_TITLE[pa.action] || pa.action}. Letting it stand cancels your card.`,
        }));
        kids.push(button('Let it stand', 'respond-accept', 'btn btn-primary'));
        if (sel.hasOpsec()) kids.push(button('Counter OPSEC', 'respond-opsec', 'btn'));
      } else if (pa.type === 'payment') {
        kids.push(el('span', { class: 'prompt-text', text: describePending(pa) }));
        kids.push(button('Pay', 'begin-payment', 'btn btn-primary'));
        if (sel.hasOpsec()) kids.push(button('OPSEC', 'respond-opsec', 'btn'));
        kids.push(approachWarning());
      } else {
        kids.push(el('span', { class: 'prompt-text', text: describePending(pa) }));
        kids.push(button('Accept', 'respond-accept', 'btn btn-primary'));
        if (sel.hasOpsec()) kids.push(button('OPSEC', 'respond-opsec', 'btn'));
      }
    }
  } else if (mode.kind === 'payment') {
    const total = interact.selectedTotal();
    kids.push(el('span', { class: 'prompt-text', text: `Owed ${mode.amount}M — tap your bank and properties` }));
    kids.push(el('span', { class: `chip total${total >= mode.amount ? ' is-enough' : ''}`, text: `${total}M selected` }));
    kids.push(button('Confirm payment', 'confirm-payment', 'btn btn-primary'));
    if (interact.payableTotal() < mode.amount) {
      kids.push(button('Surrender everything', 'pay-all', 'btn btn-danger'));
    }
    if (sel.hasOpsec()) kids.push(button('OPSEC instead', 'respond-opsec', 'btn'));
    kids.push(approachWarning());
  } else if (mode.kind === 'discard') {
    kids.push(el('span', { class: 'prompt-text', text: `${mode.hint} — ${mode.selected.size}/${mode.excess} chosen` }));
    kids.push(button('Confirm discard', 'confirm-discard', 'btn btn-primary'));
    kids.push(button('Cancel', 'cancel-selection', 'btn btn-ghost'));
  } else if (mode.kind === 'target') {
    kids.push(el('span', { class: 'prompt-text', text: mode.hint }));
    kids.push(button('Cancel', 'cancel-targeting', 'btn btn-ghost'));
  } else if (mode.kind === 'strip' && mode.card) {
    const card = mode.card;
    const bankable = card.type !== 'property' && card.type !== 'wild_property';
    const playable = card.type !== 'money';       // money has exactly one move
    const reason = playable ? sel.blockedReason(card) : '';
    kids.push(el('span', { class: 'prompt-text', text: cardName(card) }));
    if (playable) {
      const play = button('Play', 'play-card', 'btn btn-primary');
      if (reason) { play.disabled = true; play.title = reason; }
      kids.push(play);
    }
    if (bankable) kids.push(button(`Bank ${card.value}M`, 'bank-card', playable ? 'btn' : 'btn btn-primary'));
    kids.push(button('Details', 'card-details', 'btn'));
    kids.push(button('Cancel', 'cancel-selection', 'btn btn-ghost'));
    if (reason) kids.push(el('span', { class: 'prompt-why', text: reason }));
  } else if (snap && snap.phase === 'playing' && sel.canDraw()) {
    kids.push(el('span', { class: 'prompt-text', text: 'Draw to start your turn' }));
    kids.push(button('Draw', 'draw', 'btn btn-primary'));
  }

  const items = kids.filter(Boolean);
  if (!items.length) { setHidden(bar, true); clear(bar); return; }
  clear(bar);
  for (const kid of items) bar.appendChild(kid);
  setHidden(bar, false);
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
