const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMessage } = require('../server/protocol');

test('rejects non-object, unknown, and malformed commands', () => {
  assert.equal(validateMessage(null).ok, false);
  assert.equal(validateMessage([]).ok, false);
  assert.equal(validateMessage({ type:'nope' }).ok, false);
  assert.equal(validateMessage({ type:'chat', text:7, scope:'global' }).ok, false);
  assert.equal(validateMessage({ type:'join_room', code:{}, name:'Ace' }).ok, false);
  assert.equal(validateMessage({ type:'create_room', name:'<img>' }).ok, false);
});

test('requires private reconnect credentials', () => {
  const playerId = '902ac21e-0feb-4d88-877c-1f17ad62ef00';
  const resumeToken = 'a'.repeat(43);
  assert.equal(validateMessage({ type:'reconnect', code:'ABCD', playerId }).ok, false);
  assert.equal(validateMessage({ type:'reconnect', code:'ABCD', playerId, resumeToken }).ok, true);
});

test('rejects duplicate card selections at the protocol boundary', () => {
  assert.equal(validateMessage({ type:'respond', response:'accept', paymentCards:[1, 1] }).ok, false);
  assert.equal(validateMessage({ type:'end_turn', discardIds:[4, 4] }).ok, false);
  assert.equal(validateMessage({ type:'respond', response:'accept', paymentCards:[1, 2] }).ok, true);
});

test('accepts supported product commands', () => {
  assert.equal(validateMessage({ type:'quick_play', name:'Maverick' }).ok, true);
  assert.equal(validateMessage({ type:'start_game', turnTimeout:60, responseTimeout:30 }).ok, true);
  assert.equal(validateMessage({ type:'rematch' }).ok, true);
});
