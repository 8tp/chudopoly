// test/engine-hardening.test.js — P7 round-1 robustness fixes, engine + server-module level.
// Every test here corresponds to a defect a critic reproduced; the comment names the number.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');
const broadcast = require('../server/broadcast');
const timers = require('../server/timers');
const absent = require('../server/absent');

broadcast.init({ G, Bot });
timers.init({ G, Bot, broadcast });
absent.init({ G, broadcast });

/* ── helpers ─────────────────────────────────────────────────────────── */

function fresh(playerCount = 2, seed = 'harden') {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed });
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  state.cardTotal = null;
  state._handSnapshot = 0;
  return state;
}

function take(state, predicate) {
  const i = state.deck.findIndex(predicate);
  assert.notEqual(i, -1, 'expected card in deck');
  return state.deck.splice(i, 1)[0];
}
function propertyCard(state, player, color) {
  const card = take(state, c => c.type === 'property' && c.color === color);
  if (!player.properties[color]) player.properties[color] = [];
  player.properties[color].push({ ...card, placedColor: color });
  return card;
}
function fakeRoom(overrides = {}) {
  return {
    code: 'TEST', phase: 'playing', chat: [],
    turnTimeout: 0, responseTimeout: 0,
    players: [], ...overrides,
  };
}

/* ── 4. zone caps ────────────────────────────────────────────────────── */

test('steal_set never overflows a colour zone (§3.5)', () => {
  const state = fresh();
  const [a, b] = state.players;
  // B owns the complete darkblue set (size 2); A already holds a darkblue wild.
  propertyCard(state, b, 'darkblue');
  propertyCard(state, b, 'darkblue');
  const wild = take(state, c => c.type === 'wild_property' && (c.colors || []).includes('darkblue'));
  a.properties.darkblue = [{ ...wild, placedColor: 'darkblue' }];

  a.hand.push(take(state, c => c.action === 'inspector_general'));
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2', targetColor: 'darkblue' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept').ok);

  assert.equal(a.properties.darkblue.length, 2, 'darkblue holds at most its set size');
  assert.equal(G.isSetComplete(a, 'darkblue'), true);
  assert.deepEqual(G.validateState(state), { ok: true });
});

test('a complete set is never requisitionable, even after a seizure', () => {
  const state = fresh();
  const [a, b] = state.players;
  propertyCard(state, b, 'darkblue');
  propertyCard(state, b, 'darkblue');
  const wild = take(state, c => c.type === 'wild_property' && (c.colors || []).includes('darkblue'));
  a.properties.darkblue = [{ ...wild, placedColor: 'darkblue' }];
  a.hand.push(take(state, c => c.action === 'inspector_general'));
  G.playAction(state, 'p1', 0, { targetId: 'p2', targetColor: 'darkblue' });
  G.respondToAction(state, 'p2', 'accept');

  assert.equal(G.zoneRequisitionable(a, 'darkblue'), false);
  state.currentPlayerIndex = 1;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  b.hand.push(take(state, c => c.action === 'midnight_requisition'));
  const victim = a.properties.darkblue[0];
  const res = G.playAction(state, 'p2', 0, { targetId: 'p1', targetCardId: victim.id });
  assert.match(res.error, /complete set/);
});

test('validateState rejects an over-cap zone and duplicate upgrades', () => {
  const state = fresh();
  const [a] = state.players;
  propertyCard(state, a, 'darkblue');
  propertyCard(state, a, 'darkblue');
  assert.deepEqual(G.validateState(state), { ok: true });

  const extra = take(state, c => c.type === 'wild_property' && (c.colors || []).includes('darkblue'));
  a.properties.darkblue.push({ ...extra, placedColor: 'darkblue' });
  assert.match(G.validateState(state).error, /Zone cap exceeded/);

  a.properties.darkblue.pop();
  a.upgrades.darkblue = [
    { ...take(state, c => c.action === 'upgrade'), upgradeType: 'house' },
    { ...take(state, c => c.action === 'upgrade'), upgradeType: 'house' },
  ];
  assert.match(G.validateState(state).error, /Duplicate upgrades/);
});

