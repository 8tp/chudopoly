// ui/journal.js — the game record the player can actually read.
//
// OWNER (P8): they lost a final approach they thought they had won and could
// not reconstruct what happened, from the UI or afterwards. The Mission Log was
// a 40-line prose tail in a drawer that is CLOSED BY DEFAULT, so the decisive
// beat — someone breaking your approach, a payment costing you a set card —
// scrolled past unseen while the animation was still running.
//
// Three things here, in the order they matter:
//
//   1. ACCUMULATION. `getPlayerView` ships the last 120 events and the last 40
//      log lines. A long game is far more than that (measured: a 3-player
//      seeded game runs 900–2,600 events), so a client that renders the tail
//      renders a keyhole. Every broadcast is merged by `seq` — monotonic per
//      game — so the journal is the whole game even though no single snapshot
//      is. Gaps (reconnect, a missed broadcast) are RECORDED as gaps rather
//      than papered over; a log that quietly omits things is the exact failure
//      being fixed.
//   2. BEATS, NOT PROSE. Built from `game.events` (§4's structured channel), so
//      each beat knows its actor, its cards and its weight. Set completions,
//      arming, disarming, steals, whole-set seizures, OPSEC blocks, insolvency
//      and the ending are TURNING POINTS and look nothing like a bank or a
//      draw. game.log's prose is kept as a secondary transcript for the handful
//      of lines that have no event (upgrades banked on a break, etc.).
//   3. THE DISARM IS UNMISSABLE. `final_approach_broken` is the specific event
//      that burned the owner, so it also fires a full-width announcement over
//      the felt that does not need the drawer to be open.
//
// Cards named in a beat are real faces through the shipped renderer (the same
// route ui/discard.js takes) and carry `data-peek-card`, so any card in the log
// is readable without leaving it.

import { $, el, clear, setClass, setText, setAttr } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { store, seatName } from '../state/store.js';
import { colorName, cardName, COLORS } from '../core/cards.js';
import { buildFace, refresh } from '../table/cardnode.js';
import * as pointer from '../interact/pointer.js';
import { openSheet, sheetOpen } from './screens.js';
import { detailBody } from './details.js';

/* ── the record ───────────────────────────────────────────────────────────── */

const MAX_BEATS = 900;           // ~a 400-turn game; 24 bytes-ish per beat
const beats = [];                // {seq, ev, turn}
let maxSeq = 0;
let gaps = 0;                    // broadcasts whose tail did not reach maxSeq+1
let turn = 0;

export function reset() {
  beats.length = 0;
  maxSeq = 0;
  gaps = 0;
  turn = 0;
}

/** Merge a broadcast's event tail. Idempotent, ordered, and honest about gaps. */
function ingest(snapshot) {
  const tail = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const seq = Number(snapshot?.eventSeq) || 0;
  // A rematch restarts `eventSeq` at 0; so does a different room.
  if (seq && seq < maxSeq) reset();
  if (!tail.length) return;
  if (maxSeq > 0 && tail[0].seq > maxSeq + 1) gaps++;
  for (const ev of tail) {
    if (!ev || typeof ev.seq !== 'number' || ev.seq <= maxSeq) continue;
    if (ev.t === 'game_start') { reset(); }
    if (ev.t === 'turn_start') turn++;
    beats.push({ seq: ev.seq, ev, turn });
    maxSeq = Math.max(maxSeq, ev.seq);
  }
  if (beats.length > MAX_BEATS) beats.splice(0, beats.length - MAX_BEATS);
}

export function entries() { return beats; }
export function gapCount() { return gaps; }

/* ── weights ──────────────────────────────────────────────────────────────── */

// TURNING POINTS: the beats that change who is winning. These are what the
// owner could not find. Everything else is texture.
const TURNING = new Set([
  'final_approach', 'final_approach_broken', 'set_completed', 'set_stolen',
  'steal', 'swap', 'scoop', 'win', 'stalemate', 'insolvent', 'action_blocked',
]);
const ATTACK = new Set(['rent_charged', 'demand', 'payment', 'opsec', 'play_action']);
const SKIP = new Set(['deal', 'turn_start', 'turn_end', 'final_approach_pending', 'draw']);

function weight(t) {
  if (TURNING.has(t)) return 'turn';
  if (ATTACK.has(t)) return 'attack';
  return 'routine';
}

/* ── beat copy ────────────────────────────────────────────────────────────── */

