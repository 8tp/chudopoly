// test/server-hardening.test.js — P7 round-1 robustness fixes that need a real socket.
// Frame-level WebSocket errors, socket liveness, room teardown, /health surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const port = 34000 + (process.pid % 900);
const url = `ws://127.0.0.1:${port}`;
const httpUrl = `http://127.0.0.1:${port}`;
let serverProcess;
let serverOutput = '';
const clients = new Set();

// The heartbeat is 15s in production; the tests drive it at 250ms so a dead socket is
// reaped inside a normal test timeout rather than 30s later.
const PING_MS = 250;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 8000);
    const onData = data => {
      serverOutput += String(data);
      if (serverOutput.includes('Server running')) { clearTimeout(timeout); resolve(); }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', d => { serverOutput += String(d); });
    serverProcess.once('exit', code => reject(new Error(`server exited early (${code})`)));
  });
}

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws._messages = [];
    ws.on('message', raw => { try { ws._messages.push(JSON.parse(raw)); } catch {} });
    ws.on('error', () => {});
    ws.once('open', () => { clients.add(ws); resolve(ws); });
    ws.once('error', reject);
  });
}

const send = (ws, msg) => ws.send(JSON.stringify(msg));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(ws, predicate, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = ws._messages.find(predicate);
    if (hit) return hit;
    await sleep(15);
  }
  return null;
}

async function health() {
  const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(2000) });
  return { status: res.status, body: await res.json() };
}

async function stillAlive() {
  try { return (await health()).body.ok === true; } catch { return false; }
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', CHUD_PING_MS: String(PING_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(async () => {
  for (const ws of clients) { try { ws.terminate(); } catch {} }
  if (serverProcess) serverProcess.kill();
});

/* ── 1. frame-level WebSocket errors must not kill the process ───────── */
// Every vector below is unauthenticated: no join, no auth, first frame on the socket.
// Each one previously took the whole process down with an unhandled 'error' event.

async function survivesFrame(name, write) {
  const ws = await openClient();
  await write(ws);
  await sleep(400);
  assert.equal(await stillAlive(), true, `server died on: ${name}`);
  assert.equal(serverProcess.exitCode, null, `server process exited on: ${name}`);
  try { ws.terminate(); } catch {}
}

test('an oversized frame does not kill the server', async () => {
  await survivesFrame('17KB payload (maxPayload is 16KB)', ws => ws.send('x'.repeat(17 * 1024)));
});

test('an invalid UTF-8 text frame does not kill the server', async () => {
  await survivesFrame('invalid UTF-8', ws => {
    const body = Buffer.from([0xC0, 0x80, 0xFF, 0xFE]);
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(body.map((b, i) => b ^ mask[i % 4]));
    ws._socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]));
  });
});

test('an RSV1 bit set with no deflate does not kill the server', async () => {
  await survivesFrame('RSV1 set', ws => {
    const mask = Buffer.from([1, 2, 3, 4]);
    ws._socket.write(Buffer.concat([Buffer.from([0xC1, 0x81]), mask, Buffer.from([0x41 ^ 1])]));
  });
});

test('an unknown opcode does not kill the server', async () => {
  await survivesFrame('opcode 0x3', ws => {
    const mask = Buffer.from([1, 2, 3, 4]);
    ws._socket.write(Buffer.concat([Buffer.from([0x83, 0x80]), mask]));
  });
});

test('a TCP reset mid-frame does not kill the server', async () => {
  await survivesFrame('RST mid-frame', ws => {
    ws._socket.write(Buffer.from([0x81, 0xFF]));
    try { ws._socket.destroy(); } catch {}
  });
});

test('the server still serves real traffic after all of that', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Survivor' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  assert.ok(joined, 'a normal game can still be created');
  send(ws, { type: 'leave_room' });
  ws.close();
});

/* ── 2. socket liveness ──────────────────────────────────────────────── */

