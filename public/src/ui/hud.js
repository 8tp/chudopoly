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
import { deckCycleNotice } from '../core/cards.js';
import * as send from '../net/send.js';
import * as socket from '../net/socket.js';
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

/** One ring, painted. Two guarded writes plus the class flips (§0.8). */
function paintRing(box, seconds, frac) {
  if (!box) return;
  setHidden(box, false);
  setText(box.firstElementChild, `${seconds}s`);
  box.style.setProperty('--frac', frac.toFixed(3));
  setClass(box, 'is-urgent', seconds <= 10);
  setClass(box, 'is-critical', seconds <= 5);
}

/**
 * §5 wants urgency at ≤10s and ≤5s where the decision is. When the countdown
 * belongs to a RESPONSE, the decision is the prompt bar at the bottom of the
 * phone, not the 2.35em ring in the top HUD — measured: the respond prompt
 * rendered with #hud-timer hidden entirely, so being attacked had no clock at
 * all (§P7.7). ui/prompt.js builds #prompt-timer; this is the one clock (§0.6)
 * and it paints both rings from the same tick.
 */
function tickTimer() {
  const timer = activeTimer();
  const box = $('hud-timer');
  const bar = $('prompt-timer');
  const left = timer
    ? clamp(timer.timeout - (Date.now() - timer.startedAt) / 1000, 0, timer.timeout)
    : 0;
  // A zero here means the server's timeout already fired and its broadcast is in
  // flight; showing "0s" for that gap reads as a hung clock.
  if (!timer || left <= 0) {
    if (box && !box.hidden) setHidden(box, true);
    if (bar && !bar.hidden) setHidden(bar, true);
    if (lastSeconds !== -1) { lastSeconds = -1; urgency = 0; }
    return;
  }
  const seconds = Math.ceil(left);
  if (seconds === lastSeconds && (!bar || !bar.hidden)) return;
  lastSeconds = seconds;
  const frac = timer.timeout ? left / timer.timeout : 0;
  paintRing(box, seconds, frac);
  paintRing(bar, seconds, frac);
  if (seconds <= 5 && urgency < 2) { urgency = 2; audio.play('timer_critical'); haptic(HAPTICS.targeted); }
  else if (seconds <= 10 && urgency < 1) { urgency = 1; audio.play('timer_warn'); }
  else if (seconds > 10) urgency = 0;
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

/* ── the countdown that is allowed to print a number (§P7.17) ──────────────
 *
 * `finalApproachIn` (= the old turnsUntilCheckpoint) is DEPRECATED and still
 * lies, in two measured ways against game.js:
 *
 *   • Armed on your own turn, 4 players: it printed 4, but only 3 opponent
 *     turns stand between you and the win. Off by one, always.
 *   • Armed on someone else's turn: one of your OWN turns falls inside the
 *     grace window and does not convert, so you need a second own turn. Worked
 *     example, 4 players, you seat 0, armed during seat 1's turn T: you take
 *     turns at T+3 (no win) and T+7 (win) — six opponent turns. The field read
 *     1 at T+3 and clamped to 0 at T+4, i.e. "wins the moment their turn
 *     begins" three whole turns early.
 *
 * The engine now publishes the honest one (P7 round-1 hardening, 65e36ef):
 * `opponentTurnsRemaining` — turns by OTHER players before the converting turn,
 * `null` unless armed, and `0` meaning the very next turn to start is theirs.
 * That is the ONLY number printed here. `finalApproachIn` is never read.
 */

/** @returns {number|null} turns other players get before this one converts. */
function opponentTurns(player) {
  const n = player?.opponentTurnsRemaining;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The engine's own "the next turn to start is theirs and it wins". */
function convertsNext(player) { return opponentTurns(player) === 0; }

function countdownText(player, mine) {
  const n = opponentTurns(player);
  if (n === 0) {
    return mine
      ? 'You win at the start of your next turn — unless you lose a set first.'
      : 'They win at the start of their next turn. This is your last turn to break them.';
  }
  if (n != null) {
    return mine
      ? `${n} more turn${n === 1 ? '' : 's'} of theirs to survive. Lose a set and it is off.`
      : `${n} turn${n === 1 ? '' : 's'} left to break them.`;
  }
  // No honest field on this snapshot (an older server, a hand-built fixture):
  // print the rule, never a number we cannot stand behind.
  return mine
    ? 'You convert at your own turn start, once every seat has had a turn. '
      + 'Lose a set and it is off.'
    : 'Converts at their own turn start, once every seat has had a turn.';
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
  // The threshold lives in core/cards.js so ui/help.js can promise the same one.
  const attrition = limit > 0 && cycle >= deckCycleNotice(limit);

  if (!armed.length && !attrition) {
    if (stripKey !== '') { stripKey = ''; clear(box); }
    setHidden(box, true);
    return;
  }

  const stamp = (p) => `${p.id}:${opponentTurns(p)}`;
  const key = [
    mineArmed.map(stamp).join(','),
    theirs.map(stamp).join(','),
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
        el('span', { text: ` on final approach — ${countdownText(p, false)}` }),
        i < theirs.length - 1 ? el('span', { class: 'strip-sep', text: ' · ' }) : null,
      ].filter(Boolean)))));
    if (mineArmed.length) {
      box.appendChild(el('span', {
        class: 'chip strip-chip',
        text: convertsNext(mineArmed[0]) ? 'You: win next turn' : 'You: armed',
        attrs: { title: countdownText(mineArmed[0], true) },
      }));
    }
  } else if (mineArmed.length) {
    box.appendChild(el('span', { class: 'strip-flag', text: 'FINAL APPROACH' }));
    // The caveat lives inside countdownText — repeating it here printed
    // "unless you lose a set first. Lose a set and it is off." (measured on the
    // final-approach phone shot).
    box.appendChild(el('span', {
      class: 'strip-text',
      text: `HOLD THE LINE — ${countdownText(mineArmed[0], true)}`,
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

/* §P7.12 — connection loss was an 8×8px dot whose only explanation lived in a
 * hover `title`, which a phone cannot produce. A word joins the dot. The node is
 * built here because public/index.html is architect-owned (§1). */
let connLabel = null;

function installConnLabel() {
  const dot = $('hud-conn');
  if (!dot || connLabel?.isConnected) return;
  connLabel = el('span', {
    class: 'conn-label',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  dot.parentElement?.insertBefore(connLabel, dot.nextSibling);
}

function renderConn() {
  // A client that is not TRYING to be connected is not disconnected — that is
  // every fixture-staged harness page, and it was painting a red dot and
  // "RECONNECTING…" across the whole screenshot review set.
  const lost = socket.wanted() && !store.connected;
  setClass($('hud-conn'), 'is-off', lost);
  setAttr($('hud-conn'), 'title', lost ? 'Reconnecting…' : 'Connected');
  installConnLabel();
  if (!connLabel) return;
  setText(connLabel, lost ? 'RECONNECTING…' : '');
  setClass(connLabel, 'is-on', lost);
}

function render() {
  const snap = store.snapshot;
  setText($('hud-room'), store.room.code || '');
  renderConn();
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

  // #btn-draw is suppressed by ui/prompt.js — the draw is automatic now, so
  // there is no draw affordance anywhere (§P7.9). Nothing here touches it.
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
  installConnLabel();
  pointer.registerActions({
    // The engine draws at turn start (65e36ef) and accepts `draw` as a silent
    // no-op. Kept registered so a stray [data-action="draw"] anywhere — an old
    // fixture, a tool — cannot fall through to nothing.
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
  bus.on(EVENTS.NET_OPEN, renderConn);
  bus.on(EVENTS.NET_CLOSE, renderConn);
  subscribe(tickTimer);
}
