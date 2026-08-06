// ui/lobby.js — seats, bots, timers, launch, invite link.

import { $, el, clear, setText, setHidden } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import { toast } from './screens.js';

const BOT_LABEL = {
  random: 'RANDOM', conservative: 'CONSERVATIVE', neutral: 'NEUTRAL',
  aggressive: 'AGGRESSIVE', chud: 'CHUD',
};

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