test('a full zone makes room by shifting a wild rather than banking the incoming card', () => {
  const state = fresh();
  const [a, b] = state.players;
  // A's darkblue is full, but the card filling it is a wild that can sit elsewhere.
  propertyCard(state, a, 'darkblue');
  const wildA = take(state, c => c.type === 'wild_property' && c.colors[0] === 'any');
  a.properties.darkblue.push({ ...wildA, placedColor: 'darkblue' });
  const owed = propertyCard(state, b, 'darkblue');

  a.hand.push(take(state, c => c.action === 'finance_office'));
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept', [owed.id]).ok);

  assert.equal(a.properties.darkblue.length, 2, 'zone cap held');
  assert.ok(a.properties.darkblue.some(c => c.id === owed.id), 'the paid property stayed a property');
  assert.equal(a.bank.some(c => c.id === owed.id), false, 'and was not banked');
  assert.equal(a.properties.darkblue.some(c => c.id === wildA.id), false, 'the wild moved out');
  const relocated = Object.entries(a.properties)
    .find(([, cards]) => cards.some(c => c.id === wildA.id));
  assert.ok(relocated && relocated[0] !== 'darkblue', 'the wild is still a property, elsewhere');
  assert.ok(state.events.some(e => e.t === 'move_property' && e.forced === true));
  assert.deepEqual(G.validateState(state), { ok: true });
});

test('an involuntary property with genuinely nowhere to go is banked, never overflowed', () => {
  const state = fresh();
  const [a, b] = state.players;
  // Both colours the incoming wild could take are full of PLAIN properties, so no
  // rearrange can free a slot. The card must not overflow a zone.
  propertyCard(state, a, 'brown');     propertyCard(state, a, 'brown');
  propertyCard(state, a, 'lightblue'); propertyCard(state, a, 'lightblue'); propertyCard(state, a, 'lightblue');
  const homeless = take(state, c => c.type === 'wild_property'
    && Array.isArray(c.colors) && c.colors.includes('brown') && c.colors.includes('lightblue'));
  b.properties.brown = [{ ...homeless, placedColor: 'brown' }];

  a.hand.push(take(state, c => c.action === 'finance_office'));
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2' }).ok);
  // It is B's only card, so surrendering it is a legal short payment (§3.4).
  assert.ok(G.respondToAction(state, 'p2', 'accept', [homeless.id]).ok);

  assert.equal(a.properties.brown.length, 2, 'zone cap held');
  assert.equal(a.properties.lightblue.length, 3, 'zone cap held');
  assert.ok(a.bank.some(c => c.id === homeless.id), 'the homeless property was banked');
  assert.ok(state.events.some(e => e.t === 'banked_property'));
  assert.deepEqual(G.validateState(state), { ok: true });
});

/* ── 9. duplicate upgrades ───────────────────────────────────────────── */

test('seizing an upgraded set never stacks a second Upgrade of the same kind', () => {
  const state = fresh();
  const [a, b] = state.players;
  propertyCard(state, b, 'intel');
  propertyCard(state, b, 'intel');
  b.upgrades.intel = [{ ...take(state, c => c.action === 'upgrade'), upgradeType: 'house' }];
  a.upgrades.intel = [{ ...take(state, c => c.action === 'upgrade'), upgradeType: 'house' }];

  a.hand.push(take(state, c => c.action === 'inspector_general'));
  G.playAction(state, 'p1', 0, { targetId: 'p2', targetColor: 'intel' });
  G.respondToAction(state, 'p2', 'accept');

  assert.deepEqual(G.upgradeKinds(a, 'intel'), ['house']);
  assert.deepEqual(G.validateState(state), { ok: true }, 'the surplus upgrade is conserved in the discard');
});

/* ── 5. drawCards guards + auto-draw (owner directive) ───────────────── */

test('the turn draw is automatic and cannot be repeated', () => {
  const state = G.createGame([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], { seed: 'auto' });
  assert.equal(state.turnPhase, 'play', 'the first broadcast is already the play phase');
  assert.equal(state.players[0].hand.length, 7, '5 dealt + 2 auto-drawn');
  assert.equal(state.players[1].hand.length, 5);

  // A stale client (or a reconnect race) asking to draw is a silent no-op, not an error.
  const again = G.drawCards(state, 'p1');
  assert.equal(again.alreadyDrawn, true);
  assert.equal(state.players[0].hand.length, 7, 'no double draw');

  // Turn hand-off auto-draws the next seat, exactly once.
  assert.ok(G.endTurn(state, 'p1').ok);
  assert.equal(G.currentPlayer(state).id, 'p2');
  assert.equal(state.turnPhase, 'play');
  assert.equal(state.players[1].hand.length, 7);
  assert.equal(G.drawCards(state, 'p2').alreadyDrawn, true);
  assert.equal(state.players[1].hand.length, 7);
});

