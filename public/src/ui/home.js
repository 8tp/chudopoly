// ui/home.js — call sign, create/join/quick play.

import { $, setText } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as socket from '../net/socket.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';

const NAME_KEY = 'chud_name';

function savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* private mode */ }
}

function nameOrComplain() {
  const input = $('name-input');
  const name = (input?.value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,15}$/.test(name)) {
    setText($('home-error'), 'Call sign: 1–16 letters, numbers, spaces or . _ - \'');
    input?.focus();
    return null;
  }
  setText($('home-error'), '');
  rememberName(name);
  store.self.name = name;
  return name;
}

function go(fn) {
  const name = nameOrComplain();
  if (!name) return;
  socket.connect();
  fn(name);
}

export function mount() {
  const input = $('name-input');
  if (input && !input.value) input.value = savedName();

  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').toUpperCase();
  if (room && $('code-input')) $('code-input').value = room;

  pointer.registerActions({
    'quick-play': () => go((name) => send.quickPlay(name)),
    'create-room': () => go((name) => send.createRoom(name)),
    'join-room': () => go((name) => {
      const code = ($('code-input')?.value || '').trim().toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) {
        setText($('home-error'), 'Room codes are 4 characters.');
        return;
      }
      send.joinRoom(code, name, socket.creds());
    }),
  });

  // Enter submits from either field.
  for (const id of ['name-input', 'code-input']) {
    $(id)?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = ($('code-input')?.value || '').trim();
      if (code) $('btn-join-room')?.click();
      else $('btn-quick-play')?.click();
    });
  }

  bus.on(EVENTS.NET_ERROR, (msg) => {
    if (store.screen === 'home') setText($('home-error'), msg.message || 'Something went wrong');
  });
  bus.on(EVENTS.NET_JOINED, () => setText($('home-error'), ''));
}
