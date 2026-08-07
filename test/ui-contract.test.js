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

/* ── §3.9: no rule may exist that the help does not state ─────────────────
   The client restates engine facts as prose. These tests are the only thing
   stopping that prose from drifting away from game.js again. */

test('every action card the engine ships has client rule copy, in the right quantity', () => {
  const { buildDeck } = require('../game.js');
  const cards = read('public/src/core/cards.js');
  const block = /export const ACTION_COUNTS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(cards);
  assert.ok(block, 'core/cards.js must publish ACTION_COUNTS');
  const claimed = Object.fromEntries(
    [...block[1].matchAll(/(\w+)\s*:\s*(\d+)/g)].map(m => [m[1], Number(m[2])]));

  const actual = {};
  for (const card of buildDeck()) {
    if (card.type === 'action') actual[card.action] = (actual[card.action] || 0) + 1;
  }
  assert.deepEqual(claimed, actual, 'ACTION_COUNTS must match game.js buildDeck()');

  const rules = /export const ACTION_RULES = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(cards);
  assert.ok(rules, 'core/cards.js must publish ACTION_RULES');
  for (const action of Object.keys(actual)) {
    assert.match(rules[1], new RegExp(`\\b${action}:`), `no rule copy for ${action}`);
  }

  // The catalogue page prints a face value per card; it must be the real one.
  const help = read('public/src/ui/help.js');
  const values = /const CARD_VALUES = \{([\s\S]*?)\};/.exec(help);
  assert.ok(values, 'ui/help.js must publish CARD_VALUES');
  const printed = Object.fromEntries(
    [...values[1].matchAll(/(\w+):\s*(\d+)/g)].map(m => [m[1], Number(m[2])]));
  const real = {};
  for (const card of buildDeck()) if (card.type === 'action') real[card.action] = card.value;
  assert.deepEqual(printed, real, 'help face values must match game.js buildDeck()');

  // Rent cards: five colour pairs plus the "any" rent.
  const rentCounts = {};
  for (const card of buildDeck()) {
    if (card.type === 'rent') {
      const key = card.colors[0] === 'any' ? 'any' : 'pair';
      rentCounts[key] = (rentCounts[key] || 0) + 1;
    }
  }
  const declared = /RENT_COUNTS = Object\.freeze\(\{ pair: (\d+), any: (\d+) \}\)/.exec(cards);
  assert.ok(declared, 'core/cards.js must publish RENT_COUNTS');
  assert.equal(rentCounts.any, Number(declared[2]));
  assert.equal(rentCounts.pair, Number(declared[1]) * 5, 'five colour pairs');
});

test('the help brief states the rules §3 introduced', () => {
  // The sheet renders help.js's own prose plus the card copy it pulls out of
  // core/cards.js, so the claim set is the union of the two.
  const brief = read('public/src/ui/help.js') + read('public/src/core/cards.js');
  const { DECK_CYCLE_LIMIT, HAND_LIMIT, SETS_TO_WIN } = require('../game.js');
  const claims = [
    [/final approach/i, '§3.10 final approach'],
    [/full turn cycle|full cycle/i, '§3.10 grace is a whole cycle'],
    [new RegExp(`reshuffled back into the deck ${DECK_CYCLE_LIMIT} times`, 'i'),
      '§3.11 deck-cycle attrition'],
    [/net worth/i, '§3.6 points tiebreak'],
    [/OPSEC/, 'OPSEC chains'],
    [/one player you name/i, '§3.2 wild rent hits one player'],
    [/next charge/i, '§3.3 Surge Ops doubles the next charge'],
    [/surrender every card you own/i, '§3.4 zero-value wilds still count'],
    [/holds its set size/i, '§3.5 zone cap'],
    [/never be handed over as payment/i, '§3.7 upgrades are not payable'],
    [/counts in your net worth/i, '§3.7 upgrades still shown in net worth'],
    [/free/i, '§3.8 free wild rearranging'],
    [/scoop/i, 'scoop / last standing'],
    [/rent is charged on a colour, not on a finished set/i, 'rent on incomplete sets'],
    [/long-press/i, 'card details gesture'],
    [/drag/i, 'the drag interaction'],
  ];
  for (const [re, what] of claims) assert.match(brief, re, `help never states: ${what}`);
  // The numbers come from the engine's own constants, never a literal.
  assert.match(brief, /HAND_LIMIT/, 'hand limit must be read from the shared constant');
  assert.equal(HAND_LIMIT, 7);
  assert.equal(SETS_TO_WIN, 3);
});

test('the help sheet is a keyboard-operable tablist (§0.9)', () => {
  const brief = read('public/src/ui/help.js');
  assert.match(brief, /role: 'tablist'/);
  assert.match(brief, /role: 'tab'/);
  assert.match(brief, /role: 'tabpanel'/);
  assert.match(brief, /ArrowLeft|ArrowRight/, 'arrow keys must walk the rail');
  assert.match(brief, /aria-selected/);
});

test('first-game hints never block input and never repeat', () => {
  const hints = read('public/src/ui/hints.js');
  const css = read('public/style/content.css');
  assert.match(hints, /localStorage/, 'hints must be remembered across games');
  assert.match(hints, /MAX_ON_SCREEN = 3/);
  assert.match(css, /\.hints\s*\{[^}]*pointer-events:\s*none/s,
    'the hint stack must be inert to the pointer');
});

test('animation timing goes through the one clock, never setInterval (§0.6)', () => {
  for (const file of modules.filter(f => f.includes('/anim/') || f.includes('/table/'))) {
    assert.doesNotMatch(source[file], /setInterval\s*\(/, file);
  }
  assert.match(read('public/src/core/clock.js'), /MAX_DT\s*=\s*1 \/ 20/);
});
