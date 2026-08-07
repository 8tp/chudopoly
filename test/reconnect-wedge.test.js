// test/reconnect-wedge.test.js — a resume must never leave the table with nobody to move.
//
// OWNER BUG, 2026-08-07: "I tabbed out of a bot game earlier went back in and everything
// really froze and doesnt let me play cards."
//
// The mechanism has nothing to do with the tab. Tabbing out (a frozen renderer that stops
// answering the server's 15s WebSocket ping, a sleeping laptop, a wifi blip) drops the
// socket; server/handlers.js handleClose hands the seat to a bot; net/socket.js reconnects
// 2s later with the stored resume token; handlers.js reclaimFromBot then calls
// Bot.cancelBotTimeout(room).
//
// There is exactly ONE bot timeout per room (bot.js `room._botTimeout`), so that cancel
// also throws away the move whichever OTHER bot currently holds the turn was about to make
// — and the reclaim paths finished with broadcastRoom(), which does not schedule. Nothing
// else ever can: every path that schedules a bot is reached by a legal move from the
// current player, and the current player is a bot that will never move again. The room
// stops on that bot's turn for good, and a reload does not help (the second reclaim is a
// no-op, so it schedules nothing either).
//
// The invariant, stated so it cannot rot: AFTER A RESUME, A ROOM WHOSE TURN IS HELD BY A
// BOT MUST HAVE A BOT MOVE SCHEDULED. It is asserted here against the real modules rather
// than over a socket, because the wire can only see the symptom (a frozen eventSeq) and
// only after waiting out a bot's think-time, which is a flake waiting to happen.

const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../game');
const Bot = require('../bot');
const broadcast = require('../server/broadcast');
const timers = require('../server/timers');
const absent = require('../server/absent');
const handlers = require('../server/handlers');

const rooms = new Map();

function initModules() {
  broadcast.init({ G, Bot });
  timers.init({ G, Bot, broadcast });
  absent.init({ G, broadcast });
  handlers.init({
    G, Bot, broadcast, timers, absent, rooms,
    globalChat: [], CHAT_MAX: 50, chatIdRef: { value: 0 },
    genCode: () => 'TEST', genId: () => `id-${Math.random().toString(16).slice(2)}`,
    genResumeToken: () => `tok-${Math.random().toString(16).slice(2)}`,
    wss: { clients: new Set() },
  });
}

/** A socket that is open enough for broadcast.send and isConnected. */
function fakeSocket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

/** A live Quick Play shape: one human seat, three bots, a game in progress. */
function makeRoom(humanWs) {
  const human = {
    id: 'human-1', name: 'OWNER', ws: humanWs,
    resumeToken: 'resume-token-1',
  };
  const players = [human];
  for (let i = 0; i < 3; i++) {
    players.push({ id: `bot-${i}`, name: `Bot${i}`, ws: null, isBot: true, botMode: 'neutral' });
  }
  const room = {
    code: 'TEST', phase: 'playing', hostId: human.id, players, chat: [],
    turnTimeout: 0, responseTimeout: 45, state: null,
  };
  room.state = G.createGame(players.map(p => ({ id: p.id, name: p.name })), { seed: '1337' });
  rooms.set(room.code, room);
  return { room, human };
}

/** Put the turn on a bot and give that bot a scheduled move, the way every
 *  broadcast does. */
function handTurnToABot(room) {
  room.state.currentPlayerIndex = room.players.findIndex(p => p.isBot);
  room.state.turnPhase = 'play';
  broadcast.broadcastAndScheduleBot(room);
  assert.ok(room._botTimeout, 'setup: a bot holds the turn and its move is scheduled');
}

/** The seat whose turn it is, as the engine sees it. */
function turnHolder(room) {
  return room.state.players[room.state.currentPlayerIndex];
}

function cleanup(room) {
  Bot.cancelBotTimeout(room);
  timers.clearTurnTimer(room);
  rooms.delete(room.code);
}

test.before(initModules);

test('a reconnect that reclaims a seat from a bot leaves the table playable', () => {
  const ws = fakeSocket();
  const { room, human } = makeRoom(ws);
  try {
    handTurnToABot(room);

    // The tab went away: handleClose gives the seat to a bot.
    handlers.handleClose({ playerId: human.id, roomCode: room.code }, ws);
    assert.equal(human.isBot, true, 'the abandoned seat is played by a bot');
    assert.equal(human._wasHuman, true);

    // …and comes back, with the token net/socket.js kept in sessionStorage.
    const ws2 = fakeSocket();
    handlers.handleMessage(ws2, {
      type: 'reconnect', code: room.code, playerId: human.id, resumeToken: human.resumeToken,
    }, { playerId: null, roomCode: null });

    assert.ok(!human.isBot, 'the seat is a human seat again');
    assert.ok(ws2.sent.some(m => m.type === 'joined'), 'the resume was accepted');

    const holder = room.players.find(p => p.id === turnHolder(room).id);
    if (holder?.isBot && room.state.phase === 'playing' && !room.state.pendingAction) {
      assert.ok(room._botTimeout,
        'a bot holds the turn after the resume and has NO move scheduled — the room is '
        + 'wedged: nothing will ever broadcast again and the player cannot act on a turn '
        + 'that is not theirs');
    }
  } finally {
    cleanup(room);
  }
});

test('a rejoin (join_room with the resume token) leaves the table playable too', () => {
  const ws = fakeSocket();
  const { room, human } = makeRoom(ws);
  try {
    handTurnToABot(room);
    handlers.handleClose({ playerId: human.id, roomCode: room.code }, ws);

    const ws2 = fakeSocket();
    handlers.handleMessage(ws2, {
      type: 'join_room', code: room.code, name: 'OWNER',
      playerId: human.id, resumeToken: human.resumeToken,
    }, { playerId: null, roomCode: null });

    assert.ok(ws2.sent.some(m => m.type === 'joined'), 'the rejoin was accepted');
    const holder = room.players.find(p => p.id === turnHolder(room).id);
    if (holder?.isBot && room.state.phase === 'playing' && !room.state.pendingAction) {
      assert.ok(room._botTimeout,
        'a bot holds the turn after the rejoin and has NO move scheduled — the room is wedged');
    }
  } finally {
    cleanup(room);
  }
});
