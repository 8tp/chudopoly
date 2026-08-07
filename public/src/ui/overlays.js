// ui/overlays.js — the win screen, and the wiring for the rules brief,
// settings and first-game hints.
//
// The win screen has one job beyond ceremony: say WHY the game ended. Three
// endings reach it (game.js finishGame) and two of them are not "someone got
// three sets", so a screen that only ever printed a name was lying by omission.

import { $, el, clear, setText, setHidden } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store, seatName } from '../state/store.js';
import { COLORS, COLOR_KEYS, SETS_TO_WIN } from '../core/cards.js';
import * as pointer from '../interact/pointer.js';
import { closeSheet } from './screens.js';
import * as help from './help.js';
import * as settings from './settings.js';
import * as hints from './hints.js';

/**
 * finishGame() stamps state.endReason with 'sets' | 'last_standing' |
 * 'stalemate'. The stalemate sub-reason ('deck_dry' | 'deck_cycles') rides on
 * the emitted event, not on the view, so read it off the event tail — falling
 * back to the deck-cycle counter, which getPlayerView does carry.
 */
function stalemateCause(snap) {
  for (let i = (snap.events || []).length - 1; i >= 0; i--) {
    const ev = snap.events[i];
    if (ev.t === 'stalemate') return ev.reason || 'deck_dry';
  }
  const limit = snap.deckCycleLimit || 0;
  return limit && (snap.deckCycle || 0) >= limit ? 'deck_cycles' : 'deck_dry';
}

function endingCopy(snap) {
  const winner = snap.winner;
  const player = (snap.players || []).find(p => p.id === winner) || null;
  const mine = winner && winner === store.self.id;

  if (!winner) {
    return { title: 'NO WINNER', tag: 'DRAW', reason: 'Nobody was left holding anything.' };
  }
  if (snap.endReason === 'last_standing') {
    return {
      title: mine ? 'LAST ONE STANDING' : `${seatName(winner)} SURVIVES`,
      tag: 'LAST STANDING',
      // scoop(): activePlayers.length === 1 → finishGame(..., 'last_standing').
      reason: 'Everyone else scooped out. The last player at the table wins immediately — '
        + 'no final approach, no checkpoint.',
    };
  }
  if (snap.endReason === 'stalemate') {
    const cause = stalemateCause(snap);
    return {
      title: mine ? 'DECIDED ON POINTS' : `${seatName(winner)} WINS ON POINTS`,
      tag: 'ATTRITION',
      // endInStalemate(): ranked by completedSets, then playerNetWorth.
      reason: (cause === 'deck_cycles'
        // endTurn(): shuffleCount >= DECK_CYCLE_LIMIT.
        ? `The discard was reshuffled into the deck ${snap.deckCycleLimit || 16} times with `
          + 'nobody closing it out, so the game went to points. '
        // endTurn(): _idleTurns >= activeCount with deck and discard both empty.
        : 'Deck and discard both ran dry and a full round passed with nobody playing a card '
          + 'out of hand, so the game went to points. ')
        + `Most completed sets wins — ${player ? player.name : 'the winner'} took it with `
        + `${player?.completedSets ?? 0}, net worth ${player?.netWorth ?? 0}M breaking any tie.`,
      points: true,
    };
  }
  // 'sets' — resolveFinalApproach() at the armed player's own turn start.
  return {
    title: mine ? 'MISSION ACCOMPLISHED' : `${seatName(winner)} WINS`,
    tag: 'FINAL APPROACH HELD',
    reason: `Held ${SETS_TO_WIN} complete sets through a full turn cycle and converted at `
      + 'their own turn start. Nobody broke the approach.',
  };
}

/** A player's complete colours, straight off the board in the snapshot. */
function completeColorsOf(player) {
  return COLOR_KEYS.filter(color =>
    (player?.properties?.[color]?.length || 0) >= (COLORS[color]?.size || 99));
}

function boardRow(player, { points, winner }) {
  const complete = completeColorsOf(player);
  const held = COLOR_KEYS.reduce((n, c) => n + (player.properties?.[c]?.length || 0), 0);
  const row = el('div', {
    class: `win-row${player.id === winner ? ' is-winner' : ''}`
      + `${player.eliminated ? ' is-out' : ''}`,
  }, [
    el('span', { class: 'win-name', text: player.name }),
    el('span', { class: `win-sets${points ? ' is-decider' : ''}`,
      text: `${player.completedSets} set${player.completedSets === 1 ? '' : 's'}` }),
    el('span', { class: 'win-marks' }, complete.map(color =>
      el('span', { class: 'brief-swatch', dataset: { color },
        attrs: { title: COLORS[color].name } }))),
    el('span', { class: `win-worth${points ? ' is-decider' : ''}`,
      text: `${player.netWorth}M` }),
  ]);
  row.appendChild(el('span', {
    class: 'win-detail',
    text: player.eliminated
      ? 'scooped'
      : `${held} propert${held === 1 ? 'y' : 'ies'} · bank ${player.bankValue}M`
        + (player.upgradeValue ? ` · upgrades ${player.upgradeValue}M` : ''),
  }));
  return row;
}

function renderWin() {
  const overlay = $('win-overlay');
  const snap = store.snapshot;
  if (!overlay) return;
  if (!snap || snap.phase !== 'finished') { setHidden(overlay, true); return; }

  const copy = endingCopy(snap);
  setText($('win-title'), copy.title);
  setText($('win-reason'), copy.reason);

  const summary = $('win-summary');
  clear(summary);
  summary.appendChild(el('div', { class: 'win-tag', text: copy.tag }));
  summary.appendChild(el('div', { class: 'win-head' }, [
    el('span', { text: 'FINAL BOARDS' }),
    el('span', { class: 'win-head-cols', text: 'SETS · NET' }),
  ]));

  const ranked = [...snap.players].sort((a, b) =>
    (a.id === snap.winner ? -1 : b.id === snap.winner ? 1 : 0)
    || (b.completedSets - a.completedSets)
    || (b.netWorth - a.netWorth));
  for (const player of ranked) {
    summary.appendChild(boardRow(player, { points: !!copy.points, winner: snap.winner }));
  }

  const stats = snap.stats;
  if (stats) {
    summary.appendChild(el('div', {
      class: 'win-stats',
      text: `${stats.turns} turns · ${stats.payments.count} payments · `
        + `biggest ${stats.payments.biggest}M · deck cycled ${snap.deckCycle || 0}×`,
    }));
  }
  $('btn-rematch').disabled = store.room.hostId !== store.self.id;
  setHidden(overlay, false);
}

export function mount() {
  help.mount();
  settings.mount();
  hints.mount();

  pointer.registerActions({
    help: () => help.show(),
    rematch: () => send.rematch(),
    'leave-room': () => {
      send.leaveRoom();
      closeSheet();
      setHidden($('win-overlay'), true);
      location.href = location.pathname;
    },
  });
  bus.on(EVENTS.STATE_APPLIED, renderWin);

  // `/#help` is a deep link into the brief. hashchange matters as much as load:
  // navigating from `/?harness=1` to `/?harness=1#help` changes only the hash,
  // so the document is never re-created and boot() never runs again — which is
  // why tools/screenshot.mjs's `help` shot was capturing the home screen.
  const openFromHash = () => { if (location.hash === '#help') help.show(); };
  window.addEventListener('hashchange', openFromHash);
  if (location.hash === '#help') queueMicrotask(openFromHash);
}
