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
import { COLORS, COLOR_KEYS, isComplete } from '../core/cards.js';
import * as sel from '../state/selectors.js';
import { activeRules } from './ruleset.js';
import * as pointer from '../interact/pointer.js';
import * as screens from './screens.js';
import { closeSheet, sheetOpen } from './screens.js';
import * as help from './help.js';
import * as settings from './settings.js';
import * as hints from './hints.js';
// main.js is architect-owned (§1) and already delegates the ui/ sub-mounts to
// this file (help, settings, hints). The P8 surfaces join them here.
import * as discard from './discard.js';
import * as journal from './journal.js';

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

/**
 * WHICH of the three tiebreaks actually decided it. endInStalemate() computes
 * this against the runner-up and publishes it as `stalemateBasis` (and on the
 * `stalemate` event as `basis`) — before that the screen said "most sets wins"
 * even when the game had been settled on net worth or on seat order, which is
 * the kind of quiet lie §3.9 exists to stop.
 */
function stalemateBasis(snap) {
  if (snap.stalemateBasis) return snap.stalemateBasis;
  for (let i = (snap.events || []).length - 1; i >= 0; i--) {
    if (snap.events[i].t === 'stalemate') return snap.events[i].basis || null;
  }
  return null;
}

function basisSentence(basis, player) {
  const sets = player?.completedSets ?? 0;
  switch (basis) {
    case 'sets':
      return `Most completed sets took it — ${player?.name || 'the winner'} finished on ${sets}.`;
    case 'net_worth':
      return `${player?.name || 'The winner'} tied on ${sets} set${sets === 1 ? '' : 's'} and `
        + `won on net worth, ${player?.netWorth ?? 0}M.`;
    case 'turn_order':
      return 'The table tied on completed sets AND on net worth, so the earliest seat took it '
        + '— the third and last tiebreak.';
    case 'unopposed':
      return `${player?.name || 'The winner'} was the only player left standing when the `
        + 'cards ran out.';
    default:
      return `Most completed sets wins — ${player?.name || 'the winner'} took it with ${sets}, `
        + `net worth ${player?.netWorth ?? 0}M breaking any tie, and seat order after that.`;
  }
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
      // endInStalemate(): ranked by completedSets, then playerNetWorth, then
      // seat order — and it now says WHICH of the three decided it.
      reason: (cause === 'deck_cycles'
        // endTurn(): shuffleCount >= DECK_CYCLE_LIMIT.
        ? `The discard was reshuffled into the deck ${snap.deckCycleLimit || 16} times with `
          + 'nobody closing it out, so the game went to points. '
        // endTurn(): _idleTurns >= activeCount with deck and discard both empty.
        : 'Deck and discard both ran dry and a full round passed with nobody playing a card '
          + 'out of hand, so the game went to points. ')
        + basisSentence(stalemateBasis(snap), player),
      points: true,
      basis: stalemateBasis(snap),
    };
  }
  // 'sets' — syncSets() under 'instant', resolveFinalApproach() at the armed
  // player's own turn start under the two grace rules. P8: the screen used to
  // claim "FINAL APPROACH HELD" for every set win, including Blitz games where
  // nothing was ever armed.
  const active = activeRules();
  if (active.winRule === 'instant') {
    return {
      title: mine ? 'MISSION ACCOMPLISHED' : `${seatName(winner)} WINS`,
      tag: 'SETS COMPLETE',
      reason: `Completed ${active.setsToWin} sets. Under this ruleset that ends the game `
        + 'the moment it happens — there was no window to break it.',
    };
  }
  return {
    title: mine ? 'MISSION ACCOMPLISHED' : `${seatName(winner)} WINS`,
    tag: 'FINAL APPROACH HELD',
    reason: `Held ${active.setsToWin} complete sets through the whole grace window and `
      + 'converted at their own turn start. Nobody broke the approach.',
  };
}

/**
 * A player's complete colours, straight off the board in the snapshot.
 *
 * These swatches are printed on the same row as the engine's own
 * `completedSets` count, so they have to be counted the engine's way.
 * `length >= size` is only zoneIsSet() (game.js:351-356) with pureSetRequired
 * OFF: under MD Faithful a full zone of nothing but wilds is NOT a set, and the
 * row would have shown three swatches beside the number 2.
 */
