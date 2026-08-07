// ui/hud.js — turn state, play counter, timers, and the turn-level controls.
//
// The timer is the only thing here that runs per frame, and it writes at most
// two guarded values per frame (§0.8): the ring fraction as a CSS var and the
// seconds text, both skipped when unchanged. Urgency fires once at 10s and once
// at 5s, not per tick (§5).

import { $, qs, setText, setAttr, setHidden, setClass } from '../core/dom.js';
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
import { el, clear } from '../core/dom.js';

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

/* ── final approach + attrition strip (§3.10 / §3.11) ────────────────────
 *
 * The engine hands the client everything this needs: getPlayerView exposes
 * `armedIds`, per-player `finalApproach` / `finalApproachIn`
 * (= turnsUntilCheckpoint: activeCount − turnsSinceArming), and the
 * `deckCycle` / `deckCycleLimit` pair behind the §3.11 points ending. Nothing
 * here is derived or guessed.
 *
 * It lives inside #hud as a wrapped second row rather than as a floating layer:
 * a fixed overlay over a 390px table covers the opponent boards, which are
 * exactly what you are being told to attack.
 */
let strip = null;
let stripKey = '';

function stripEl() {
  if (strip?.isConnected) return strip;
  strip = el('div', {
    id: 'hud-strip', class: 'hud-strip',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  strip.hidden = true;
  $('hud')?.appendChild(strip);
  return strip;
}

function turnsText(n) {
  if (n == null) return '';
  if (n <= 0) return 'wins the moment their turn begins';
  return `${n} turn${n === 1 ? '' : 's'} left`;
}

function renderStrip() {
  const snap = store.snapshot;
  const box = stripEl();
  if (!snap || snap.phase !== 'playing') {
    if (stripKey !== '') { stripKey = ''; clear(box); }
    setHidden(box, true);
    return;
  }

  const armed = (snap.players || []).filter(p => p.finalApproach && !p.eliminated);
  const mineArmed = armed.filter(p => p.id === store.self.id);
  const theirs = armed.filter(p => p.id !== store.self.id);
  const cycle = snap.deckCycle || 0;
  const limit = snap.deckCycleLimit || 0;
  // Half the allowance is the point where an attrition finish stops being
  // theoretical: healthy games spend 1.9 cycles (game.js DECK_CYCLE_LIMIT note).
  const attrition = limit > 0 && cycle >= Math.ceil(limit / 2);

  if (!armed.length && !attrition) {
    if (stripKey !== '') { stripKey = ''; clear(box); }
    setHidden(box, true);
    return;
  }

  const key = [
    mineArmed.map(p => p.finalApproachIn).join(','),
    theirs.map(p => `${p.id}:${p.finalApproachIn}`).join(','),
    attrition ? `${cycle}/${limit}` : '',
  ].join('|');
  if (key === stripKey) { setHidden(box, false); return; }
  stripKey = key;

  clear(box);
  setClass(box, 'is-threat', theirs.length > 0);
  setClass(box, 'is-mine', theirs.length === 0 && mineArmed.length > 0);

  if (theirs.length) {
    // Someone else can win. Name them, and say what to do about it.
    box.appendChild(el('span', { class: 'strip-flag', text: 'BREAK THEM NOW' }));
    box.appendChild(el('span', { class: 'strip-text' },
      theirs.map((p, i) => el('span', { class: 'strip-who' }, [
        el('b', { text: p.name }),
        el('span', { text: ` on final approach — ${turnsText(p.finalApproachIn)}` }),
        i < theirs.length - 1 ? el('span', { class: 'strip-sep', text: ' · ' }) : null,
      ].filter(Boolean)))));
    if (mineArmed.length) {
      box.appendChild(el('span', {
        class: 'chip strip-chip',
        text: `You: ${turnsText(mineArmed[0].finalApproachIn)}`,
      }));
    }
  } else if (mineArmed.length) {
    const n = mineArmed[0].finalApproachIn;
    box.appendChild(el('span', { class: 'strip-flag', text: 'FINAL APPROACH' }));
    box.appendChild(el('span', {
      class: 'strip-text',
      text: n <= 0
        ? 'HOLD THE LINE — you win when your turn begins.'
        : `HOLD THE LINE — ${n} turn${n === 1 ? '' : 's'} of theirs to survive. `
          + 'Lose a set and it is off.',
    }));
  }

  if (attrition) {
    box.appendChild(el('span', {
      class: `chip strip-chip${cycle >= limit - 2 ? ' is-hot' : ''}`,
      text: `DECK CYCLE ${cycle}/${limit}`,
      attrs: { title: 'At the limit the game ends on points: most sets, then net worth.' },
    }));
  }
  setHidden(box, false);
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
  renderStrip();
}

/** The settings entry point. public/index.html is architect-owned (§1) and P6
 *  adds exactly one control, so the node is built here instead. */
function installSettingsButton() {
  const right = qs('.hud-right');
  if (!right || qs('[data-action="settings"]', right)) return;
  const gear = el('button', {
    class: 'btn btn-icon',
    text: '⚙',
    attrs: { type: 'button', 'aria-label': 'Sound and settings' },
    dataset: { action: 'settings' },
  });
  right.insertBefore(gear, right.lastElementChild);
}

export function mount() {
  installSettingsButton();
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
