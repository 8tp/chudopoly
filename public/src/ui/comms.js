// ui/comms.js — Mission Log, chat, emotes.
//
// XSS discipline from the old client is kept verbatim: chat text and player
// names only ever enter the DOM through textContent (§0.4, §2). There is no
// path in this file that turns a string into markup.

import { $, el, clear, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import * as table from '../table/index.js';

const MAX_CHAT = 50;
let scope = 'room';
let tail = [];

/**
 * getPlayerView sends only the LAST 20 log lines, so "append everything past
 * the count I already rendered" freezes the log the moment the game passes 20
 * lines. Instead: find the longest suffix of what we have rendered that is a
 * prefix of what arrived, and append the remainder.
 */
function renderLog() {
  const box = $('log');
  const lines = store.snapshot?.log || [];
  if (!box) return;
  let start = 0;
  for (let k = Math.min(tail.length, lines.length); k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (tail[tail.length - k + i] !== lines[i]) { match = false; break; }
    }
    if (match) { start = k; break; }
  }
  for (let i = start; i < lines.length; i++) {
    box.appendChild(el('div', { class: 'log-line', text: lines[i] }));
  }
  tail = lines.slice(-20);
  while (box.childElementCount > 80) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function renderChat() {
  const box = $('chat-msgs');
  if (!box) return;
  clear(box);
  for (const msg of store.chat[scope] || []) {
    box.appendChild(el('div', { class: 'chat-msg' }, [
      el('span', { class: 'chat-who', text: `${msg.name}: ` }),
      el('span', { class: 'chat-text', text: msg.text }),
    ]));
  }
  box.scrollTop = box.scrollHeight;
  for (const tab of document.querySelectorAll('.chat-tab')) {
    setClass(tab, 'is-on', tab.dataset.scope === scope);
  }
}

function pushChat(msg) {
  const key = msg.scope === 'global' ? 'global' : 'room';
  const list = store.chat[key];
  list.push(msg);
  if (list.length > MAX_CHAT) list.shift();
  if (key !== scope) store.unread[key]++;
  renderChat();
}

function floatEmote(playerId, name, text) {
  const host = $('emotes');
  if (!host) return;
  const board = table.boardEl(playerId);
  const bubble = el('div', { class: 'emote-bubble', text: `${name}: ${text}` });
  if (board) {
    const rect = board.getBoundingClientRect();
    bubble.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    bubble.style.top = `${Math.round(rect.top + 8)}px`;
  }
  host.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2400);
}

export function mount() {
  pointer.registerActions({
    'chat-scope': (elx) => { scope = elx.dataset.scope === 'global' ? 'global' : 'room'; store.unread[scope] = 0; renderChat(); },
    'send-chat': () => {
      const input = $('chat-input');
      const text = (input?.value || '').trim();
      if (!text) return;
      send.chat(text, scope);
      input.value = '';
    },
  });

  $('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    document.querySelector('[data-action="send-chat"]')?.click();
  });

  bus.on(EVENTS.STATE_APPLIED, renderLog);
  bus.on(EVENTS.CHOREO_EVENT, (ev) => { if (ev.t === 'game_start') resetLog(); });
  bus.on(EVENTS.NET_CHAT, (msg) => pushChat(msg.msg));
  bus.on(EVENTS.NET_CHAT_HISTORY, (msg) => {
    const key = msg.scope === 'global' ? 'global' : 'room';
    store.chat[key] = Array.isArray(msg.msgs) ? msg.msgs.slice(-MAX_CHAT) : [];
    renderChat();
  });
  bus.on(EVENTS.NET_EMOTE, (msg) => floatEmote(msg.playerId, msg.name, msg.text));
}

export function resetLog() { tail = []; clear($('log')); }
