// table/layout.js — the felt: player boards, colour columns, piles.
//
// Boards are STRUCTURE, not content. This file builds the containers once per
// seating change and hands out zone elements; every card that lands in them is
// placed by table/index.js. Rebuilding is keyed on the seat list, so a normal
// turn never touches this code and never orphans a card node mid-FLIP.

import { el, clear, setText, setAttr, setClass } from '../core/dom.js';
import { COLORS, COLOR_KEYS, isComplete } from '../core/cards.js';
import { botLabel } from '../core/bots.js';
import { store } from '../state/store.js';
import * as sel from '../state/selectors.js';

const zones = new Map();          // zoneKey -> element
const boards = new Map();         // playerId -> board element

let seatKey = '';
let selfId = null;
let root = null;

export function zoneEl(key) { return zones.get(key) || null; }
export function boardEl(playerId) { return boards.get(playerId) || null; }
export function allBoards() { return boards; }
export function zoneKeys() { return zones.keys(); }

/**
 * zoneFor(kind, ownerId, color) — the §5 addressing scheme.
 * Own zones get the short key ('bank'); everyone else is suffixed by id. The
 * short form is what tools/touchtest.mjs selects on ([data-zone="bank"],
 * [data-zone^="properties"]), and it keeps CSS for "my side of the table" simple.
 */
export function zoneKeyFor(kind, ownerId, color) {
  const mine = !ownerId || ownerId === selfId;
  switch (kind) {
    case 'deck': return 'deck';
    case 'discard': return 'discard';
    case 'hand': return mine ? 'hand' : `hand:${ownerId}`;
    case 'bank': return mine ? 'bank' : `bank:${ownerId}`;
    case 'properties': return mine ? `properties:${color}` : `properties:${ownerId}:${color}`;
    case 'upgrades': return mine ? `upgrades:${color}` : `upgrades:${ownerId}:${color}`;
    default: return null;
  }
}

export function zoneFor(kind, ownerId, color) {
  return zoneEl(zoneKeyFor(kind, ownerId, color));
}

/**
 * An opponent's empty colour column is `display:none` (table.css hides
 * `.board-opponent .propcol[data-empty="1"]` so a 10-colour board fits a
 * 4-player strip). paintBoard clears the flag — but only at the RECONCILE, at
 * the end of the job, which is after the choreography that put a card there.
 *
 * Measured consequence: a property stolen into a colour the thief did not have
 * yet was reparented into a zero-size box, so table/moveCard's FLIP measured
 * `last` at 0×0, the card flew to viewport (0,0), and the steal_landed cue
 * anchored there too — four of the ten steals in the recorded game fired their
 * red flash in the top-left corner of the screen with no card anywhere near it.
 *
 * A column with a card in it is not empty. Saying so here, at the moment the
 * card arrives, is the truth; reconcile recomputes it either way.
 */
export function revealZone(zone) {
  if (!zone || !zone.closest) return;
  const col = zone.closest('.propcol[data-empty="1"]');
  if (col) col.removeAttribute('data-empty');
}

/**
 * Does this zone belong to the viewing player? Falls out of the key scheme
 * above: my zones are never suffixed with a seat id. Drives the `mine` flag on
 * every FX cue (§7 wants your own cards louder and centred), so it has to be
 * derivable without the caller knowing whose event it was.
 * 'deck' and 'discard' belong to nobody.
 */
export function isMineZone(key) {
  if (!key) return false;
  if (key === 'hand' || key === 'bank') return true;
  const i = key.indexOf(':');
  if (i < 0) return false;                                  // deck / discard
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === 'properties' || kind === 'upgrades') return rest.indexOf(':') < 0;
  return false;                                             // hand:PID / bank:PID
}

export function mount(rootEl, mySeatId) {
  root = rootEl;
  selfId = mySeatId;
  zones.set('deck', document.querySelector('[data-zone="deck"]'));
  zones.set('discard', document.querySelector('[data-zone="discard"]'));
  zones.set('hand', document.querySelector('[data-zone="hand"]'));
}