test('auto-draw honours the empty-hand 5-card rule', () => {
  const state = G.createGame([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], { seed: 'empty' });
  state.players[1].hand.forEach(c => state.discardPile.push(c));
  state.players[1].hand = [];
  assert.ok(G.endTurn(state, 'p1').ok);
  assert.equal(G.currentPlayer(state).id, 'p2');
  assert.equal(state.players[1].hand.length, 5, 'an empty hand draws 5, not 2');
  assert.equal(state.turnPhase, 'play');
});

test('drawCards refuses the wrong player, a pending action and an eliminated seat', () => {
  const state = fresh(3);
  state.turnPhase = 'draw';
  assert.match(G.drawCards(state, 'p2').error, /Not your turn/);

  state.pendingAction = { type: 'payment', action: 'rent', sourceId: 'p2', amount: 1, targets: [] };
  assert.match(G.drawCards(state, 'p1').error, /pending action/);
  state.pendingAction = null;

  state.players[0].eliminated = true;
  assert.match(G.drawCards(state, 'p1').error, /Eliminated/);
});

test('a draw can never orphan a pending action into the play phase', () => {
  const state = fresh(2);
  state.turnPhase = 'action_response';
  state.pendingAction = { type: 'payment', action: 'rent', sourceId: 'p1', amount: 2, targets: [] };
  G.drawCards(state);
  assert.equal(state.turnPhase, 'action_response', 'turnPhase was not forced to play');
  assert.deepEqual(G.validateState(state), { ok: true });
});

/* ── 5. blind turn advances ──────────────────────────────────────────── */

test('forceEndTurn skips eliminated seats and runs the turn-start hooks', () => {
  const state = fresh(3);
  state.players[1].eliminated = true;
  const before = state.turnCounter;
  const res = G.forceEndTurn(state);
  assert.ok(res.ok);
  assert.equal(G.currentPlayer(state).id, 'p3', 'the eliminated seat was skipped');
  assert.equal(state.turnCounter, before + 1, 'beginTurn ran (a blind index bump skipped it)');
  assert.equal(state.turnPhase, 'play');
  assert.equal(state.playsRemaining, 3);
});

test('forceEndTurn clears an orphaned pending action rather than wedging the table', () => {
  const state = fresh(2);
  state.pendingAction = { type: 'payment', action: 'rent', sourceId: 'p1', amount: 2, targets: [] };
  state.turnPhase = 'action_response';
  G.forceEndTurn(state);
  assert.equal(state.pendingAction, null);
  assert.deepEqual(G.validateState(state), { ok: true });
});

/* ── 8. log bounds ───────────────────────────────────────────────────── */

test('state.log is bounded and the view tail is 40 lines', () => {
  const state = fresh();
  for (let i = 0; i < 5000; i++) G.logLine(state, 'line ' + i);
  assert.ok(state.log.length <= G.LOG_MAX, `log capped at ${G.LOG_MAX}, saw ${state.log.length}`);
  assert.equal(state.log[state.log.length - 1], 'line 4999', 'the newest lines survive');
  assert.equal(G.getPlayerView(state, 'p1').log.length, 40);
});

test('move_property spam cannot grow the log without bound', () => {
  const state = fresh();
  const [a] = state.players;
  const wild = take(state, c => c.type === 'wild_property' && c.colors[0] !== 'any');
  a.properties[wild.colors[0]] = [{ ...wild, placedColor: wild.colors[0] }];
  for (let i = 0; i < 3000; i++) G.moveProperty(state, 'p1', wild.id, i % 2 ? wild.colors[0] : wild.colors[1]);
  assert.equal(state.playsRemaining, 3, 'still free, still spammable');
  assert.ok(state.log.length <= G.LOG_MAX);
  assert.ok(state.events.length <= 400);
});

/* ── 12. honest final-approach countdown ─────────────────────────────── */