test('a half-open socket is reaped by the heartbeat and the seat is released', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Dropout' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  assert.ok(joined);
  await waitFor(ws, m => m.type === 'state' && m.phase === 'playing');

  // No FIN, no RST: exactly a phone losing signal. readyState stays 1 on the server.
  ws._socket.pause();

  // Without ping/pong the seat stays locked until the OS keepalive (~2h) and reconnect is
  // refused forever with "That player is already connected".
  const deadline = Date.now() + 6000;
  let reclaimed = null;
  while (Date.now() < deadline && !reclaimed) {
    const probe = await openClient();
    send(probe, { type: 'reconnect', code: joined.code, playerId: joined.playerId, resumeToken: joined.resumeToken });
    reclaimed = await waitFor(probe, m => m.type === 'joined', 600);
    if (!reclaimed) { probe.close(); await sleep(200); } else { probe.close(); }
  }
  assert.ok(reclaimed, 'the dead socket was never reaped; the seat stayed locked');
  try { ws._socket.resume(); ws.terminate(); } catch {}
});

test('the server pings and a live client stays connected', async () => {
  const ws = await openClient();
  let pings = 0;
  ws.on('ping', () => { pings++; });
  await sleep(PING_MS * 4);
  assert.ok(pings >= 2, `expected heartbeat pings, saw ${pings}`);
  assert.equal(ws.readyState, 1, 'a responsive client is never terminated');
  ws.close();
});

/* ── 3. rejected commands neither reset the deadline nor fan out state ── */

test('a rejected respond returns an error and broadcasts nothing', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Bystand' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  await waitFor(ws, m => m.type === 'state' && m.phase === 'playing');
  await sleep(300);

  const statesBefore = ws._messages.filter(m => m.type === 'state').length;
  const errorsBefore = ws._messages.filter(m => m.type === 'error').length;
  const JUNK = 12;
  for (let i = 0; i < JUNK; i++) { send(ws, { type: 'respond', response: 'accept' }); await sleep(40); }
  await sleep(300);

  const errors = ws._messages.filter(m => m.type === 'error').length - errorsBefore;
  const states = ws._messages.filter(m => m.type === 'state').length - statesBefore;
  assert.equal(errors, JUNK, 'every junk respond is answered with exactly one error');
  assert.ok(states <= 2, `a rejected command must not fan a full state to every seat (saw ${states})`);
  assert.ok(joined);
  send(ws, { type: 'leave_room' });
  ws.close();
});

/* ── 11. /health surface ─────────────────────────────────────────────── */

test('/health reports the build and uptime, not just {ok, rooms}', async () => {
  const { status, body } = await health();
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.rooms, 'number');
  assert.equal(typeof body.version, 'string');
  assert.equal(body.version, require('../package.json').version);
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.startedAt, 'number');
  assert.equal(typeof body.sockets, 'number');
  assert.ok('commit' in body, 'a deploy must be able to identify the running build');
});

/* ── 2/7. timer floor and room teardown ──────────────────────────────── */

test('a room with two humans cannot be started with a zero turn clock', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Host' });
  const hostJoined = await waitFor(host, m => m.type === 'joined');
  const guest = await openClient();
  send(guest, { type: 'join_room', code: hostJoined.code, name: 'Guest' });
  await waitFor(guest, m => m.type === 'joined');
  await sleep(150);

  send(host, { type: 'start_game', turnTimeout: 0, responseTimeout: 0 });
  const state = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.ok(state.turnTimer, 'a multi-human table always gets a clock it can recover from');
  assert.ok(state.turnTimer.timeout >= 30);

  send(host, { type: 'leave_room' });
  send(guest, { type: 'leave_room' });
  host.close(); guest.close();
});

test('a solo table keeps its no-clock Quick Play mode', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Lone' });
  await waitFor(ws, m => m.type === 'joined');
  const state = await waitFor(ws, m => m.type === 'state' && m.phase === 'playing');
  assert.equal(state.turnTimer, null, 'one human = no turn clock, by design');
  send(ws, { type: 'leave_room' });
  ws.close();
});

