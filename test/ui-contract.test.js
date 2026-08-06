// Contract tests for the P3 client (public/index.html + public/src/**).
//
// Same spirit as the pre-revamp version: no inline handlers, XSS-safe chat,
// cache-busted entry, private resume tokens. Extended for the invariants the
// new architecture adds — one module entry, no innerHTML anywhere in the client,
// no window._* globals, and the §9 harness bridge contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync('public/index.html', 'utf8');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(file));
    else if (/\.m?js$/.test(entry.name)) out.push(file);
  }
  return out;
}

const modules = walk('public/src');
const source = Object.fromEntries(modules.map(f => [f, readFileSync(f, 'utf8')]));
const read = (file) => readFileSync(file, 'utf8');

test('client module tree exists with one entry point', () => {
  assert.ok(existsSync('public/src/main.js'));
  assert.ok(modules.length >= 20, `expected a real module tree, found ${modules.length}`);
  for (const dir of ['core', 'net', 'state', 'table', 'anim', 'interact', 'ui', 'audio', 'fx']) {
    assert.ok(existsSync(join('public/src', dir)), `missing public/src/${dir}`);
  }
});

test('the page ships no inline handlers and no classic scripts', () => {
  assert.doesNotMatch(html, /<[a-zA-Z][^>]*\son[a-z]+\s*=/);
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map(m => m[0]);
  assert.equal(scripts.length, 1, 'exactly one <script> tag: the module entry');
  assert.match(scripts[0], /type="module"/);
  assert.match(scripts[0], /src="\/src\/main\.js\?v=/, 'entry must be cache-busted (§0.2)');
});

test('every local stylesheet is cache-busted', () => {
  const sheets = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(sheets.length > 0);
  for (const href of sheets) assert.match(href, /\?v=/, href);
});

test('the page declares native-app viewport chrome (§6)', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-live="polite"/);
});

test('the screens and harness-visible hooks the tools select on are present', () => {
  for (const id of ['screen-home', 'screen-lobby', 'screen-game', 'btn-quick-play',
    'btn-start', 'btn-rematch', 'win-summary', 'zone-hand', 'self-board', 'opponents']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /data-zone="deck"/);
  assert.match(html, /data-zone="discard"/);
  assert.match(html, /data-zone="hand"/);
});

test('no module writes innerHTML anywhere in the client (§0.4)', () => {
  for (const [file, text] of Object.entries(source)) {
    const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=/, file);
  }
});

test('chat and log build text nodes, never markup', () => {
  const comms = read('public/src/ui/comms.js');
  assert.match(comms, /text:\s*msg\.text/);
  assert.match(comms, /text:\s*lines\[i\]/);
  assert.doesNotMatch(comms, /innerHTML/);
  // el() is the only text path and it uses textContent.
  assert.match(read('public/src/core/dom.js'), /node\.textContent = String\(props\.text\)/);
});

test('resume tokens live in sessionStorage and are replayed on reconnect (§2)', () => {
  const socket = read('public/src/net/socket.js');
  assert.match(socket, /chud_resume/);
  assert.match(socket, /sessionStorage/);
  assert.match(socket, /type:\s*'reconnect'/);
  assert.match(socket, /RETRY_MS\s*=\s*2000/, '§2: 2s retry');
});

test('outbound sends are throttled below the server rate limit', () => {
  const socket = read('public/src/net/socket.js');
  const gap = /MIN_GAP\s*=\s*(\d+)/.exec(socket);
  assert.ok(gap, 'socket must declare MIN_GAP');
  // server.js closes the socket at >40 messages per rolling 5s.
  assert.ok(Number(gap[1]) >= 125, `MIN_GAP ${gap[1]}ms allows more than 40 msgs / 5s`);
});

test('no window._* globals leak client state (§5)', () => {
  for (const [file, text] of Object.entries(source)) {
    assert.doesNotMatch(text, /window\._[A-Za-z]/, file);
  }
});

test('randomness in the client comes only from core/rng.js (§5)', () => {
  for (const [file, text] of Object.entries(source)) {
    if (file.endsWith('rng.js')) continue;
    const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /Math\.random\s*\(/, file);
  }
});

test('the __CHUD bridge exposes the §9 contract and is harness-gated', () => {
  const harness = read('public/src/harness.js');
  for (const field of ['version', 'ready', 'applyState', 'drainEvents', 'sfxLog',
    'hapticLog', 'driftCount', 'lastError', 'sentLog']) {
    assert.match(harness, new RegExp(`\\b${field}\\b`), `bridge is missing ${field}`);
  }
  assert.match(harness, /harness/);
  assert.match(read('public/src/main.js'), /isHarness\(\)/);
});

test('animation timing goes through the one clock, never setInterval (§0.6)', () => {
  for (const file of modules.filter(f => f.includes('/anim/') || f.includes('/table/'))) {
    assert.doesNotMatch(source[file], /setInterval\s*\(/, file);
  }
  assert.match(read('public/src/core/clock.js'), /MAX_DT\s*=\s*1 \/ 20/);
});