const who = (id) => seatName(id);
const ACTION_TITLE = {
  rent: 'Rent', finance_office: 'Finance Office', roll_call: 'Roll Call',
  midnight_requisition: 'Midnight Requisition', chud: 'THE CHUD CARD',
  inspector_general: 'Inspector General', tdy_orders: 'TDY Orders',
  opsec: 'OPSEC', upgrade: 'Upgrade', foc: 'FOC', surge_ops: 'Surge Operations',
  pcs_orders: 'PCS Orders',
};

/**
 * One event → a readable line plus the cards it involved.
 * @returns {{text:string, cards:Array, mark:string, color:string|null}|null}
 *   null means "no beat for this event" (the ones SKIP covers, or a shape the
 *   client does not recognise — an unknown event is never invented into prose).
 */
function describe(ev) {
  const me = store.self.id;
  const mine = (id) => id === me;
  const nameOf = (id) => (mine(id) ? 'You' : who(id));
  // "You's whole Space Force set" and "You is on FINAL APPROACH" both shipped
  // before these existed — measured on the arc fixture.
  const poss = (id) => (mine(id) ? 'your' : `${who(id)}'s`);
  const Poss = (id) => (mine(id) ? 'Your' : `${who(id)}'s`);
  const be = (id) => (mine(id) ? 'are' : 'is');
  const s3 = (id, verb) => (mine(id) ? verb : `${verb}s`);
  switch (ev.t) {
    case 'game_start':
      return { text: 'Game start.', cards: [], mark: '▸' };
    case 'shuffle':
      return { text: `Discard reshuffled into the deck — cycle ${ev.cycle || '?'}, `
        + `${ev.deckCount} cards.`, cards: [], mark: '↻' };
    case 'play_money':
      return { text: `${nameOf(ev.actor)} banked ${cardName(ev.card)}.`, cards: [ev.card], mark: '$' };
    case 'play_property':
      return { text: `${nameOf(ev.actor)} played ${cardName(ev.card)} onto ${colorName(ev.color)}.`,
        cards: [ev.card], mark: '▪', color: ev.color };
    case 'banked_property':
      return { text: `${Poss(ev.actor)} ${cardName(ev.card)} had no legal set left and was `
        + 'banked at face value.', cards: [ev.card], mark: '$' };
    case 'play_action':
      return { text: `${nameOf(ev.actor)} played ${ACTION_TITLE[ev.action] || cardName(ev.card)}.`,
        cards: [ev.card], mark: '!' };
    case 'rent_charged': {
      const n = (ev.targets || []).length;
      return { text: `${nameOf(ev.actor)} charged ${ev.amount}M rent on ${colorName(ev.color)}`
        + `${ev.doubled ? ' (DOUBLED)' : ''} — ${n} player${n === 1 ? '' : 's'} billed.`,
      cards: [], mark: '⇢', color: ev.color };
    }
    case 'demand':
      return { text: `${nameOf(ev.actor)} demanded ${ev.amount}M from ${nameOf(ev.target)}`
        + `${ev.doubled ? ' (DOUBLED)' : ''} — ${ACTION_TITLE[ev.reason] || ev.reason}.`,
      cards: [], mark: '⇢' };
    case 'opsec':
      return { text: `${nameOf(ev.actor)} played OPSEC against `
        + `${ACTION_TITLE[ev.action] || ev.action} (depth ${ev.depth}).`,
      cards: ev.card ? [ev.card] : [], mark: '⛨' };
    case 'action_blocked':
      return { text: `${Poss(ev.source)} ${ACTION_TITLE[ev.action] || ev.action} was BLOCKED `
        + `by ${poss(ev.target)} OPSEC.`, cards: [], mark: '⛨' };
    case 'payment': {
      const n = (ev.cards || []).length;
      return { text: `${nameOf(ev.from)} paid ${nameOf(ev.to)} ${ev.total}M `
        + `with ${n} card${n === 1 ? '' : 's'}.`, cards: ev.cards || [], mark: '→' };
    }
    case 'insolvent':
      return { text: `${nameOf(ev.from)} had nothing to pay ${nameOf(ev.to)} with — `
        + 'the debt is written off.', cards: [], mark: '∅' };
    case 'steal':
      return { text: `${nameOf(ev.actor)} took ${cardName(ev.card)} from ${nameOf(ev.from)}`
        + `${ev.action === 'chud' ? ' with THE CHUD CARD' : ''}.`,
      cards: [ev.card], mark: '✂', color: ev.toColor };
    case 'set_stolen':
      return { text: `${nameOf(ev.actor)} SEIZED ${poss(ev.from)} whole `
        + `${colorName(ev.color)} set.`, cards: ev.cards || [], mark: '✂', color: ev.color };
    case 'swap':
      return { text: `${nameOf(ev.actor)} swapped ${cardName(ev.gave)} for `
        + `${poss(ev.target)} ${cardName(ev.took)}.`,
      cards: [ev.gave, ev.took].filter(Boolean), mark: '⇄' };
    case 'upgrade':
      return { text: `${nameOf(ev.actor)} added ${cardName(ev.card)} to ${colorName(ev.color)}.`,
        cards: [ev.card], mark: '▲', color: ev.color };
    case 'upgrade_banked':
      return { text: `${Poss(ev.actor)} ${colorName(ev.color)} set broke — `
        + `${cardName(ev.card)} went to the bank.`, cards: [ev.card], mark: '▽', color: ev.color };
    case 'move_property':
      return { text: `${nameOf(ev.actor)} moved ${cardName(ev.card)} from `
        + `${colorName(ev.from)} to ${colorName(ev.to)}${ev.forced ? ' (forced — no room)' : ''}.`,
      cards: [ev.card], mark: '↔', color: ev.to };
    case 'move_upgrade':
      return { text: `${nameOf(ev.actor)} moved ${cardName(ev.card)} from `
        + `${colorName(ev.from)} to ${colorName(ev.to)}.`, cards: [ev.card], mark: '↔' };
    case 'set_completed':
      return { text: `${nameOf(ev.actor)} COMPLETED ${colorName(ev.color)} — `
        + `${ev.total} set${ev.total === 1 ? '' : 's'}.`, cards: [], mark: '★', color: ev.color };
    case 'final_approach':
      return { text: `${nameOf(ev.actor)} ${be(ev.actor)} on FINAL APPROACH with ${ev.sets} sets — `
        + `${ev.opponentTurnsRemaining ?? '?'} opponent turn`
        + `${ev.opponentTurnsRemaining === 1 ? '' : 's'} to break it.`, cards: [], mark: '⚑' };
    case 'final_approach_broken':
      return { text: `${Poss(ev.actor)} final approach was BROKEN`
        + `${ev.by ? ` by ${nameOf(ev.by)}` : ''}.`, cards: [], mark: '✖' };
    case 'discard': {
      const n = (ev.cards || []).length;
      return { text: `${nameOf(ev.actor)} discarded ${n} card${n === 1 ? '' : 's'} `
        + 'at the hand limit.', cards: ev.cards || [], mark: '▾' };
    }
    case 'scoop':
      return { text: `${nameOf(ev.actor)} SCOOPED OUT — everything they owned went to the `
        + 'discard.', cards: [], mark: '☠' };
    case 'win':
      return { text: `${nameOf(ev.actor)} ${s3(ev.actor, 'WIN')} with ${ev.sets} complete sets.`,
        cards: [], mark: '★' };
    case 'stalemate':
      return { text: `Game ended on points (${ev.reason === 'deck_cycles' ? 'deck cycled out'
        : 'deck and discard dry'}) — ${nameOf(ev.winner)} took it on `
        + `${ev.basis === 'net_worth' ? 'net worth' : ev.basis === 'turn_order' ? 'seat order'
          : 'completed sets'}.`, cards: [], mark: '★' };
    case 'turn_restart':
      return { text: `${Poss(ev.actor)} turn restarted — ${ev.plays} plays.`, cards: [], mark: '↻' };
    default:
      return null;
  }
}

