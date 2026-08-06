// harness.js — the §9 test-only bridge, installed only with ?harness=1.
//
// Nothing in the shipped game may depend on this file: it observes, it injects
// recorded states, and it turns choreography instant so a tool never waits on a
// cinematic. driftCount is a live read of table/'s counter, so a tool can sample
// it between injections.

import * as table from './table/index.js';
import * as choreographer from './anim/choreographer.js';
import * as store from './state/store.js';
import * as audio from './audio/engine.js';
import * as fx from './fx/index.js';
import * as socket from './net/socket.js';
import * as interact from './interact/index.js';
import * as bus from './core/bus.js';

export function isHarness() {
  try { return new URLSearchParams(location.search).has('harness'); } catch { return false; }
}

export function install(readyPromise, applyStateFn) {
  const bridge = {
    version: 1,
    ready: readyPromise,
    sfxLog: [],
    hapticLog: [],
    sentLog: socket.sentLog,
    lastError: null,
  };

  Object.defineProperty(bridge, 'driftCount', {
    get: () => table.driftCount(),
    enumerable: true,
  });
  // Read-only view of what the client believes, so a tool can say WHY it is
  // stuck instead of guessing from the DOM.
  Object.defineProperty(bridge, 'snapshot', {
    get: () => store.store.snapshot,
    enumerable: true,
  });
  Object.defineProperty(bridge, 'selfId', {
    get: () => store.store.self.id,
    enumerable: true,
  });
  // The interaction machine's current mode — P4's tools need to assert on
  // "the tap put us in targeting", which the DOM only shows indirectly.
  Object.defineProperty(bridge, 'mode', {
    get: () => ({
      kind: interact.mode.kind,
      cardId: interact.mode.cardId,
      intent: interact.mode.intent,
      needs: interact.mode.needs.slice(),
      picks: { ...interact.mode.picks },
      selected: [...interact.mode.selected],
      hint: interact.mode.hint,
    }),
    enumerable: true,
  });
  Object.defineProperty(bridge, 'driftLog', {
    get: () => table.lastCorrections(),
    enumerable: true,
  });

  bridge.applyState = (msg) => {
    applyStateFn(msg, { harness: true });
    return true;
  };

  bridge.drainEvents = () => {
    choreographer.clear();
    if (store.store.snapshot) table.reconcile(store.store.snapshot, { count: false, animate: false });
    // The table just settled outside the choreographer's drain loop — announce
    // it, or CHOREO_IDLE listeners (interaction marks) never re-run on fixtures.
    bus.emit(bus.EVENTS.CHOREO_IDLE, null);
    return true;
  };

  bridge.resetDrift = () => { table.resetDrift(); return true; };

  // P4 affordance: the motion agent needs the REAL timing path under the bridge,
  // and drift is only an honest metric when the animated reconcile runs.
  bridge.setInstant = (on) => { choreographer.setInstant(on); return true; };

  choreographer.setInstant(true);
  socket.setSendRecording(true);
  audio.setRecorder((name, opts) => {
    bridge.sfxLog.push({ name, t: Math.round(performance.now()), mine: !!opts?.mine });
  });
  fx.setHapticRecorder((pattern) => {
    bridge.hapticLog.push({ pattern, t: Math.round(performance.now()) });
  });

  const record = (err) => {
    bridge.lastError = err && err.message ? `${err.message}` : String(err);
  };
  bus.setErrorSink((err) => { record(err); console.error(err); });
  window.addEventListener('error', (e) => record(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => record(e.reason));

  window.__CHUD = bridge;
  return bridge;
}
