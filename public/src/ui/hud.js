// ui/hud.js — turn state, play counter, timers, and the turn-level controls.
//
// The timer is the only thing here that runs per frame, and it writes at most
// two guarded values per frame (§0.8): the ring fraction as a CSS var and the
// seconds text, both skipped when unchanged. Urgency fires once at 10s and once
// at 5s, not per tick (§5).

import { $, setText, setAttr, setHidden, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { subscribe } from '../core/clock.js';
import { clamp } from '../core/math.js';
import * as send from '../net/send.js';
import { store, seatName, isMyTurn } from '../state/store.js';
import * as sel from '../state/selectors.js';
import * as interact from '../interact/index.js';
import * as pointer from '../interact/pointer.js';
import * as audio from '../audio/engine.js';
import { haptic, HAPTICS } from '../fx/index.js';
import { toast, openSheet, closeSheet } from './screens.js';
import { el } from '../core/dom.js';

let lastSeconds = -1;
let urgency = 0;

function activeTimer() {
  const snap = store.snapshot;
  if (!snap || snap.phase !== 'playing') return null;
  if (snap.pendingAction && store.timers.response) return store.timers.response;
  if (!snap.pendingAction && store.timers.turn) return store.timers.turn;
  return null;
}

function tickTimer() {
  const timer = activeTimer();
  const box = $('hud-timer');
  if (!box) return;
  if (!timer) {
    if (!box.hidden) { setHidden(box, true); lastSeconds = -1; urgency = 0; }
    return;
  }
  const left = clamp(timer.timeout - (Date.now() - timer.startedAt) / 1000, 0, timer.timeout);
  // A zero here means the server's timeout already fired and its broadcast is in
  // flight; showing "0s" for that gap reads as a hung clock.
  if (left <= 0) { setHidden(box, true); lastSeconds = -1; return; }
  setHidden(box, false);
  const seconds = Math.ceil(left);
  if (seconds !== lastSeconds) {
    lastSeconds = seconds;
    setText($('hud-timer-text'), `${seconds}s`);
    const frac = timer.timeout ? left / timer.timeout : 0;
    box.style.setProperty('--frac', frac.toFixed(3));
    setClass(box, 'is-urgent', seconds <= 10);
    setClass(box, 'is-critical', seconds <= 5);
    if (seconds <= 5 && urgency < 2) { urgency = 2; audio.play('timer_critical'); haptic(HAPTICS.targeted); }
    else if (seconds <= 10 && urgency < 1) { urgency = 1; audio.play('timer_warn'); }
    else if (seconds > 10) urgency = 0;
  }
}

function render() {
  const snap = store.snapshot;
  setText($('hud-room'), store.room.code || '');
  setClass($('hud-conn'), 'is-off', !store.connected);
  setAttr($('hud-conn'), 'title', store.connected ? 'Connected' : 'Reconnecting…');
  if (!snap) return;

  const mine = isMyTurn();
  const turnName = snap.phase === 'finished'
    ? 'GAME OVER'
    : (mine ? 'YOUR TURN' : `${seatName(snap.currentPlayerId)}'s turn`);
  setText($('hud-turn'), turnName);
  setClass($('hud-turn'), 'is-mine', mine);
  setText($('hud-plays'), mine && snap.turnPhase === 'play' ? `${snap.playsRemaining} plays` : '');
  setText($('hand-count'), String(sel.myHand().length));
  setClass($('hand-dock'), 'over-limit', sel.myHand().length > (snap.handLimit || 7));

  const canDraw = sel.canDraw();
  setHidden($('btn-draw'), !canDraw);
  setAttr($('btn-end-turn'), 'disabled', !mine || snap.turnPhase !== 'play' ? true : null);
  setAttr($('btn-scoop'), 'disabled', snap.phase !== 'playing' ? true : null);
  setClass($('table'), 'surge-on', !!snap.surgeOps);
}

export function mount() {
  pointer.registerActions({
    draw: () => { if (sel.canDraw()) send.draw(); },
    'end-turn': () => {
      const snap = store.snapshot;
      if (!snap || !isMyTurn()) { toast('Not your turn'); return; }
      const excess = sel.myHand().length - (snap.handLimit || 7);
      if (excess > 0) { interact.beginDiscard(excess); return; }
      send.endTurn();
    },
    scoop: () => {
      openSheet('Scoop out?', el('div', { class: 'sheet-confirm' }, [
        el('p', { text: 'Scooping discards everything you own and takes you out of the game. There is no undo.' }),
        el('button', { class: 'btn btn-danger', text: 'Scoop out', attrs: { 'data-action': 'confirm-scoop' } }),
        el('button', { class: 'btn btn-ghost', text: 'Stay in', attrs: { 'data-action': 'close-sheet' } }),
      ]));
    },
    'confirm-scoop': () => { send.scoop(); closeSheet(); },
    'toggle-side': () => {
      const side = $('side');
      if (side) setHidden(side, !side.hidden);
    },
    emote: () => {
      const list = el('div', { class: 'emote-grid' });
      for (const text of ['GG', 'Nice', 'Oof', 'Wow', 'Hurry!', 'CHUD!', 'o7', 'Sorry']) {
        list.appendChild(el('button', {
          class: 'btn', text,
          attrs: { 'data-action': 'send-emote', 'data-text': text },
        }));
      }
      openSheet('Emote', list);
    },
    'send-emote': (elx) => { send.emote(elx.dataset.text); closeSheet(); },
  });

  bus.on(EVENTS.STATE_APPLIED, render);
  bus.on(EVENTS.NET_OPEN, render);
  bus.on(EVENTS.NET_CLOSE, render);
  subscribe(tickTimer);
}
