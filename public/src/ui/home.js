// ui/home.js — call sign, create/join/quick play, and the deck on the table.

import { $, el, setText, setAttr } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as socket from '../net/socket.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import * as audio from '../audio/engine.js';
import { faceNode, backNode } from '../table/cardart.js';

const NAME_KEY = 'chud_name';

/* ══ THE DECK ON THE TABLE ═══════════════════════════════════════════════
   index.html used to carry eleven hand-authored spans here: two stale copies
   of the Fighters and Space Force glyphs, a bespoke value coin pinned at
   left:8%/bottom:7% that matched no real card, and a back showing only the
   alignment target with the wordmark missing. The owner's verdict on the
   close-up was "tacky / not well made", and the cause is duplication rather
   than draughtsmanship: table/cardart.js has been redrawn three times since
   those copies were taken, so they were wrong the moment they were written and
   would go wrong again.

   So the menu builds REAL CARDS. faceNode()/backNode() return detached nodes
   parsed through cardart's own DOMParser path (§0.4 — nothing writes innerHTML),
   and the 'hand' tier is the one that is fully container-query relative, so the
   same markup that renders at 37px in a crowded fan renders at 250px here with
   every proportion preserved. That is also the answer to the coin: it sits
   where the card design puts it, at whatever size, because it IS the card.

   Decorative only. No [data-card-id] — every consumer in the client (pointer,
   choreographer, peek, prompt) selects on that attribute, so a node without one
   is invisible to all of them — no .card / .cardzone class, and the host is
   aria-hidden.

   WHICH CARDS. A property and an action, not two properties: the two halves of
   what the deck does. The F-22 is the game's signature glyph and its set is the
   one the wordmark's red is drawn from; the Inspector General is the card the
   whole table is afraid of, it is achromatic by §1 so it does not fight the
   red, and at 5M it carries the largest coin in the deck. */
const HOME_CARDS = [
  { id: 'home-a', type: 'property', color: 'red', name: 'F-22 Raptor', value: 3 },
  {
    id: 'home-b', type: 'action', action: 'inspector_general', name: 'Inspector General', value: 5,
    description: 'Steal a complete property set from any player. OPSEC can block it.',
  },
];

/** How many backs are in the pile. Four reads as "a deck"; three reads as
 *  "some cards" and five buys nothing but overdraw at this size. */
const DECK_DEPTH = 4;

function buildDeck() {
  const host = $('home-deck');
  if (!host || host.firstChild) return;

  // The pile. Each back gets its own box so the container query sizing the art
  // is the card, not the pile (cardart.css queries the nearest inline-size
  // container and .home-deck is far wider than one card).
  for (let i = 0; i < DECK_DEPTH; i++) {
    const box = el('div', { class: `home-cardbox home-back home-back-${i}` });
    box.appendChild(backNode('hand'));
    host.appendChild(box);
  }

  HOME_CARDS.forEach((card, i) => {
    const face = faceNode(card, 'hand');
    if (!face) return;
    const box = el('div', { class: `home-cardbox home-dealt home-dealt-${i}` });
    box.appendChild(face);
    host.appendChild(box);
  });
}

/* ══ SOUND, FROM THE MENU ════════════════════════════════════════════════
   §7 attaches the music bed on the first pointerdown anywhere in the document
   (main.js), and until now the only switch lived in the game screen's settings
   sheet — so a player whose first gesture was Quick Play got a bed they could
   not silence until the table had finished loading. engine.js documents
   setMusicEnabled() as safe before a gesture (the score is a no-op until the
   graph attaches) and pointer.js listens on window CAPTURE while main.js's
   unlock listener is on the bubble phase, so this button pressed as the very
   first gesture of a session sets the preference before init() ever runs. */
function paintSound() {
  const on = audio.isMusicEnabled();
  const btn = $('btn-home-sound');
  if (!btn) return;
  btn.classList.toggle('is-off', !on);
  setAttr(btn, 'aria-pressed', String(on));
  setText($('home-sound-label'), on ? 'Sound on' : 'Sound off');
}

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

/* ══ FIRST-TIMER vs RETURNING ════════════════════════════════════════════
   These looked identical, which is the gap: the returning player's call sign
   was silently prefilled and nothing on screen acknowledged it, so the field
   still read as the first thing to answer when it was already answered.

   The difference is deliberately NOT a reordering. Moving the answered field
   below the button is the tempting version and it breaks WCAG 2.4.3 — visual
   order and focus order would disagree. So the DOM order is fixed and the
   EMPHASIS moves: the greeting names them, and .is-returning narrows the
   answered call-sign row so the ink slab takes the width it gives up. */
function paintIdentity(name) {
  const home = document.querySelector('.home');
  const greet = $('home-greet');
  if (!home || !greet) return;
  home.classList.toggle('is-returning', !!name);
  if (name) setText(greet, `Welcome back, ${name}.`);
  greet.hidden = !name;
}

export function mount() {
  const input = $('name-input');
  const saved = savedName();
  if (input && !input.value) input.value = saved;
  paintIdentity(saved);
  buildDeck();
  paintSound();

  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').toUpperCase();
  if (room && $('code-input')) $('code-input').value = room;

  pointer.registerActions({
    'home-sound': () => { audio.setMusicEnabled(!audio.isMusicEnabled()); paintSound(); },
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
