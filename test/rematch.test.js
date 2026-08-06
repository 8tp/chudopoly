const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const handlers = require('../server/handlers');
const broadcast = require('../server/broadcast');
const timers = require('../server/timers');
const absent = require('../server/absent');

// Room with p1 connected, p2 gone, p3 a bot; p1 has demanded 5M from p2.
function stuckRoom() {
  const ws = { readyState:1, send() {} };
  const players = [
    { id:'p1', name:'One', ws },
    { id:'p2', name:'Two', ws:null },
    { id:'p3', name:'Bot', ws:null, isBot:true, botMode:'neutral' },
  ];
  const state = G.createGame(players.map(({ id, name }) => ({ id, name })), { seed:'absent' });
  state.players.forEach(p => { state.deck.push(...p.hand.splice(0), ...p.bank.splice(0)); });
  state.turnPhase = 'play';
  const finance = state.deck.splice(state.deck.findIndex(c => c.action === 'finance_office'), 1)[0];
  state.players[0].hand.push(finance);
  const money = state.deck.splice(state.deck.findIndex(c => c.type === 'money' && c.value === 5), 1)[0];
  state.players[1].bank.push(money);
  const room = {
    code:'ABCD', phase:'playing', hostId:'p1', players, state, chat:[],
    turnTimeout:0, responseTimeout:0,
  };
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2' }).ok);
  return { room, state, money };
}

test('an absent responder is auto-resolved under the unified pending shape', () => {
  broadcast.init({ G, Bot:{ scheduleBotAction() {}, cancelBotTimeout() {} } });
  absent.init({ G, broadcast });
  const { room, state, money } = stuckRoom();
  assert.deepEqual(G.pendingResponders(state), ['p2']);

  absent.handleAbsent(room);

  assert.equal(state.pendingAction, null);
  assert.equal(state.players[0].bank.map(c => c.id).includes(money.id), true);
  assert.deepEqual(G.validateState(state), { ok: true });
});

test('a response timeout auto-accepts the first outstanding responder', () => {
  broadcast.init({ G, Bot:{ scheduleBotAction() {}, cancelBotTimeout() {} } });
  timers.init({ G, Bot:{ cancelBotTimeout() {} }, broadcast:{ broadcastAndScheduleBot() {} } });
  const { room, state, money } = stuckRoom();

  timers.autoResolveResponse(room);

  assert.equal(state.pendingAction, null);
  assert.equal(state.players[0].bank.map(c => c.id).includes(money.id), true);
  assert.deepEqual(G.validateState(state), { ok: true });
});

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
  assert.equal(room.state.events[0].t, 'game_start');
});

test('CHUD_SEED is honoured outside production and refused inside it', () => {
  assert.equal(handlers.seedFromEnv({}), null);
  assert.equal(handlers.seedFromEnv({ CHUD_SEED:'' }), null);
  assert.equal(handlers.seedFromEnv({ CHUD_SEED:'abc', NODE_ENV:'test' }), 'abc');
  assert.equal(handlers.seedFromEnv({ CHUD_SEED:'abc' }), 'abc');
  assert.equal(handlers.seedFromEnv({ CHUD_SEED:'abc', NODE_ENV:'production' }), null);
});
