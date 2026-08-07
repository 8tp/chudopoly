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

// The lobby's pending ruleset must not fight the rule that a rematch keeps the ruleset the
// table just played. `set_rules` is refused while a game is LIVE, and startRoomGame re-points
// pendingRules at room.rules on every launch — so pendingRules === rules unless the host has
// deliberately picked something else since the game ended (which they now can: a finished
// room is configurable again). Rematch therefore launches pendingRules: sticky by default,
// and never a picker that says one thing while the table plays another.
test('a rematch replays the agreed ruleset, and the broadcast never reports a stale one', () => {
  const ws = { readyState:1, send() {} };
  const players = [
    { id:'host', name:'Host', resumeToken:'secret', ws },
    { id:'bot', name:'Viper', isBot:true, botMode:'neutral', ws:null },
  ];
  const agreed = G.resolveRules({ preset:'blitz', setsToWin:5 });
  const oldState = G.createGame(players.map(({ id, name }) => ({ id, name })), agreed);
  oldState.phase = 'finished';
  oldState.winner = 'host';
  const room = {
    code:'ABCD', phase:'playing', hostId:'host', players, state:oldState, chat:[],
    turnTimeout:0, responseTimeout:30,
    rules: agreed, winRule: agreed.winRule, pendingRules: agreed,
  };
  const rooms = new Map([['ABCD', room]]);
  handlers.init({
    G,
    Bot:{},
    broadcast:{ send() {}, broadcastAndScheduleBot() {} },
    timers:{ clearTurnTimer() {}, startTurnTimer() {}, startResponseTimer() {}, clearResponseTimer() {} },
    absent:{}, rooms, globalChat:[], CHAT_MAX:50, chatIdRef:{ value:0 },
    genCode:() => 'EFGH', genId:() => 'id', genResumeToken:() => 'token', wss:{ clients:[] },
  });

  handlers.handleMessage(ws, { type:'rematch' }, { playerId:'host', roomCode:'ABCD' });

  assert.deepEqual(room.rules, agreed, 'the ruleset is still sticky across a rematch');
  assert.deepEqual(room.state.rules, agreed, 'and the NEW game really resolved it');
  assert.equal(room.state.winRule, 'instant');
  assert.deepEqual(room.pendingRules, room.rules,
    'the lobby field tracks the live ruleset — it can never shadow it');

  // A second rematch changes nothing: sticky is sticky.
  handlers.handleMessage(ws, { type:'rematch' }, { playerId:'host', roomCode:'ABCD' });
  assert.deepEqual(room.state.rules, agreed);
  assert.deepEqual(room.pendingRules, agreed);
});

test('set_rules cannot touch a room that is already playing, from any seat', () => {
  const sent = [];
  const ws = { readyState:1, send() {} };
  const players = [{ id:'host', name:'Host', resumeToken:'secret', ws }];
  const agreed = G.resolveRules({ preset:'mdFaithful' });
  const room = {
    code:'ABCD', phase:'playing', hostId:'host', players, chat:[],
    state:G.createGame([{ id:'host', name:'Host' }, { id:'bot', name:'Viper' }], agreed),
    turnTimeout:0, responseTimeout:30, rules:agreed, pendingRules:agreed,
  };
  const rooms = new Map([['ABCD', room]]);
  let broadcasts = 0;
  handlers.init({
    G,
    Bot:{},
    broadcast:{ send(_ws, msg) { sent.push(msg); }, broadcastRoom() { broadcasts++; }, broadcastAndScheduleBot() { broadcasts++; } },
    timers:{ clearTurnTimer() {}, startTurnTimer() {}, startResponseTimer() {}, clearResponseTimer() {} },
    absent:{}, rooms, globalChat:[], CHAT_MAX:50, chatIdRef:{ value:0 },
    genCode:() => 'EFGH', genId:() => 'id', genResumeToken:() => 'token', wss:{ clients:[] },
  });

  handlers.handleMessage(ws, { type:'set_rules', preset:'blitz' }, { playerId:'host', roomCode:'ABCD' });
  assert.match(sent.at(-1)?.message || '', /during a game/i, 'the host is refused mid-game');

  handlers.handleMessage(ws, { type:'set_rules', preset:'blitz' }, { playerId:'someone', roomCode:'ABCD' });
  assert.match(sent.at(-1)?.message || '', /only host/i, 'and a non-host is refused, not ignored');

  assert.deepEqual(room.pendingRules, agreed, 'nothing was stored');
  assert.equal(broadcasts, 0, 'and a refusal costs the room no fan-out at all');
});

test('CHUD_SEED is honoured outside production and refused inside it', () => {
  assert.equal(handlers.seedFromEnv({}), null);
  assert.equal(handlers.seedFromEnv({ CHUD_SEED:'' }), null);
  assert.equal(handlers.seedFromEnv({ CHUD_SEED:'abc', NODE_ENV:'test' }), 'abc');
  assert.equal(handlers.seedFromEnv({ CHUD_SEED:'abc' }), 'abc');
  assert.equal(handlers.seedFromEnv({ CHUD_SEED:'abc', NODE_ENV:'production' }), null);
});