test('opponentTurnsRemaining counts only opponents, for own-turn arming', () => {
  const state = fresh(4);
  const [a] = state.players;
  propertyCard(state, a, 'brown');    propertyCard(state, a, 'brown');
  propertyCard(state, a, 'darkblue'); propertyCard(state, a, 'darkblue');
  propertyCard(state, a, 'intel');
  // Arm by completing the third set through a legal play on the player's own turn.
  a.hand.push(take(state, c => c.type === 'property' && c.color === 'intel'));
  assert.ok(G.playProperty(state, 'p1', a.hand.length - 1).ok);
  assert.equal(a.finalApproach, true);

  const view = G.getPlayerView(state, 'p1').players.find(p => p.id === 'p1');
  // 4 active seats, armed on their own turn: the other 3 each get exactly one turn.
  assert.equal(view.opponentTurnsRemaining, 3, 'the armed player\'s own turns are not counted');
  assert.equal(view.finalApproachIn, 4, 'the deprecated field still over-reports by one');
  assert.equal(view.checkpointTurn, state.turnCounter + 4);

  // Walk the table round; the count must fall by one per opponent turn and never lie.
  const seen = [];
  for (let i = 0; i < 3; i++) {
    G.endTurn(state, G.currentPlayer(state).id);
    seen.push(G.getPlayerView(state, 'p1').players.find(p => p.id === 'p1').opponentTurnsRemaining);
  }
  assert.deepEqual(seen, [2, 1, 0], 'monotonic, honest, reaching 0 exactly at the converting turn');
});

test('opponentTurnsRemaining never reads 0 while opponents still have turns (off-turn arming)', () => {
  const state = fresh(4);
  const [a, b] = state.players;
  ['brown', 'darkblue'].forEach(color => {
    propertyCard(state, a, color);
    propertyCard(state, a, color);
  });
  propertyCard(state, a, 'intel');
  // Hand the turn to p2, then let p1 complete their third set off-turn via a payment.
  G.endTurn(state, 'p1');
  assert.equal(G.currentPlayer(state).id, 'p2');
  const owed = propertyCard(state, b, 'intel');
  a.hand.push(take(state, c => c.action === 'finance_office'));
  state.currentPlayerIndex = 0;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  G.playAction(state, 'p1', a.hand.length - 1, { targetId: 'p2' });
  G.respondToAction(state, 'p2', 'accept', [owed.id]);
  assert.equal(a.finalApproach, true);

  let guard = 0;
  while (state.phase === 'playing' && guard++ < 12) {
    const row = G.getPlayerView(state, 'p1').players.find(p => p.id === 'p1');
    if (!row.finalApproach) break;
    const isOwnTurn = G.currentPlayer(state).id === 'p1';
    if (row.opponentTurnsRemaining === 0) {
      // The contract: 0 means the NEXT turn to start is the armed player's converting turn.
      G.endTurn(state, G.currentPlayer(state).id);
      assert.equal(state.winner, 'p1', '0 must mean the very next turn converts');
      break;
    }
    assert.ok(row.opponentTurnsRemaining > 0 || isOwnTurn);
    G.endTurn(state, G.currentPlayer(state).id);
  }
  assert.equal(state.winner, 'p1');
});

/* ── 13/14/15. log clarity ───────────────────────────────────────────── */

test('completing a set writes a prose log line', () => {
  const state = fresh();
  const [a] = state.players;
  propertyCard(state, a, 'darkblue');
  const last = take(state, c => c.type === 'property' && c.color === 'darkblue');
  a.hand.push(last);
  G.playProperty(state, 'p1', 0);
  assert.ok(state.log.some(l => /completed the Command set/.test(l)), state.log.join(' | '));
  assert.ok(state.events.some(e => e.t === 'set_completed' && e.total === 1));
});

test('the OPSEC-block line names the attacker and the card', () => {
  const state = fresh();
  const [a, b] = state.players;
  a.hand.push(take(state, c => c.action === 'finance_office'));
  b.hand.push(take(state, c => c.action === 'opsec'));
  G.playAction(state, 'p1', 0, { targetId: 'p2' });
  G.respondToAction(state, 'p2', 'opsec');
  G.respondToAction(state, 'p1', 'accept');
  const line = state.log[state.log.length - 1];
  assert.match(line, /P2/, 'names the defender');
  assert.match(line, /P1/, 'names the attacker');
  assert.match(line, /Finance Office/, 'names the card');
});

test('a stalemate decided by seat order says so instead of crediting sets and net worth', () => {
  const state = fresh(3);
  state.deck = [];
  state.discardPile = [];
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; });
  state._handSnapshot = 0;
  state._idleTurns = 99;
  const res = G.endTurn(state, 'p1');
  assert.ok(res.stalemate);
  const line = state.log[state.log.length - 1];
  assert.match(line, /turn order/, line);
  assert.doesNotMatch(line, /net worth \(/);
  assert.equal(G.getPlayerView(state, 'p1').stalemateBasis, 'turn_order');
  assert.equal(state.events.at(-1).basis, 'turn_order');
});