/** Does this beat concern me? Drives the "About me" filter and the emphasis. */
function touchesMe(ev) {
  const me = store.self.id;
  if (!me) return false;
  for (const k of ['actor', 'from', 'to', 'target', 'by', 'source', 'winner']) {
    if (ev[k] === me) return true;
  }
  return Array.isArray(ev.targets) && ev.targets.includes(me);
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function cardChip(card) {
  if (!card || card.id == null) return null;
  return el('button', {
    class: 'jr-card',
    attrs: { type: 'button', 'aria-label': `${cardName(card) || card.name}, ${card.value ?? 0}M` },
    dataset: { action: 'journal-card', card: String(card.id), peekCard: String(card.id) },
  }, [
    card.color && COLORS[card.color]
      ? el('span', { class: 'brief-swatch', dataset: { color: card.color } }) : null,
    el('span', { text: cardName(card) || card.name || 'Card' }),
  ].filter(Boolean));
}

/** One beat as a DOM row. `full` adds the card chips (the drawer is too narrow). */
function beatRow(entry, { full = false } = {}) {
  const d = describe(entry.ev);
  if (!d) return null;
  const w = weight(entry.ev.t);
  const row = el('div', {
    class: `jr-beat is-${w}${touchesMe(entry.ev) ? ' is-mine' : ''}`
      + (entry.ev.t === 'final_approach_broken' ? ' is-alarm' : ''),
    dataset: entry.ev.color && COLORS[entry.ev.color] ? { color: entry.ev.color } : {},
  }, [
    el('span', { class: 'jr-mark', text: d.mark || '·' }),
    el('span', { class: 'jr-body' }, [
      el('span', { class: 'jr-text', text: d.text }),
      full && d.cards.length
        ? el('span', { class: 'jr-cards' }, d.cards.map(cardChip).filter(Boolean))
        : null,
    ].filter(Boolean)),
    full ? el('span', { class: 'jr-turn', text: `T${entry.turn}` }) : null,
  ].filter(Boolean));
  return row;
}

/* ── the live drawer (#log) ───────────────────────────────────────────────── */

let drawnSeq = 0;

function renderDrawer() {
  const box = $('log');
  if (!box) return;
  if (drawnSeq > maxSeq) { clear(box); drawnSeq = 0; }
  for (const entry of beats) {
    if (entry.seq <= drawnSeq) continue;
    drawnSeq = entry.seq;
    if (SKIP.has(entry.ev.t)) continue;
    const row = beatRow(entry);
    if (row) box.appendChild(row);
  }
  while (box.childElementCount > 140) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ── the full log sheet ───────────────────────────────────────────────────── */

const FILTERS = [
  { id: 'turn', label: 'Turning points', keep: (e) => weight(e.ev.t) === 'turn' },
  { id: 'mine', label: 'About me', keep: (e) => touchesMe(e.ev) && !SKIP.has(e.ev.t) },
  { id: 'all', label: 'Everything', keep: (e) => !SKIP.has(e.ev.t) },
  { id: 'prose', label: 'Transcript', keep: () => false },
];

let filter = 'turn';
let host = null;
let reading = null;

function paintSheet() {
  if (!host?.isConnected) return;
  clear(host);

  const rail = el('div', { class: 'brief-tabs', attrs: { role: 'tablist', 'aria-label': 'Log views' } });
  for (const f of FILTERS) {
    rail.appendChild(el('button', {
      class: `brief-tab${filter === f.id ? ' is-on' : ''}`,
      attrs: { type: 'button', role: 'tab', 'aria-selected': filter === f.id ? 'true' : 'false' },
      dataset: { action: 'journal-filter', filter: f.id },
      text: f.label,
    }));
  }
  host.appendChild(rail);

  const panel = el('div', { class: 'jr-panel' });
  host.appendChild(panel);

  const reader = el('div', { class: 'jr-reader', attrs: { id: 'jr-reader' } });
  panel.appendChild(reader);
  paintReader(reader);

  if (gaps) {
    panel.appendChild(el('p', {
      class: 'brief-note',
      text: `${gaps} stretch${gaps === 1 ? '' : 'es'} of this game are missing from the record — `
        + 'the connection dropped or a broadcast was missed, and the server sends only the '
        + 'most recent events. Everything shown below is real.',
    }));
  }

  if (filter === 'prose') {
    const lines = store.snapshot?.log || [];
    panel.appendChild(el('p', { class: 'brief-note',
      text: 'The server\'s own wording, most recent 40 lines. The other tabs are built from '
        + 'the structured event stream and cover the whole game.' }));
    const list = el('div', { class: 'jr-list' });
    for (const line of lines) list.appendChild(el('div', { class: 'jr-prose', text: line }));
    panel.appendChild(list);
    return;
  }

  const f = FILTERS.find(x => x.id === filter) || FILTERS[0];
  // `describe()` returns null for an event this client does not know how to
  // word. Counting those would print "113 beats" over 100 rows.
  const rows = beats.filter(e => f.keep(e) && describe(e.ev));
  panel.appendChild(el('p', { class: 'dv-count',
    text: `${rows.length} beat${rows.length === 1 ? '' : 's'} · oldest first` }));
  const list = el('div', { class: 'jr-list' });
  if (!rows.length) {
    list.appendChild(el('p', { class: 'brief-note', text: 'Nothing here yet.' }));
  }
  for (const entry of rows) {
    const row = beatRow(entry, { full: true });
    if (row) list.appendChild(row);
  }
  panel.appendChild(list);
}

function findCard(id) {
  for (const entry of beats) {
    const d = describe(entry.ev);
    if (!d) continue;
    for (const card of d.cards) if (card && card.id === id) return card;
  }
  return null;
}

function paintReader(reader) {
  clear(reader);
  if (reading == null) return;
  const card = findCard(reading);
  if (!card) { reading = null; return; }
  const face = el('div', { class: 'card jr-face', dataset: { type: card.type || 'unknown' } });
  face.appendChild(buildFace(card));
  refresh(face, card);
  face.removeAttribute('aria-label');
  reader.appendChild(el('div', { class: 'dv-reader-head' }, [
    el('span', { class: 'dv-reader-name', text: cardName(card) || card.name || '' }),
    el('button', {
      class: 'btn btn-icon', text: '✕',
      attrs: { type: 'button', 'aria-label': 'Close the card reader' },
      dataset: { action: 'journal-card', card: String(card.id) },
    }),
  ]));
  reader.appendChild(face);
  const body = detailBody(card);
  if (body) reader.appendChild(body);
}

export function show(which) {
  if (FILTERS.some(f => f.id === which)) filter = which;
  reading = null;
  host = el('div', { class: 'brief jr' });
  openSheet('Mission log', host, { onClose: () => { host = null; reading = null; } });
  paintSheet();
}

export function isOpen() { return !!host?.isConnected && sheetOpen(); }

/* ── the recap (win overlay) ──────────────────────────────────────────────── */

/**
 * "How did that actually go?" — the turning points, plus the specific answer to
 * the question the owner could not answer: if you were ever armed, what
 * happened to that approach.
 * @returns {Element|null}
 */
export function recap() {
  if (!beats.length) return null;
  const me = store.self.id;
  const box = el('div', { class: 'jr-recap' });

  // The approach story first, because it is the one that gets asked about.
  const armings = beats.filter(b => b.ev.t === 'final_approach' && b.ev.actor === me);
  const breaks = beats.filter(b => b.ev.t === 'final_approach_broken' && b.ev.actor === me);
  if (armings.length) {
    const last = breaks[breaks.length - 1];
    const won = store.snapshot?.winner === me;
    box.appendChild(el('p', { class: 'jr-approach' + (won ? ' is-good' : ' is-bad') }, [
      el('b', { text: won ? 'YOUR FINAL APPROACH HELD. ' : 'YOUR FINAL APPROACH DID NOT CONVERT. ' }),
      el('span', {
        text: won
          ? `You armed ${armings.length === 1 ? 'once' : `${armings.length} times`} and converted.`
          : breaks.length
            ? `You armed ${armings.length === 1 ? 'once' : `${armings.length} times`}; it was broken `
              + `${breaks.length === 1 ? 'once' : `${breaks.length} times`}`
              + `${last?.ev.by ? `, last by ${who(last.ev.by)}` : ''}. `
              + 'Losing any complete set disarms you and the grace window restarts at zero.'
            : `You armed ${armings.length === 1 ? 'once' : `${armings.length} times`} but the `
              + 'game ended before your checkpoint came round.',
      }),
    ]));
  }

  const turning = beats.filter(b => weight(b.ev.t) === 'turn');
  // The last 14 turning points: enough to cover the endgame, short enough that
  // the overlay stays one scroll.
  const shown = turning.slice(-14);
  if (!shown.length) return box.childElementCount ? box : null;
  box.appendChild(el('div', { class: 'jr-recap-head', text: 'HOW IT WENT' }));
  const list = el('div', { class: 'jr-list is-recap' });
  for (const entry of shown) {
    const row = beatRow(entry);
    if (row) list.appendChild(row);
  }
  box.appendChild(list);
  if (turning.length > shown.length) {
    box.appendChild(el('button', {
      class: 'btn btn-ghost jr-more',
      text: `Open the full log (${turning.length} turning points)`,
      attrs: { type: 'button' },
      dataset: { action: 'open-log' },
    }));
  }
  return box;
}

/* ── the announcement: a disarm you cannot miss ───────────────────────────── */

// 2600ms: long enough to read two lines out loud, short enough that it is gone
// before the next turn's first card lands (the choreographer caps an event at
// 600ms and a bot turn is ~3 events).
const ANNOUNCE_MS = 2600;
let announceEl = null;
let announceTimer = 0;

function announce(kind, flag, line) {
  if (!announceEl?.isConnected) {
    announceEl = el('div', {
      class: 'announce',
      attrs: { role: 'status', 'aria-live': 'assertive' },
    });
    announceEl.hidden = true;
    ($('app') || document.body).appendChild(announceEl);
  }
  clear(announceEl);
  announceEl.className = `announce is-${kind}`;
  announceEl.appendChild(el('span', { class: 'announce-flag', text: flag }));
  announceEl.appendChild(el('span', { class: 'announce-text', text: line }));
  announceEl.hidden = false;
  requestAnimationFrame(() => setClass(announceEl, 'is-in', true));
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    setClass(announceEl, 'is-in', false);
    announceTimer = setTimeout(() => { if (announceEl) announceEl.hidden = true; }, 260);
  }, ANNOUNCE_MS);
}