test('leaving a lobby deletes the room and leaves no timer running', async () => {
  const before = (await health()).body.rooms;
  const ws = await openClient();
  send(ws, { type: 'create_room', name: 'Ghost' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  assert.ok(joined);
  send(ws, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  assert.equal((await health()).body.rooms, before + 1);

  send(ws, { type: 'leave_room' });
  await sleep(300);
  assert.equal((await health()).body.rooms, before, 'the room is gone');

  // A deleted room whose turn timer kept re-arming used to keep playing forever.
  const quiet = serverOutput.length;
  await sleep(1200);
  assert.equal(serverOutput.length, quiet, 'nothing is still driving the deleted room');
  ws.close();
});

/* ── §3.10 win-rule toggle: the lobby payload over the wire ──────────── */

async function startTwoHumanRoom(name, extra) {
  const host = await openClient();
  send(host, { type: 'create_room', name });
  const joined = await waitFor(host, m => m.type === 'joined');
  const guest = await openClient();
  send(guest, { type: 'join_room', code: joined.code, name: name + 'G' });
  await waitFor(guest, m => m.type === 'joined');
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, ...extra });
  const state = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  return { host, guest, joined, state };
}

test('start_game carries winRule and getPlayerView reports the active mode', async () => {
  for (const rule of ['finalApproach', 'mdFaithful', 'instant']) {
    const { host, guest, state } = await startTwoHumanRoom('WR', { winRule: rule });
    assert.equal(state.game.winRule, rule, `room should run ${rule}`);
    assert.ok(state.game.events.some(e => e.t === 'game_start' && e.winRule === rule));
    if (rule === 'instant') assert.deepEqual(state.game.armedIds, []);
    send(host, { type: 'leave_room' }); send(guest, { type: 'leave_room' });
    host.close(); guest.close();
    await sleep(120);
  }
});

test('an omitted winRule is accepted and means finalApproach', async () => {
  const { host, guest, state } = await startTwoHumanRoom('Legacy', {});
  assert.equal(state.game.winRule, 'finalApproach');
  send(host, { type: 'leave_room' }); send(guest, { type: 'leave_room' });
  host.close(); guest.close();
});

test('an invalid winRule is refused without starting the game', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'BadRule' });
  const joined = await waitFor(host, m => m.type === 'joined');
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, winRule: 'sudden_death' });
  const err = await waitFor(host, m => m.type === 'error', 1500);
  assert.ok(err, 'a bad win rule is rejected at the protocol boundary');
  assert.match(err.message, /win rule/i);
  assert.ok(joined);
  send(host, { type: 'leave_room' });
  host.close();
});

test('the win rule is sticky across a rematch', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Sticky' });
  const joined = await waitFor(host, m => m.type === 'joined');
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, winRule: 'instant' });
  const first = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.equal(first.game.winRule, 'instant');

  // End it deterministically: scooping out of a 2-seat table leaves the bot last standing.
  send(host, { type: 'scoop' });
  const finished = await waitFor(host, m => m.type === 'state' && m.game?.phase === 'finished', 4000);
  assert.ok(finished, 'the game reached an ending');
  assert.ok(joined);

  host._messages.length = 0;
  send(host, { type: 'rematch' });
  const again = await waitFor(host, m => m.type === 'state' && m.game?.phase === 'playing', 4000);
  assert.ok(again, 'rematch started');
  assert.equal(again.game.winRule, 'instant', 'the room setting survives the rematch');
  send(host, { type: 'leave_room' });
  host.close();
});

/* ── owner directive: automatic turn draw over the wire ──────────────── */

test('a reconnecting player never draws twice and never sees a draw phase', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Rejoin' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  const first = await waitFor(ws, m => m.type === 'state' && m.phase === 'playing');
  const me = first.game.players.find(p => p.id === joined.playerId);
  assert.equal(first.game.turnPhase, 'play');
  assert.equal(me.hand.length, 7, 'auto-drawn without any client command');

  // An old client sending `draw` must get neither an error nor a second draw.
  const errorsBefore = ws._messages.filter(m => m.type === 'error').length;
  send(ws, { type: 'draw' });
  await sleep(300);
  assert.equal(ws._messages.filter(m => m.type === 'error').length, errorsBefore,
    '`draw` is accepted as a harmless no-op');

  ws._socket.destroy();
  const back = await openClient();
  send(back, { type: 'reconnect', code: joined.code, playerId: joined.playerId, resumeToken: joined.resumeToken });
  const rejoined = await waitFor(back, m => m.type === 'joined');
  assert.ok(rejoined, 'reconnect accepted');
  const resumed = await waitFor(back, m => m.type === 'state' && m.game);
  const seat = resumed.game.players.find(p => p.id === joined.playerId);
  assert.equal(seat.hand.length, 7, 'no second draw on reconnect');
  assert.notEqual(resumed.game.turnPhase, 'draw');
  back.close();
});