function completeColorsOf(player) {
  const rules = sel.activeRuleFlags();
  return COLOR_KEYS.filter(color => isComplete(player, color, rules));
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

/* ── when the scrim is allowed to arrive (§P7.1) ───────────────────────────
 *
 * MEASURED before this existed: state applied → #win-overlay visible at +1ms,
 * but the `win` FX cue and the fanfare fired at +388ms. The overlay — z-index
 * 95 over rgba(2,5,10,.9) — therefore opened 387ms BEFORE its own celebration
 * and covered the table for all of it. The choreographer already calls
 * flight.finishAll() on `win` precisely so "the overlay must not open over
 * moving cards"; the overlay was simply not listening.
 *
 * So: build the content on STATE_APPLIED, unhide on the CHOREOGRAPHER's word.
 *   • CELEBRATION_MS — fx/index.js CUE.WIN adds 0.60 trauma to #table, and
 *     fx/shake.js DECAY is 1.5 trauma/s, so the shake runs 400ms. The gold
 *     flash is 0.8s. The audio agent retimed the fanfare to RESOLVE at 270ms
 *     (P7) precisely so the resolution lands on a visible table, with its held
 *     fifth and confetti crackle running to 1.18s as deliberate tail. 850ms
 *     covers the shake, the flash and the resolution, and leaves the tail —
 *     plus the confetti (3.2s life at z-index 97, above the scrim) — ringing
 *     under the overlay, which is where they read best.
 *   • A snapped state (reconnect, fixture injection) had no celebration to
 *     wait for — show it at once, or a reconnect into a finished game stares
 *     at a dead table.
 *   • FALLBACK_MS is the promise that the screen can never be lost: if no cue
 *     ever arrives the overlay opens anyway.
 */
const CELEBRATION_MS = 850;
const FALLBACK_MS = 2600;

let pending = false;
let showTimer = 0;

function clearPending() {
  pending = false;
  clearTimeout(showTimer);
  showTimer = 0;
  window.removeEventListener('pointerdown', skipHold, true);
}

function reveal() {
  const overlay = $('win-overlay');
  clearPending();
  if (overlay) setHidden(overlay, false);
}

/** The player is allowed to be impatient: a tap during the hold opens it now. */
function skipHold() { if (pending) reveal(); }

function armReveal(delay) {
  if (!pending) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(reveal, delay);
}

function renderWin(payload) {
  const overlay = $('win-overlay');
  const snap = store.snapshot;
  if (!overlay) return;
  if (!snap || snap.phase !== 'finished') { clearPending(); setHidden(overlay, true); return; }

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

  // §P8 recap: "how did that actually go?" — the turning points, and, if this
  // player was ever armed, what happened to that approach. Built from the
  // accumulated event journal, not from the 40-line prose tail.
  const recap = journal.recap();
  if (recap) summary.appendChild(recap);

  const stats = snap.stats;
  if (stats) {
    summary.appendChild(el('div', {
      class: 'win-stats',
      text: `${stats.turns} turns · ${stats.payments.count} payments · `
        + `biggest ${stats.payments.biggest}M · deck cycled ${snap.deckCycle || 0}×`,
    }));
  }
  $('btn-rematch').disabled = store.room.hostId !== store.self.id;

  if (!overlay.hidden) return;                 // already up: only the copy changed
  // Nothing to wait for unless a `win`/`stalemate` beat is actually queued to
  // play: a snapped state (reconnect, fixture injection, catch-up drain) has no
  // celebration coming, and holding the screen back for one would be a hang.
  const celebrating = (payload?.events || []).some(ev => ev?.t === 'win' || ev?.t === 'stalemate');
  if (!celebrating) { reveal(); return; }
  if (pending) return;
  pending = true;
  window.addEventListener('pointerdown', skipHold, true);
  armReveal(FALLBACK_MS);
}

export function mount() {
  help.mount();
  settings.mount();
  hints.mount();
  discard.mount();
  journal.mount();

  pointer.registerActions({
    help: () => help.show(),
    rematch: () => send.rematch(),
    // One handler for the HUD's ✕ and the win screen's "Leave room" — they
    // always shared it, and it always failed the same way. The farewell frame
    // is written before the socket closes (screens.endSession → socket.flush),
    // so the server really does free the seat: a finished game loses the seat,
    // a game in progress hands it to a bot.
    'leave-room': () => screens.endSession({
      farewell: () => send.leaveRoom(),
      message: 'You left the room',
    }),
  });
  bus.on(EVENTS.STATE_APPLIED, renderWin);

  // The choreographer's word, not the store's (§P7.1). `win`/`stalemate` are the
  // last events it plays, and it calls flight.finishAll() on both, so by the
  // time this fires the table is settled and the celebration has started.
  bus.on(EVENTS.CHOREO_EVENT, (ev) => {
    if (!pending) return;
    if (ev?.t === 'win' || ev?.t === 'stalemate') armReveal(CELEBRATION_MS);
  });
  // Belt and braces: a catch-up drain can swallow the event (choreographer
  // skips cinematics when it is behind) and still reaches idle.
  bus.on(EVENTS.CHOREO_IDLE, () => armReveal(CELEBRATION_MS));

  // `/#help` is a deep link into the brief. hashchange matters as much as load:
  // navigating from `/?harness=1` to `/?harness=1#help` changes only the hash,
  // so the document is never re-created and boot() never runs again — which is
  // why tools/screenshot.mjs's `help` shot was capturing the home screen.
  // Symmetric: the hash leaving must close what its arrival opened, or a
  // same-document navigation away from #help strands the sheet open.
  const syncFromHash = () => { if (location.hash === '#help') help.show(); else if (sheetOpen()) closeSheet(); };
  window.addEventListener('hashchange', syncFromHash);
  if (location.hash === '#help') queueMicrotask(() => syncFromHash());
}
