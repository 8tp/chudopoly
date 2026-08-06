// main.js — the one entry (§0.2). Everything below is a real ES module import.
//
// Boot order matters exactly once: interact/pointer's delegated listener is
// mounted last, after every module has registered its data-action handlers.

import * as bus from './core/bus.js';
import { EVENTS } from './core/bus.js';
import { $, setText, setClass } from './core/dom.js';
import * as socket from './net/socket.js';
import * as store from './state/store.js';
import * as sel from './state/selectors.js';
import * as table from './table/index.js';
import * as choreographer from './anim/choreographer.js';
import * as interact from './interact/index.js';
import * as pointer from './interact/pointer.js';
import * as audio from './audio/engine.js';
import * as fx from './fx/index.js';
import * as screens from './ui/screens.js';
import * as home from './ui/home.js';
import * as lobby from './ui/lobby.js';
import * as hud from './ui/hud.js';
import * as prompt from './ui/prompt.js';
import * as comms from './ui/comms.js';
import * as overlays from './ui/overlays.js';
import { isHarness, install as installHarness } from './harness.js';

let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });

/** The single funnel every `state` message goes through — socket or harness. */
function applyState(msg, opts = {}) {
  const result = store.applyState(msg, { snap: !!opts.snap });
  table.setSelf(store.store.self.id);
  choreographer.setSelf(store.store.self.id);
  if (result.snapshot) choreographer.enqueue(result.snapshot, result.events, { snap: result.snap });
  return result;
}

function wireNet() {
  bus.on(EVENTS.NET_OPEN, () => { store.store.connected = true; });
  bus.on(EVENTS.NET_CLOSE, () => { store.store.connected = false; });

  bus.on(EVENTS.NET_JOINED, (msg) => {
    store.setSelf(msg.playerId, msg.name);
    table.setSelf(msg.playerId);
    choreographer.setSelf(msg.playerId);
    setText($('home-error'), '');
  });

  bus.on(EVENTS.NET_STATE, (msg) => applyState(msg));

  bus.on(EVENTS.NET_ERROR, (msg) => {
    screens.toast(msg.message || 'Refused');
    if (msg.needDiscard) interact.beginDiscard(msg.excess || 1);
    if (msg.needPayment) interact.beginPayment(msg.amount || sel.owedAmount());
  });

  bus.on(EVENTS.NET_NEED_PAYMENT, (msg) => interact.beginPayment(msg.amount || sel.owedAmount()));

  bus.on(EVENTS.NET_KICKED, () => {
    socket.clearCreds();
    store.reset();
    store.setScreen('home');
    screens.toast('You were removed from the room');
  });

  // §7 sound dispatch is structured-event driven — never log prose (§0.5).
  bus.on(EVENTS.CHOREO_SFX, ({ name, mine }) => {
    audio.play(audio.SFX_FOR_EVENT[name] || name, { mine });
  });
  bus.on(EVENTS.CHOREO_EVENT, (ev) => {
    if (ev.t === 'set_completed' && ev.actor === store.store.self.id) fx.haptic(fx.HAPTICS.setComplete);
    if (ev.t === 'win' && ev.actor === store.store.self.id) fx.haptic(fx.HAPTICS.win);
  });
}

function wireConnectionChrome() {
  const paint = () => setClass($('hud-conn'), 'is-off', !store.store.connected);
  bus.on(EVENTS.NET_OPEN, paint);
  bus.on(EVENTS.NET_CLOSE, paint);
}

function boot() {
  table.mount(store.store.self.id);

  screens.mount();
  overlays.mount();
  home.mount();
  lobby.mount();
  hud.mount();
  prompt.mount();
  comms.mount();
  interact.mount();
  pointer.mount();

  wireNet();
  wireConnectionChrome();

  if (isHarness()) {
    installHarness(ready, (msg, opts) => applyState(msg, opts));
  } else {
    // §7: no AudioContext before a gesture.
    const unlock = () => { audio.init(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock, { once: true });
  }

  // Resume runs in harness mode too, so a tool exercises the same code a player
  // does on a page reload. A fresh harness context holds no credentials.
  const creds = socket.creds();
  if (creds.playerId && creds.code && creds.resumeToken) socket.resumeOrConnect();

  screens.showScreen(store.store.screen);
  resolveReady(true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export { ready };
