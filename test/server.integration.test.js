const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const port = 32000 + (process.pid % 1000);
const url = `ws://127.0.0.1:${port}`;
let serverProcess;
const clients = new Set();

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 5000);
    const onData = data => {
      if (String(data).includes('Server running')) {
        clearTimeout(timeout);
        serverProcess.stdout.off('data', onData);
        resolve();
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.once('exit', code => reject(new Error(`server exited early (${code})`)));
  });
}

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws._messages = [];
    ws._waiters = [];
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      const waiterIndex = ws._waiters.findIndex(waiter => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = ws._waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        ws._messages.push(message);
      }
    });
    ws.once('open', () => { clients.add(ws); resolve(ws); });
    ws.once('error', reject);
  });
}

function waitMessage(ws, predicate, timeoutMs = 3000) {
  const existingIndex = ws._messages.findIndex(predicate);
  if (existingIndex >= 0) return Promise.resolve(ws._messages.splice(existingIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timeout:null };
    waiter.timeout = setTimeout(() => {
      ws._waiters = ws._waiters.filter(item => item !== waiter);
      reject(new Error('message timeout'));
    }, timeoutMs);
    ws._waiters.push(waiter);
  });
}

function send(ws, message) { ws.send(JSON.stringify(message)); }

test.before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT:String(port), NODE_ENV:'test', CHUD_SEED:'integration' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(() => {
  for (const ws of clients) try { ws.close(); } catch {}
  if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGTERM');
});

test('malformed JSON values are rejected without crashing the server', async () => {
  const ws = await openClient();
  ws.send('null');
  const error = await waitMessage(ws, msg => msg.type === 'error');
  assert.match(error.message, /JSON object/);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal((await response.json()).ok, true);
});

test('reconnect requires the private token and an available seat', async () => {
  const host = await openClient();
  send(host, { type:'create_room', name:'Host' });
  const joined = await waitMessage(host, msg => msg.type === 'joined');
  assert.ok(joined.resumeToken);

  const attacker = await openClient();
  send(attacker, { type:'reconnect', code:joined.code, playerId:joined.playerId, resumeToken:'x'.repeat(43) });
  const badToken = await waitMessage(attacker, msg => msg.type === 'error');
  assert.match(badToken.message, /Invalid resume credentials/);

  send(attacker, { type:'reconnect', code:joined.code, playerId:joined.playerId, resumeToken:joined.resumeToken });
  const occupied = await waitMessage(attacker, msg => msg.type === 'error');
  assert.match(occupied.message, /already connected/);

  host.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const resumed = await openClient();
  send(resumed, { type:'reconnect', code:joined.code, playerId:joined.playerId, resumeToken:joined.resumeToken });
  const resumedJoined = await waitMessage(resumed, msg => msg.type === 'joined');
  assert.equal(resumedJoined.playerId, joined.playerId);
});

test('quick play creates a live three-player game', async () => {
  const ws = await openClient();
  send(ws, { type:'quick_play', name:'Solo' });
  const joined = await waitMessage(ws, msg => msg.type === 'joined');
  const state = await waitMessage(ws, msg => msg.type === 'state' && msg.phase === 'playing');
  assert.equal(state.players.length, 3);
  assert.equal(state.players.filter(player => player.isBot).length, 2);
  assert.equal(state.game.phase, 'playing');

  const me = state.game.players.find(player => player.id === joined.playerId);
  assert.equal(me.hand.length, 5);
  assert.equal(state.game.players.filter(player => player.hand !== undefined).length, 1);
  assert.ok(state.game.events.some(event => event.t === 'game_start'));
  const foreignDeal = state.game.events.find(event => event.t === 'deal' && event.to !== joined.playerId);
  assert.equal(foreignDeal.cards, undefined);
  assert.equal(foreignDeal.count, 5);
});

test('CHUD_SEED makes the served shuffle reproducible', async () => {
  const hands = [];
  for (let i = 0; i < 2; i++) {
    const ws = await openClient();
    send(ws, { type:'quick_play', name:`Seeded${i}` });
    const joined = await waitMessage(ws, msg => msg.type === 'joined');
    const state = await waitMessage(ws, msg => msg.type === 'state' && msg.phase === 'playing');
    const me = state.game.players.find(player => player.id === joined.playerId);
    hands.push(me.hand.map(card => card.id).join(','));
    send(ws, { type:'leave_room' });
  }
  assert.equal(hands[0], hands[1]);
});