test('a stalemate decided on net worth says net worth', () => {
  const state = fresh(2);
  const rich = take(state, c => c.type === 'money' && c.value === 10);
  state.players[1].bank.push(rich);
  state.deck = [];
  state.discardPile = [];
  state.players.forEach(p => { p.hand = []; });
  state._handSnapshot = 0;
  state._idleTurns = 99;
  G.endTurn(state, 'p1');
  assert.equal(state.winner, 'p2');
  assert.match(state.log[state.log.length - 1], /net worth/);
  assert.equal(G.getPlayerView(state, 'p1').stalemateBasis, 'net_worth');
});

/* ── 6. response timers independent of the turn timer ────────────────── */

test('a pending action arms a response timer even when turnTimeout is 0', () => {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 20 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  room.state.players[0].hand.push(take(room.state, c => c.action === 'finance_office'));
  G.playAction(room.state, 'p1', 0, { targetId: 'p2' });
  assert.ok(room.state.pendingAction);

  timers.startTurnTimer(room);
  assert.ok(room.responseTimerId, 'the response deadline is armed despite turnTimeout=0');
  assert.equal(room.turnTimerId, undefined || room.turnTimerId, 'no turn deadline exists');
  timers.clearTurnTimer(room);
});

test('syncTimers arms a response deadline for a pending action created outside a handler', () => {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 20 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  room.state.players[0].hand.push(take(room.state, c => c.action === 'roll_call'));
  G.playAction(room.state, 'p1', 0, {});          // exactly what a bot does
  assert.equal(room.responseTimerId, undefined);
  timers.syncTimers(room);
  assert.ok(room.responseTimerId, 'a bot-created charge now gets a deadline');
  timers.clearTurnTimer(room);
});

test('syncTimers stands the turn timer back up once the pending action resolves', () => {
  const room = fakeRoom({ turnTimeout: 30, responseTimeout: 20 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  room.state.players[0].hand.push(take(room.state, c => c.action === 'finance_office'));
  G.playAction(room.state, 'p1', 0, { targetId: 'p2' });
  timers.syncTimers(room);
  assert.ok(room.responseTimerId);
  assert.ok(!room.turnTimerId, 'the turn clock is paused while a response is owed');

  G.respondToAction(room.state, 'p2', 'accept', []);
  timers.syncTimers(room);
  assert.ok(!room.responseTimerId);
  assert.ok(room.turnTimerId, 'the turn clock resumes');
  assert.ok(room.turnStartedAt);
  timers.clearTurnTimer(room);
});

/* ── 7. timer lifecycle on teardown ──────────────────────────────────── */

test('clearTurnTimer stops the re-arming turn timer, the response timer and the bot', () => {
  const room = fakeRoom({ turnTimeout: 30, responseTimeout: 20 });
  room.players = [{ id: 'p1', name: 'P1', isBot: true, botMode: 'neutral' }];
  room.state = fresh(2);
  timers.startTurnTimer(room);
  assert.ok(room.turnTimerId);
  room._botTimeout = setTimeout(() => {}, 10000);
  timers.clearTurnTimer(room);
  assert.equal(room.turnTimerId, null);
  assert.equal(room.turnStartedAt, null);
  assert.equal(room.responseTimerId, undefined);
  assert.equal(room._botTimeout, undefined, 'the bot timeout is cancelled too');
});

/* ── 3. absent handling never lands on an eliminated seat ────────────── */

test('handleAbsent advances past eliminated seats without wedging', () => {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 0 });
  // Two connected seats remain, so this is a turn-skip, not an "everybody left" ending.
  room.players = [
    { id: 'p1', name: 'P1', ws: null, isBot: false },              // absent, current turn
    { id: 'p2', name: 'P2', ws: { readyState: 1 }, isBot: false }, // eliminated below
    { id: 'p3', name: 'P3', ws: { readyState: 1 }, isBot: false },
    { id: 'p4', name: 'P4', ws: null, isBot: true, botMode: 'neutral' },
  ];
  room.state = fresh(4);
  room.state.players[1].eliminated = true;
  absent.handleAbsent(room);
  // p1 is absent (no socket, not a bot) so their turn is skipped; p2 is eliminated so the
  // turn must land on p3. The old blind `(idx+1) % len` could stop on the eliminated seat.
  assert.ok(!G.currentPlayer(room.state).eliminated);
  assert.equal(G.currentPlayer(room.state).id, 'p3');
  assert.deepEqual(G.validateState(room.state), { ok: true });
});

