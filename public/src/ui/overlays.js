// ui/overlays.js — win screen and the help sheet.
//
// The help copy is a P6 placeholder, but it already states every rule §3
// changed, because §3.9 forbids a rule existing that help does not state.

import { $, el, clear, setText, setHidden } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store, seatName } from '../state/store.js';
import { COLORS, COLOR_KEYS, HAND_LIMIT, SETS_TO_WIN } from '../core/cards.js';
import * as pointer from '../interact/pointer.js';
import { openSheet, closeSheet } from './screens.js';

const END_REASON = {
  sets: 'Three complete sets.',
  stalemate: 'Deck and discard ran dry — most sets, then net worth.',
  last_standing: 'Everyone else scooped.',
};

function renderWin() {
  const overlay = $('win-overlay');
  const snap = store.snapshot;
  if (!overlay) return;
  if (!snap || snap.phase !== 'finished') { setHidden(overlay, true); return; }

  const winner = snap.winner;
  setText($('win-title'), winner
    ? (winner === store.self.id ? 'MISSION ACCOMPLISHED' : `${seatName(winner)} WINS`)
    : 'NO WINNER');
  setText($('win-reason'), END_REASON[snap.endReason] || '');

  const summary = $('win-summary');
  clear(summary);
  const ranked = [...snap.players].sort((a, b) =>
    (b.completedSets - a.completedSets) || (b.netWorth - a.netWorth));
  for (const player of ranked) {
    summary.appendChild(el('div', { class: 'win-row' }, [
      el('span', { class: 'win-name', text: player.name }),
      el('span', { text: `${player.completedSets} sets` }),
      el('span', { text: `${player.netWorth}M net` }),
    ]));
  }
  const stats = snap.stats;
  if (stats) {
    summary.appendChild(el('div', {
      class: 'win-stats',
      text: `${stats.turns} turns · ${stats.payments.count} payments · biggest ${stats.payments.biggest}M`,
    }));
  }
  $('btn-rematch').disabled = store.room.hostId !== store.self.id;
  setHidden(overlay, false);
}

function helpBody() {
  const box = el('div', { class: 'help' });
  const section = (title, lines) => {
    box.appendChild(el('h4', { text: title }));
    const list = el('ul');
    for (const line of lines) list.appendChild(el('li', { text: line }));
    box.appendChild(list);
  };

  section('Winning', [
    `Complete ${SETS_TO_WIN} property sets and you win — including on someone else's turn, the moment a payment or steal completes your third set.`,
    'If the deck and the discard both run dry and a full round passes with nobody playing a card from hand, the game ends: most completed sets wins, net worth breaks the tie.',
  ]);
  section('Your turn', [
    'Draw 2 (or 5 if your hand is empty), then make up to 3 plays.',
    'A play is: bank a card for its value, place a property, or play an action.',
    `End your turn with at most ${HAND_LIMIT} cards — discard the excess.`,
    'Wild properties can be moved between your own sets for free, as often as you like, on your turn.',
  ]);
  section('Rent and demands', [
    'Rent is charged on a colour you own — you do NOT need the complete set. More cards of that colour means more rent.',
    'A wild ("any") rent card charges ONE player you choose. Colour rent cards charge everybody.',
    'Surge Operations doubles the next charge you make this turn — rent, Finance Office, Roll Call, any demand. It still costs a play.',
    'You pay with bank cards and properties. Upgrades (Upgrade / FOC) can never be handed over as payment, but they still count in your net worth.',
    'If a payment is short, you must surrender every card you own — zero-value wilds included.',
  ]);
  section('OPSEC', [
    'OPSEC cancels any action played against you. The attacker can counter with their own OPSEC, and so on — the chain resolves from the top.',
    'Accepting while an OPSEC stands means the action is blocked.',
  ]);
  section('The special cards', [
    'THE CHUD CARD steals ANY property, even out of a complete set. It has no tax rider. OPSEC blocks it.',
    'Inspector General seizes a whole complete set. Midnight Requisition takes a single loose property — never out of a complete set.',
    'TDY Orders swaps one of your properties for one of theirs.',
    'A colour zone holds at most its set size — extra copies must go somewhere else legal or stay in hand.',
  ]);
  section('Set sizes and rent ladders', COLOR_KEYS.map((color) => {
    const info = COLORS[color];
    return `${info.name}: ${info.size} cards · rent ${info.rent.join(' / ')}M (+3 Upgrade, +4 FOC)`;
  }));
  section('Scoop', [
    'Scooping discards everything you own and takes you out of the game. If everyone else scoops, the last player standing wins.',
  ]);
  return box;
}

export function showHelp() { openSheet('How to play', helpBody()); }

export function mount() {
  pointer.registerActions({
    help: () => showHelp(),
    rematch: () => send.rematch(),
    'leave-room': () => {
      send.leaveRoom();
      closeSheet();
      setHidden($('win-overlay'), true);
      location.href = location.pathname;
    },
  });
  bus.on(EVENTS.STATE_APPLIED, renderWin);
  if (location.hash === '#help') queueMicrotask(showHelp);
}