/**
 * The beats that must land even with the drawer shut. Deliberately short: an
 * announcement for everything is an announcement for nothing.
 * fx/ already fires an `approach_broken` cue; this is the worded half.
 */
function announceFor(ev) {
  const me = store.self.id;
  if (ev.t === 'final_approach_broken') {
    if (ev.actor === me) {
      announce('bad', 'APPROACH BROKEN',
        `You dropped below the winning set count${ev.by ? ` — ${who(ev.by)} did it` : ''}. `
        + 'You are disarmed; rebuild and the grace window starts over from zero.');
    } else {
      announce('good', 'APPROACH BROKEN',
        `${who(ev.actor)} is disarmed${ev.by && ev.by === me ? ' — you broke it' : ''}.`);
    }
    return;
  }
  if (ev.t === 'final_approach') {
    if (ev.actor === me) {
      announce('mine', 'FINAL APPROACH',
        `You hold ${ev.sets} sets. Hold them through `
        + `${ev.opponentTurnsRemaining ?? '?'} more opponent turn`
        + `${ev.opponentTurnsRemaining === 1 ? '' : 's'} and you win.`);
    } else {
      announce('bad', 'BREAK THEM NOW',
        `${who(ev.actor)} holds ${ev.sets} sets and wins in `
        + `${ev.opponentTurnsRemaining ?? '?'} turn`
        + `${ev.opponentTurnsRemaining === 1 ? '' : 's'} unless a set is broken.`);
    }
    return;
  }
  if (ev.t === 'set_stolen' && ev.from === me) {
    announce('bad', 'SET SEIZED',
      `${who(ev.actor)} took your whole ${colorName(ev.color)} set — Upgrade and FOC included.`);
  }
}

