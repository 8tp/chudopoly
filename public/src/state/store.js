// state/store.js — the single source of client truth.
//
// The snapshot is replaced wholesale by every `state` broadcast; the structured
// event tail is diffed against lastSeq and handed to the choreographer. Nothing
// here mutates the snapshot — the server owns it (§0.1) and the client only
// reads. No window._* globals: everything that used to be one is a field here.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';

export const store = {
  connected: false,
  screen: 'home',                                  // 'home' | 'lobby' | 'game'
  self: { id: null, name: null },
  room: { code: null, phase: 'home', players: [], hostId: null },
  snapshot: null,                                  // getPlayerView() output
  timers: { turn: null, response: null },
  lastSeq: 0,
  lastError: null,
  chat: { room: [], global: [] },
  unread: { room: 0, global: 0 },
};

export function selfPlayer(snapshot = store.snapshot) {
  if (!snapshot || !store.self.id) return null;
  return snapshot.players.find(p => p.id === store.self.id) || null;
}

export function playerById(id, snapshot = store.snapshot) {
  return snapshot?.players.find(p => p.id === id) || null;
}

export function seatName(id) {
  return store.room.players.find(p => p.id === id)?.name
    || playerById(id)?.name
    || 'Unknown';
}

export function isMyTurn(snapshot = store.snapshot) {
  return !!snapshot && snapshot.currentPlayerId === store.self.id && snapshot.phase === 'playing';
}

export function isResponder(snapshot = store.snapshot) {
  return !!snapshot && (snapshot.responders || []).includes(store.self.id);
}

export function setSelf(id, name) {
  store.self.id = id || store.self.id;
  if (name) store.self.name = name;
}

export function setScreen(screen) {
  if (store.screen === screen) return;
  store.screen = screen;
  bus.emit(EVENTS.STATE_SCREEN, screen);
}

export function reset() {
  store.snapshot = null;
  store.room = { code: null, phase: 'home', players: [], hostId: null };
  store.timers = { turn: null, response: null };
  store.lastSeq = 0;
  store.chat = { room: [], global: [] };
  store.unread = { room: 0, global: 0 };
}

/**
 * Apply a server `state` message.
 * @param {object} msg  the broadcast
 * @param {{snap?:boolean, source?:string}} opts  snap forces no animation
 *        (reconnect, fixture injection — §5).
 * @returns {{snapshot:object|null, events:Array, snap:boolean}}
 */
export function applyState(msg, opts = {}) {
  const game = msg?.game || null;
  const previousCode = store.room.code;

  // Fixtures and reconnects arrive without a preceding `joined`. The own-hand
  // view is the only field getPlayerView redacts per seat, so it identifies the
  // seat unambiguously.
  if (game && !storeHasSelfIn(game)) {
    const mine = game.players.find(p => Array.isArray(p.hand));
    if (mine) setSelf(mine.id, mine.name);
  }

  store.room = {
    code: msg?.code || store.room.code,
    phase: msg?.phase || 'lobby',
    players: Array.isArray(msg?.players) ? msg.players : [],
    hostId: msg?.hostId || null,
  };
  store.timers = { turn: msg?.turnTimer || null, response: msg?.responseTimer || null };

  let events = [];
  let snap = !!opts.snap;

  // A different room (fixture injection, rematch into a new room) shares no card
  // identities with the last one, so the event tail is meaningless: snap.
  if (msg?.code && previousCode && msg.code !== previousCode) { snap = true; store.lastSeq = 0; }

  if (game) {
    const tail = Array.isArray(game.events) ? game.events : [];
    const seq = Number(game.eventSeq) || 0;

    if (store.lastSeq === 0) {
      // First sight of this game. If the tail begins at seq 1 we hold the
      // complete history — the opening deal can animate. Anything else
      // (reconnect mid-game, fixture) has no safe prefix: snap.
      snap = snap || !(tail.length && tail[0].seq === 1);
    } else if (seq < store.lastSeq) {
      snap = true;                                    // rematch: seq restarted
      store.lastSeq = 0;
    } else if (tail.length && tail[0].seq > store.lastSeq + 1) {
      snap = true;                                    // gap: we missed events
    }

    if (!snap) events = tail.filter(ev => ev.seq > store.lastSeq);
    store.lastSeq = seq;
  } else {
    store.lastSeq = 0;
  }

  store.snapshot = game;
  setScreen(game ? 'game' : (store.room.code ? 'lobby' : 'home'));

  const payload = { snapshot: game, room: store.room, events, snap };
  bus.emit(EVENTS.STATE_APPLIED, payload);
  return payload;
}

function storeHasSelfIn(game) {
  return !!store.self.id && game.players.some(p => p.id === store.self.id);
}
