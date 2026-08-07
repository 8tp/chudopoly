// main.js — the one entry (§0.2). Everything below is a real ES module import.
//
// Boot order matters exactly once: interact/pointer's delegated listener is
// mounted last, after every module has registered its data-action handlers.

import * as bus from './core/bus.js';
import { EVENTS } from './core/bus.js';
import { $, setText } from './core/dom.js';
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
import * as peek from './ui/peek.js';
import * as overlays from './ui/overlays.js';
import { isHarness, install as installHarness } from './harness.js';

let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });

/** The single funnel every `state` message goes through — socket or harness. */
function applyState(msg, opts = {}) {
  // `harness` travels too. harness.js has always set it and this funnel has
  // always dropped it, so an injected fixture was indistinguishable from a game
  // a player had just started — and ui/screens.js has to tell them apart, since
  // a view transition costs 320ms of document-wide hit-testing and a fixture
  // teleport buys nothing with it. It is NOT `snap`: the tools deliberately
  // exercise the animated reconcile (setInstant(false), driftCount), so the
  // choreography must stay exactly as it is.
  const result = store.applyState(msg, { snap: !!opts.snap, harness: !!opts.harness });
  table.setSelf(store.store.self.id);
  choreographer.setSelf(store.store.self.id);
  if (result.snapshot) choreographer.enqueue(result.snapshot, result.events, { snap: result.snap });
  return result;
}

/* ── a session that cannot come back (§P7.21) ──────────────────────────────
 *
 * MEASURED: restart the server and the client sat on a frozen board claiming
 * "connected" forever. The reconnect loop worked perfectly — it just got
 * `{type:'error', message:'Room not found'}` every 2s from
 * server/handlers.js:114/160, which the client only ever TOASTED. clearCreds()
 * was reachable from exactly one place (NET_KICKED), so the dead resume token
 * was replayed for as long as the tab stayed open, and `connected` was true
 * because the transport was up — the indicator was telling the truth about the
 * socket and lying about the game.
 *
 * These two messages mean the seat is gone and no retry can bring it back.
 * They are the only ones treated as fatal: everything else is a refused move.
 */
const FATAL_SESSION = [
  'Room not found',                 // server/handlers.js join_room / reconnect
  'Invalid resume credentials',     // server/handlers.js reconnect
];

function isFatalSessionError(text) {
  return FATAL_SESSION.some(m => String(text).toLowerCase().includes(m.toLowerCase()));
}

/** Stop retrying, forget the seat, say so, and put the player somewhere real.
 *  Same teardown the Leave room control uses (ui/screens.js) — there is exactly
 *  one way out of a session. */
function endSession(why) {
  screens.endSession({
    error: `${why} — that game is over on the server (it restarted, or the room expired). `
      + 'Start a new one.',
    message: 'That room is gone. Starting fresh.',
  });
}

/**
 * The connection flag is wired BEFORE any screen mounts, because ui/hud.js
 * subscribes to the same two events and would otherwise paint the previous
 * value — the indicator was a frame behind the truth in both directions.
 */
function wireConnectionFlag() {
  bus.on(EVENTS.NET_OPEN, () => { store.store.connected = true; });
  bus.on(EVENTS.NET_CLOSE, () => { store.store.connected = false; });
}

function wireNet() {
  bus.on(EVENTS.NET_JOINED, (msg) => {
    store.setSelf(msg.playerId, msg.name);
    table.setSelf(msg.playerId);
    choreographer.setSelf(msg.playerId);
    setText($('home-error'), '');
  });

  bus.on(EVENTS.NET_STATE, (msg) => applyState(msg));

  bus.on(EVENTS.NET_ERROR, (msg) => {
    const text = msg?.message || 'Refused';
    if (isFatalSessionError(text)) { endSession(text); return; }
    screens.toast(text);
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
  // SFX_FOR_EVENT null means the FX_CUE channel owns that moment — don't fall
  // back to the raw event name. `ev` rides along so virtual families
  // (action/steal/set_progress) resolve without registration-order tricks.
  bus.on(EVENTS.CHOREO_SFX, ({ name, ev, mine }) => {
    const mapped = audio.SFX_FOR_EVENT[name];
    if (mapped !== null) audio.play(mapped || name, { mine, ev });
  });
  // Haptics live in fx/ off the cue channel — dispatching them here too would
  // just be eaten by fx's 300ms floor.
}

function boot() {
  wireConnectionFlag();
  table.mount(store.store.self.id);

  screens.mount();
  overlays.mount();
  home.mount();
  lobby.mount();
  hud.mount();
  prompt.mount();
  comms.mount();
  peek.mount();
  interact.mount();
  pointer.mount();

  wireNet();

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
