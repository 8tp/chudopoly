// ui/lobby.js — seats, bots, timers, launch, invite link.

import { $, el, clear, setText, setHidden } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import { toast } from './screens.js';

/* ── who you are actually sitting down with (§P7.19) ───────────────────────
 *
 * The lobby offered five bare labels and no way to know what any of them meant.
 * Every line below is read off bot.js: the OPSEC policy in
 * shouldPlayOpsecDecision(), the break-a-final-approach appetite in
 * BREAK_URGENCY, the payment ordering in the selectPaymentCards() switch, and
 * the think-time in DELAYS.
 *
 * The wire value `chud` is the engine's and cannot move, but its LABEL could:
 * "CHUD" collided head-on with THE CHUD CARD, so a player reading "CHUD bot"
 * reasonably concluded it was the bot that plays the CHUD card. It is the
 * chaos personality, so it is labelled that way.
 */
const BOT_LABEL = {
  random: 'RANDOM', conservative: 'CAUTIOUS', neutral: 'NEUTRAL',
  aggressive: 'AGGRESSIVE', chud: 'WILDCARD',
};

const BOT_BLURB = {
  // decideRandom + BREAK_URGENCY.random 0.2 + OPSEC case 'random'.
  random: 'Plays almost anything and blocks almost nothing. Barely reacts to a final '
    + 'approach. The easiest seat at the table.',
  // BREAK_URGENCY 0.85, ARMED_BANK_BIAS 0.9, OPSEC case 'conservative'.
  conservative: 'Banks early, hoards OPSEC for Inspector General and CHUD, and pays with its '
    + 'cheapest cards first. Slow, and hard to break.',
  // BREAK_URGENCY 0.9, OPSEC case 'neutral' (blocks IG, CHUD, Finance Office, rent ≥ 4M).
  neutral: 'The balanced default. Blocks the big hits, waves the small ones through, and '
    + 'builds steadily.',
  // BREAK_URGENCY 1, OPSEC case 'aggressive' (guards only near-complete sets).
  aggressive: 'Attacks first and spends fast. Only guards sets it has nearly finished, so it '
    + 'is the quickest to shoot down a final approach — and the easiest to rob.',
  // DELAYS.chud is the fastest bank; OPSEC case 'chud' blocks small, lets big land;
  // decideChud ends turns early ~20%; discards at random.
  chud: 'Chaos, at speed. Blocks the small stuff, lets the big stuff land, discards at random '
    + 'and sometimes just stops mid-turn. (Nothing to do with THE CHUD CARD.)',
};

/**
 * public/index.html is architect-owned (§1) and ships the five <option> labels;
 * the meaning is added here rather than by editing the shell.
 */
function describeBots() {
  const select = $('bot-mode');
  if (!select) return;
  for (const option of select.options) {
    if (BOT_LABEL[option.value]) option.textContent = BOT_LABEL[option.value];
  }
  let blurb = $('bot-blurb');
  if (!blurb) {
    blurb = el('p', {
      class: 'hint bot-blurb',
      attrs: { id: 'bot-blurb', 'aria-live': 'polite' },
    });
    select.closest('.row')?.after(blurb);
    select.addEventListener('change', () => setText(blurb, BOT_BLURB[select.value] || ''));
  }
  setText(blurb, BOT_BLURB[select.value] || '');
}

function inviteUrl() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = store.room.code ? `?room=${store.room.code}` : '';
  return url.toString();
}

function render() {
  if (store.screen !== 'lobby') return;
  setText($('lobby-code'), store.room.code || '----');

  const host = store.room.hostId === store.self.id;
  setHidden($('lobby-host'), !host);
  if (host) describeBots();
  setText($('lobby-hint'), host
    ? (store.room.players.length < 2 ? 'Add a bot or invite a squadmate — 2 players minimum.' : 'Ready when you are.')
    : 'Waiting for the host to launch…');

  const list = $('lobby-players');
  if (!list) return;
  clear(list);
  for (const player of store.room.players) {
    const row = el('div', { class: 'lobby-row' }, [
      el('span', { class: 'lobby-seat-name', text: player.name }),
      el('span', {
        class: 'lobby-seat-tag',
        text: player.isBot ? `BOT · ${BOT_LABEL[player.botMode] || 'BOT'}`
          : (player.id === store.room.hostId ? 'HOST' : (player.connected ? '' : 'OFFLINE')),
      }),
    ]);
    if (host && player.id !== store.self.id) {
      row.appendChild(el('button', {
        class: 'btn btn-ghost btn-small',
        text: player.isBot ? 'Remove' : 'Kick',
        attrs: {
          'data-action': player.isBot ? 'remove-bot' : 'kick',
          'data-target': player.id,
        },
      }));
    }
    list.appendChild(row);
  }
}

export function mount() {
  pointer.registerActions({
    'add-bot': () => send.addBot($('bot-mode')?.value || 'neutral'),
    'remove-bot': (el2) => send.removeBot(el2.dataset.target),
    'kick': (el2) => send.kick(el2.dataset.target),
    'start-game': () => send.startGame(
      Number($('turn-timeout')?.value || 60),
      Number($('response-timeout')?.value || 30)
    ),
    'copy-invite': async () => {
      const url = inviteUrl();
      try {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      } catch {
        toast(url);
      }
    },
  });

  bus.on(EVENTS.STATE_APPLIED, render);
  bus.on(EVENTS.STATE_SCREEN, render);
}