/**
 * The seat id arrives AFTER mount(): main.js boots the table with
 * store.self.id (null) and only learns the id from the `joined` message.
 *
 * Measured on the bug this exists for (P7 round 1, scratchpad/frames/deal):
 * without it, zoneKeyFor('hand', myId) answered `hand:<uuid>` for the whole
 * opening deal, zoneEl() returned null, moveCard() bailed, and the first
 * 1,916ms of every game was a frozen table reading "DECK 0" followed by 26
 * cards teleporting in at the job-ending reconcile — the first thing a player
 * ever sees, and it did not animate at all.
 *
 * Clearing seatKey rather than trusting it: the key embeds selfId, so a rebuild
 * would happen anyway at the next syncSeats, but zones registered under the old
 * keys are unreachable until then and that is exactly the hole above.
 */
export function setSelf(id) {
  if (id === selfId) return false;
  selfId = id;
  seatKey = '';
  return true;
}

/** Rebuild boards only when the seating changes. Returns true if it rebuilt. */
export function syncSeats(snapshot, mySeatId) {
  if (!root) return false;
  selfId = mySeatId || selfId;
  const players = snapshot?.players || [];
  const key = players.map(p => p.id).join(',') + '|' + selfId;
  if (key === seatKey) return false;
  seatKey = key;

  const opponents = document.getElementById('opponents');
  const selfSlot = document.getElementById('self-board');
  if (!opponents || !selfSlot) return false;

  // Detach every card node before the containers go away, so nothing is
  // destroyed by the clear() — the registry in cardnode.js still owns them and
  // reconcile puts them back this same frame.
  for (const zone of zones.values()) {
    if (!zone || zone.dataset.zone === 'hand') continue;
    while (zone.firstChild) zone.removeChild(zone.firstChild);
  }
  for (const k of [...zones.keys()]) if (k !== 'deck' && k !== 'discard' && k !== 'hand') zones.delete(k);
  boards.clear();
  clear(opponents);
  clear(selfSlot);

  for (const player of players) {
    const isSelf = player.id === selfId;
    const board = buildBoard(player, isSelf);
    boards.set(player.id, board);
    (isSelf ? selfSlot : opponents).appendChild(board);
  }
  return true;
}

function buildBoard(player, isSelf) {
  const board = el('section', {
    class: `board${isSelf ? ' board-self' : ' board-opponent'}`,
    attrs: { 'data-player': player.id, 'data-self': isSelf ? '1' : '0', tabindex: '0' },
  });

  const head = el('div', { class: 'board-head' }, [
    el('span', { class: 'board-name', text: player.name || '' }),
    // WHO IS THIS. server/broadcast.js ships `isBot`/`botMode` on every room
    // player, in the lobby AND for the whole game — the client simply never read
    // it once the table was up, so a seat called "Reaper" that never blocks
    // anything was indistinguishable from a human who never blocks anything.
    // A SPAN, not a button: tools/lib/audit.mjs measures every `button`/
    // `[data-action]` against the 44px floor and a 12px tag in a board head is a
    // gate failure, not an affordance. The full personality is one long-press
    // away (ui/overlays.js botBriefFromEvent) and always in ? → Bots.
    el('span', { class: 'board-bot', attrs: { hidden: true } }),
    el('span', { class: 'board-sets', text: '0/3' }),
    el('span', { class: 'board-worth', text: '0M' }),
  ]);
  board.appendChild(head);

  if (!isSelf) {
    board.appendChild(el('div', {
      class: 'cardzone zone-hand-oppo',
      attrs: { 'data-zone': zoneKeyFor('hand', player.id) },
    }));
    zones.set(zoneKeyFor('hand', player.id), board.lastElementChild);
  }

  const bankWrap = el('div', { class: 'board-bank' }, [
    el('span', { class: 'zone-tag', text: 'BANK' }),
    el('div', { class: 'cardzone zone-bank', attrs: { 'data-zone': zoneKeyFor('bank', player.id) } }),
  ]);
  board.appendChild(bankWrap);
  zones.set(zoneKeyFor('bank', player.id), bankWrap.lastElementChild);

  const props = el('div', { class: 'board-props' });
  for (const color of COLOR_KEYS) {
    const info = COLORS[color];
    const col = el('div', {
      class: 'propcol',
      attrs: { 'data-color': color, 'data-owner': player.id, 'data-empty': '1' },
    });
    col.appendChild(el('div', { class: 'propcol-head' }, [
      el('span', { class: 'propcol-name', text: info.short }),
      el('span', { class: 'propcol-count', text: `0/${info.size}` }),
    ]));
    const cards = el('div', {
      class: 'cardzone zone-props',
      attrs: { 'data-zone': zoneKeyFor('properties', player.id, color) },
    });
    const ups = el('div', {
      class: 'cardzone zone-ups',
      attrs: { 'data-zone': zoneKeyFor('upgrades', player.id, color) },
    });
    col.appendChild(cards);
    col.appendChild(ups);
    props.appendChild(col);
    zones.set(zoneKeyFor('properties', player.id, color), cards);
    zones.set(zoneKeyFor('upgrades', player.id, color), ups);
  }
  board.appendChild(props);
  return board;
}

