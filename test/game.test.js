const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');

function game(playerCount = 2) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
  const state = G.createGame(players);
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  return state;
}

function take(state, predicate) {
  const index = state.deck.findIndex(predicate);
  assert.notEqual(index, -1, 'expected card in deck');
  return state.deck.splice(index, 1)[0];
}

function give(state, player, predicate) {
  const card = take(state, predicate);
  player.hand.push(card);
  return card;
}

function bank(state, player, value) {
  const card = take(state, c => c.type === 'money' && c.value === value);
  player.bank.push(card);
  return card;
}

function property(state, player, color) {
  const card = take(state, c => c.type === 'property' && c.color === color);
  (player.properties[color] ||= []).push({ ...card, placedColor: color });
  return card;
}

function assertHealthy(state) {
  assert.deepEqual(G.validateState(state), { ok: true });
}

test('deck has unique IDs and a healthy initial state', () => {
  const state = G.createGame([{ id:'p1', name:'One' }, { id:'p2', name:'Two' }]);
  assert.equal(new Set(G.buildDeck().map(c => c.id)).size, G.buildDeck().length);
  assertHealthy(state);
});

test('PCS, Upgrade, FOC, and Surge actions preserve cards', () => {
  const state = game();
  const p1 = state.players[0];
  property(state, p1, 'brown'); property(state, p1, 'brown');
  give(state, p1, c => c.action === 'upgrade');
  give(state, p1, c => c.action === 'foc');
  give(state, p1, c => c.action === 'surge_ops');
  assert.ok(G.playAction(state, 'p1', 0, { targetColor:'brown' }).ok);
  assert.ok(G.playAction(state, 'p1', 0, { targetColor:'brown' }).ok);
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.deepEqual(G.upgradeKinds(p1, 'brown'), ['house', 'hotel']);
  assert.equal(state._surgeOps, true);
  assertHealthy(state);

  const pcsState = game();
  give(pcsState, pcsState.players[0], c => c.action === 'pcs_orders');
  assert.equal(G.playAction(pcsState, 'p1', 0, {}).drawn.length, 2);
  assertHealthy(pcsState);
});

test('Finance payment and OPSEC counter chain resolve correctly', () => {
  const state = game();
  const [p1, p2] = state.players;
  give(state, p1, c => c.action === 'finance_office');
  give(state, p1, c => c.action === 'opsec');
  give(state, p2, c => c.action === 'opsec');
  const payment = bank(state, p2, 5);
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);
  assert.ok(G.respondToAction(state, 'p1', 'opsec').ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept', [payment.id]).ok);
  assert.equal(p1.bank[0].value, 5);
  assert.equal(state.pendingAction, null);
  assertHealthy(state);
});

test('Roll Call and rent collect from every opponent', () => {
  const state = game(3);
  const [p1, p2, p3] = state.players;
  give(state, p1, c => c.action === 'roll_call');
  const p2Money = bank(state, p2, 2);
  const p3Money = bank(state, p3, 2);
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept', [p2Money.id]).ok);
  assert.ok(G.respondToAction(state, 'p3', 'accept', [p3Money.id]).ok);
  assert.equal(G.playerTotalValue(p1), 4);
  assertHealthy(state);

  const rentState = game();
  property(rentState, rentState.players[0], 'brown');
  give(rentState, rentState.players[0], c => c.type === 'rent' && c.colors.includes('brown'));
  const rentMoney = bank(rentState, rentState.players[1], 1);
  assert.ok(G.playAction(rentState, 'p1', 0, { targetColor:'brown' }).ok);
  assert.ok(G.respondToAction(rentState, 'p2', 'accept', [rentMoney.id]).ok);
  assertHealthy(rentState);
});

test('steal, set seizure, swap, and CHUD actions resolve atomically', () => {
  const stealState = game();
  const stealCard = property(stealState, stealState.players[1], 'brown');
  give(stealState, stealState.players[0], c => c.action === 'midnight_requisition');
  assert.ok(G.playAction(stealState, 'p1', 0, { targetId:'p2', targetCardId:stealCard.id }).ok);
  assert.equal(stealState.turnPhase, 'action_response');
  assert.ok(G.respondToAction(stealState, 'p2', 'accept').ok);
  assert.equal(stealState.players[0].properties.brown.length, 1);
  assertHealthy(stealState);

  const setState = game();
  property(setState, setState.players[1], 'brown'); property(setState, setState.players[1], 'brown');
  give(setState, setState.players[0], c => c.action === 'inspector_general');
  assert.ok(G.playAction(setState, 'p1', 0, { targetId:'p2', targetColor:'brown' }).ok);
  assert.ok(G.respondToAction(setState, 'p2', 'accept').ok);
  assert.equal(setState.players[0].properties.brown.length, 2);
  assertHealthy(setState);

  const swapState = game();
  const mine = property(swapState, swapState.players[0], 'brown');
  const theirs = property(swapState, swapState.players[1], 'green');
  give(swapState, swapState.players[0], c => c.action === 'tdy_orders');
  assert.ok(G.playAction(swapState, 'p1', 0, { targetId:'p2', myCardId:mine.id, targetCardId:theirs.id }).ok);
  assert.ok(G.respondToAction(swapState, 'p2', 'accept').ok);
  assert.equal(swapState.players[0].properties.green[0].id, theirs.id);
  assertHealthy(swapState);

  const chudState = game();
  const target = property(chudState, chudState.players[1], 'green');
  give(chudState, chudState.players[0], c => c.action === 'chud');
  assert.ok(G.playAction(chudState, 'p1', 0, { targetId:'p2', targetCardId:target.id }).ok);
  assert.ok(G.respondToAction(chudState, 'p2', 'accept').ok);
  assert.ok(G.respondToAction(chudState, 'p2', 'accept').ok);
  assert.equal(chudState.players[0].properties.green[0].id, target.id);
  assertHealthy(chudState);
});

test('duplicate and stale selections are rejected without mutation', () => {
  const state = game();
  const [p1, p2] = state.players;
  const one = bank(state, p2, 1);
  bank(state, p2, 10);
  state.pendingAction = { type:'payment', action:'finance_office', sourceId:'p1', targetId:'p2', amount:2, responderId:'p2' };
  state.turnPhase = 'action_response';
  const duplicate = G.respondToAction(state, 'p2', 'accept', [one.id, one.id]);
  assert.match(duplicate.error, /unique/);
  assert.deepEqual(p2.bank.map(c => c.value), [1, 10]);
  assert.equal(p1.bank.length, 0);
  assertHealthy(state);

  const swapState = game();
  const target = property(swapState, swapState.players[1], 'brown');
  give(swapState, swapState.players[0], c => c.action === 'tdy_orders');
  const before = swapState.players[0].hand.length;
  const invalidSwap = G.playAction(swapState, 'p1', 0, { targetId:'p2', myCardId:999, targetCardId:target.id });
  assert.match(invalidSwap.error, /no longer available/);
  assert.equal(swapState.players[0].hand.length, before);
  assertHealthy(swapState);
});

test('duplicate discards and post-win mutations are rejected', () => {
  const state = game();
  for (let i = 0; i < 9; i++) state.players[0].hand.push(state.deck.pop());
  const id = state.players[0].hand[0].id;
  assert.match(G.endTurn(state, 'p1', [id, id]).error, /unique/);
  assert.equal(state.players[0].hand.length, 9);
  assertHealthy(state);

  state.phase = 'finished';
  state.winner = 'p1';
  assert.match(G.playAsMoney(state, 'p1', 0).error, /finished/);
  assert.equal(state.players[0].bank.length, 0);
});
