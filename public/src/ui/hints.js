// ui/hints.js — first-game contextual hints.
//
// Rules this obeys, from the P6 brief: never modal, never blocks input, at most
// three on screen, each shown once ever, and the moment the player does the
// thing the hint was teaching it disappears. The whole stack is
// pointer-events:none, so a hint can never eat a tap meant for a card.
//
// Storage is one localStorage key holding the ids already shown; when every id
// is in it the module stops subscribing to anything.

import { $, el, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { store } from '../state/store.js';
import * as sel from '../state/selectors.js';
import { mode } from '../interact/index.js';

const KEY = 'chud_hints_v1';
const MAX_ON_SCREEN = 3;
const LIFE_MS = 9000;

const HINTS = {
  drag: 'Drag cards straight onto the table to play them — the strip is the slow way.',
  pay: 'Tap your bank and property cards to pay, then confirm. Overpaying gives no change.',
  armed: 'Someone is on FINAL APPROACH. Break one of their sets before their turn comes '
    + 'around, or they win.',
};

let seen = null;
let host = null;
const live = new Map();                  // id → {node, timer}

function load() {
  if (seen) return seen;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    seen = new Set(Array.isArray(raw) ? raw : []);
  } catch { seen = new Set(); }
  return seen;
}

function remember(id) {
  load().add(id);
  try { localStorage.setItem(KEY, JSON.stringify([...seen])); } catch { /* private mode */ }
}

function done() { return load().size >= Object.keys(HINTS).length; }

function container() {
  if (!host?.isConnected) {
    host = el('div', { class: 'hints', attrs: { 'aria-live': 'polite' } });
    ($('app') || document.body).appendChild(host);
  }
  // Sit above the hand dock rather than over it: the dock's height is the hand
  // card size plus the button bar, which changes with the viewport, so it is
  // measured instead of guessed. Measured once per hint — three times a game.
  const dock = $('hand-dock');
  const lift = dock ? Math.round(dock.getBoundingClientRect().height) + 8 : 76;
  host.style.setProperty('--hint-lift', `${lift}px`);
  return host;
}

function dismiss(id) {
  const entry = live.get(id);
  if (!entry) return;
  live.delete(id);
  clearTimeout(entry.timer);
  setClass(entry.node, 'is-out', true);
  // 220ms matches the .hint-card transition in content.css.
  setTimeout(() => entry.node.remove(), 240);
}

function show(id) {
  if (!HINTS[id] || live.has(id) || load().has(id)) return;
  remember(id);
  if (live.size >= MAX_ON_SCREEN) dismiss(live.keys().next().value);
  const node = el('div', { class: 'hint-card' }, [
    el('span', { class: 'hint-mark', text: '›' }),
    el('span', { class: 'hint-body', text: HINTS[id] }),
  ]);
  container().appendChild(node);
  // Next frame so the entry transition has a start value to run from.
  requestAnimationFrame(() => setClass(node, 'is-in', true));
  live.set(id, { node, timer: setTimeout(() => dismiss(id), LIFE_MS) });
}

export function reset() {
  seen = new Set();
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  for (const id of [...live.keys()]) dismiss(id);
}

export function mount() {
  if (done()) return;

  // 1 · the player just tapped a hand card: teach the drag they did not use.
  bus.on(EVENTS.INTERACT_CHANGED, () => {
    if (mode.kind === 'strip') show('drag');
    else if (mode.kind !== 'idle') dismiss('drag');
    if (mode.kind === 'payment' && live.has('pay')) {
      // They are selecting cards — the hint has done its job.
      if (mode.selected.size) dismiss('pay');
    }
  });

  bus.on(EVENTS.STATE_APPLIED, () => {
    const snap = store.snapshot;
    if (!snap || snap.phase !== 'playing') {
      for (const id of [...live.keys()]) dismiss(id);
      return;
    }

    // 2 · first time money is demanded of them.
    if (sel.owedAmount() > 0) show('pay');
    else dismiss('pay');

    // 3 · first time an opponent arms (getPlayerView.armedIds — §3.10).
    const threat = (snap.armedIds || []).some(id => id !== store.self.id);
    if (threat) show('armed');
    else dismiss('armed');
  });
}
