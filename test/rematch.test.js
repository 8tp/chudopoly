const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const handlers = require('../server/handlers');

test('host rematch preserves the room roster and creates a fresh game', () => {
  const ws = { readyState:1, send() {} };
  const players = [
    { id:'host', name:'Host', resumeToken:'secret', ws },
    { id:'bot', name:'Viper', isBot:true, botMode:'neutral', ws:null },
  ];
  const oldState = G.createGame(players.map(({ id, name }) => ({ id, name })));
  oldState.phase = 'finished';
  oldState.winner = 'host';
  const room = { code:'ABCD', phase:'playing', hostId:'host', players, state:oldState, chat:[], turnTimeout:0, responseTimeout:30 };
  const rooms = new Map([['ABCD', room]]);
  let broadcasts = 0;
  handlers.init({
    G,
    Bot:{},
    broadcast:{ send() {}, broadcastAndScheduleBot() { broadcasts++; } },
    timers:{ clearTurnTimer() {}, startTurnTimer() {}, startResponseTimer() {}, clearResponseTimer() {} },
    absent:{}, rooms, globalChat:[], CHAT_MAX:50, chatIdRef:{ value:0 },
    genCode:() => 'EFGH', genId:() => 'id', genResumeToken:() => 'token', wss:{ clients:[] },
  });

  handlers.handleMessage(ws, { type:'rematch' }, { playerId:'host', roomCode:'ABCD' });

  assert.notEqual(room.state, oldState);
  assert.equal(room.state.phase, 'playing');
  assert.equal(room.state.winner, null);
  assert.deepEqual(room.state.players.map(player => player.id), ['host', 'bot']);
  assert.equal(broadcasts, 1);
});