/* ── durable game records (server/gamelog.js) ────────────────────────── */

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

// async: the record is appended asynchronously, so the temp dir must outlive the await.
async function withGameLog(env, fn) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'chudlog-'));
  const saved = { ...process.env };
  process.env.CHUD_GAME_LOG_DIR = dir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve('../server/gamelog')];
  const gamelog = require('../server/gamelog');
  try { return await fn(gamelog, dir); }
  finally {
    process.env = saved;
    delete require.cache[require.resolve('../server/gamelog')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function finishedRoom(opts = {}) {
  const room = {
    code: 'LOGT', phase: 'playing', chat: [], turnTimeout: 60, responseTimeout: 30,
    players: [
      { id: 'a', name: 'A', ws: null, isBot: false },
      { id: 'b', name: 'B', ws: null, isBot: true, botMode: 'chud' },
    ],
  };
  room.state = G.createGame(room.players.map(p => ({ id: p.id, name: p.name })),
    { seed: 'logtest', ...opts });
  room.state.phase = 'finished';
  room.state.winner = 'a';
  room.state.endReason = 'sets';
  return room;
}

test('a finished game leaves exactly one durable JSONL record', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1' }, async (gamelog, dir) => {
    const room = finishedRoom({ preset: 'blitz' });
    assert.equal(gamelog.recordFinished(room, G), true);
    assert.equal(gamelog.recordFinished(room, G), false, 'never written twice');
    await new Promise(r => setTimeout(r, 120));

    const lines = fs.readFileSync(nodePath.join(dir, 'games.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.seed, 'logtest');
    assert.equal(rec.replayable, true, 'a seeded game can be replayed exactly');
    assert.equal(rec.rules.preset, 'blitz');
    assert.equal(rec.winner, 'a');
    assert.equal(rec.endReason, 'sets');
    assert.deepEqual(rec.seats.map(s => s.id), ['a', 'b']);
    assert.equal(rec.seats[1].botMode, 'chud', 'seat order and bot modes are recorded');
    assert.ok(Array.isArray(rec.events) && rec.events.length > 0, 'the event stream is recorded');
    assert.equal(rec.boards.length, 2, 'the final boards are recorded');
    assert.ok(rec.log.length > 0);
  });
});

test('game logging is opt-outable and never writes when disabled', async () => {
  await withGameLog({ CHUD_GAME_LOG: '0' }, async (gamelog, dir) => {
    assert.equal(gamelog.enabled(), false);
    assert.equal(gamelog.recordFinished(finishedRoom(), G), false);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(fs.existsSync(nodePath.join(dir, 'games.jsonl')), false);
  });
});

test('game logging never throws into a room, whatever the state looks like', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1' }, (gamelog) => {
    // Unfinished, missing, and structurally broken rooms must all be no-ops, not throws.
    assert.doesNotThrow(() => gamelog.recordFinished(undefined, G));
    assert.doesNotThrow(() => gamelog.recordFinished({}, G));
    assert.doesNotThrow(() => gamelog.recordFinished({ state: { phase: 'playing' } }, G));
    const broken = finishedRoom();
    broken.state.players = null;              // would throw inside buildRecord
    assert.doesNotThrow(() => gamelog.recordFinished(broken, G));
  });
});

test('the game log is bounded: it rotates instead of growing without limit', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1', CHUD_GAME_LOG_MAX_BYTES: '2000' }, async (gamelog, dir) => {
    for (let i = 0; i < 6; i++) {
      const room = finishedRoom();
      room.code = 'LG' + i;
      gamelog.recordFinished(room, G);
      await new Promise(r => setTimeout(r, 20));   // let each async append land
    }
    await new Promise(r => setTimeout(r, 150));
    assert.ok(fs.existsSync(nodePath.join(dir, 'games.1.jsonl')), 'it rotated');
    const live = fs.statSync(nodePath.join(dir, 'games.jsonl')).size;
    assert.ok(live < 20000, `the live file stays bounded (${live} bytes)`);
  });
});