/* ── wiring ───────────────────────────────────────────────────────────────── */

export function mount() {
  pointer.registerActions({
    'open-log': () => show('turn'),
    'journal-filter': (elx) => { filter = elx.dataset.filter || 'turn'; reading = null; paintSheet(); },
    'journal-card': (elx) => {
      const id = Number(elx.dataset.card);
      reading = reading === id ? null : id;
      paintSheet();
      document.getElementById('jr-reader')?.scrollIntoView({ block: 'nearest' });
    },
  });

  installLogButton();

  bus.on(EVENTS.STATE_APPLIED, ({ snapshot }) => {
    ingest(snapshot);
    renderDrawer();
    installLogButton();
    if (isOpen()) paintSheet();
  });

  // The announcement rides the CHOREOGRAPHER, not the snapshot: it must land
  // with the cards it is describing, not 600ms before them.
  bus.on(EVENTS.CHOREO_EVENT, (ev) => { if (ev) announceFor(ev); });
}

/** The drawer is closed by default, so the full log needs a door of its own.
 *  public/index.html is architect-owned (§1); the button is built here. */
function installLogButton() {
  const head = document.querySelector('#side .side-head');
  if (!head || head.querySelector('[data-action="open-log"]')) return;
  const btn = el('button', {
    class: 'btn jr-open',
    text: 'Full log',
    attrs: { type: 'button' },
    dataset: { action: 'open-log' },
  });
  head.insertBefore(btn, head.lastElementChild);
  setAttr(head.firstElementChild, 'title', 'Live feed — "Full log" opens the whole game');
  setText(head.firstElementChild, 'MISSION LOG');
}