/** Per-reconcile text/state on the board chrome. All writes guarded. */
export function paintBoard(player, snapshot) {
  const board = boards.get(player.id);
  if (!board) return;
  setText(board.querySelector('.board-name'), player.name);
  // The seat's nature, from the ROOM list (getPlayerView carries no `isBot`; the
  // `state` frame's `players` array does, for the whole game). `data-bot` is also
  // what ui/overlays.js's long-press reads to open that bot's brief.
  const seat = (store.room?.players || []).find(x => x.id === player.id) || null;
  const botTag = board.querySelector('.board-bot');
  if (botTag) {
    if (seat?.isBot) {
      // OWNER DIRECTIVE 2026-08-07: a bot's PERSONALITY is not shown at the
      // table. Knowing a seat is "aggressive" before it has done anything tells
      // you how to play against it for free — you should have to read the table,
      // not the label. The seat still says it is a bot (you can see it never
      // hesitates); `data-bot` stays generic so styling and the long-press brief
      // keep working without leaking the mode.
      setText(botTag, 'BOT');
      botTag.hidden = false;
      setAttr(board, 'data-bot', 'bot');
    } else {
      botTag.hidden = true;
      setAttr(board, 'data-bot', null);
    }
  }
  setText(board.querySelector('.board-sets'), `${player.completedSets}/${snapshot.setsToWin || 3} SETS`);
  setText(board.querySelector('.board-worth'), `${player.netWorth}M`);
  setClass(board, 'is-turn', snapshot.currentPlayerId === player.id && snapshot.phase === 'playing');
  // §3.10 final approach: this player has the sets and the table has one turn
  // cycle to break them. The alarm treatment is table.css's; the fact is the
  // engine's — read the per-player flag, fall back to the game-level list.
  const armed = player.finalApproach != null
    ? !!player.finalApproach
    : Array.isArray(snapshot.armedIds) && snapshot.armedIds.includes(player.id);
  setAttr(board, 'data-final-approach', armed ? '1' : null);
  setClass(board, 'is-out', !!player.eliminated);
  setClass(board, 'is-winner', snapshot.winner === player.id);

  // `is-complete` is the SET badge, and a set is not a full zone.
  //
  // MEASURED under MD Faithful: two "any" wilds in Command is a full 2/2 zone that
  // game.js zoneIsSet() (351-356) refuses, because `pureSetRequired` takes at least
  // one real property. The engine's own `completedSets` beside it on this very board
  // read 0/3 SETS while this column read "2/2" with the complete treatment on it —
  // the number and the swatch it labels, disagreeing, six pixels apart.
  //
  // isComplete() is the client mirror of zoneIsSet(); ui/overlays.js already counts
  // the win screen's swatches with it, and this is the same question asked of the
  // same board, so it is asked the same way.
  const rules = sel.activeRuleFlags();
  for (const color of COLOR_KEYS) {
    const col = board.querySelector(`.propcol[data-color="${color}"]`);
    if (!col) continue;
    const cards = player.properties?.[color] || [];
    const size = COLORS[color].size;
    setAttr(col, 'data-empty', cards.length === 0 ? '1' : null);
    setClass(col, 'is-complete', isComplete(player, color, rules));
    // A zone that is FULL but not a set is its own state, and it is the one a player
    // has to be told about: nothing more can be played there and it still is not a
    // set. Without it the column just reads 2/2 and looks like a bug.
    setClass(col, 'is-fullnotset', cards.length >= size && !isComplete(player, color, rules));
    setText(col.querySelector('.propcol-count'), `${cards.length}/${size}`);
  }
}
