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
  assert.doesNotMatch(comms, /innerHTML/);
  // P8: the Mission Log moved out of comms.js into ui/journal.js, which builds
  // it from the structured event stream. Both the beat text and the verbatim
  // server prose still go through el()'s `text:` and nothing else — player
  // names and log lines are the two strings a server can put words into.
  const journal = read('public/src/ui/journal.js');
  assert.match(journal, /text:\s*line\b/, 'the prose transcript must use el() text');
  assert.match(journal, /text:\s*d\.text/, 'beat text must use el() text');
  assert.doesNotMatch(journal, /innerHTML/);
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
    [/reshuffled back into the deck \$\{DECK_CYCLE_LIMIT\} times/i,
      '§3.11 deck-cycle attrition (from the shared constant, not a literal)'],
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

  // core/cards.js mirrors DECK_CYCLE_LIMIT for the pages the help renders with
  // no game on screen. game.js wins; this catches the mirror drifting.
  const mirrored = /DECK_CYCLE_LIMIT = (\d+)/.exec(read('public/src/core/cards.js'));
  assert.ok(mirrored, 'core/cards.js must publish DECK_CYCLE_LIMIT');
  assert.equal(Number(mirrored[1]), DECK_CYCLE_LIMIT,
    'core/cards.js DECK_CYCLE_LIMIT must equal game.js');
});

/* ── P7 round 1: the defects fresh critics proved, kept fixed ────────────── */

test('§P7.14 the CHUD/TDY distinction is stated, not the false exclusivity', () => {
  const brief = read('public/src/ui/help.js') + read('public/src/core/cards.js');
  // game.js playAction case 'tdy_orders' has no zoneRequisitionable guard and
  // executeEntry case 'swap' splices out of whatever colour holds the card, so
  // "the only card that takes from a complete set" was false.
  assert.doesNotMatch(brief, /only card that takes a property out of a complete set/i,
    'the disproved claim must not come back');
  assert.match(brief, /gives nothing back|give nothing back/i,
    'CHUD must be described by what makes it unique: it gives nothing back');
  assert.match(brief, /trade|trades/i, 'TDY must be described as a trade into a set');
});

test('§P7.15 OPSEC is never flagged "OPSEC cannot touch it"', () => {
  const cards = read('public/src/core/cards.js');
  assert.match(cards, /export function opsecFlag/,
    'one source for the OPSEC flag sentence');
  assert.match(cards, /Answered only by another OPSEC/);
  // The two renderers must both go through it rather than through a boolean.
  for (const file of ['public/src/ui/help.js', 'public/src/ui/details.js']) {
    assert.match(read(file), /opsecFlag\(/, `${file} must use opsecFlag()`);
    assert.doesNotMatch(read(file), /blockable\s*\?\s*'OPSEC can cancel it'/,
      `${file} must not re-derive the flag from a boolean`);
  }
});

test('§P7.17 the final-approach countdown prints only the honest engine field', () => {
  const hud = read('public/src/ui/hud.js');
  // `finalApproachIn` counts turns of ANY seat until the checkpoint CONDITION —
  // off by one when armed on your own turn, and clamped to 0 for up to three
  // turns when armed off-turn. game.js marks it deprecated and still ships it,
  // so the only protection is that no client code reads it at all.
  const uses = hud.split('\n')
    .filter(line => /finalApproachIn/.test(line) && !/^\s*(\*|\/\/)/.test(line));
  assert.deepEqual(uses, [],
    `the deprecated finalApproachIn must not be read: ${uses.join(' | ')}`);
  assert.match(hud, /opponentTurnsRemaining/,
    'the countdown must come from the engine-supplied opponent-turn count');
  assert.match(hud, /convertsNext/,
    'opponentTurnsRemaining === 0 is the one guaranteed "they win next turn" state');

  // And the engine must still be publishing it.
  const { createGame, getPlayerView } = require('../game.js');
  const g = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { seed: 'ui' });
  const view = getPlayerView(g, 'a');
  assert.ok('opponentTurnsRemaining' in view.players[0],
    'getPlayerView must expose opponentTurnsRemaining');
});

test('the automatic turn draw leaves no draw affordance behind (§P7.9)', () => {
  const prompt = read('public/src/ui/prompt.js');
  assert.match(prompt, /setHidden\(\$\('btn-draw'\), true\)/,
    'the hand-bar draw button is suppressed unconditionally');
  assert.doesNotMatch(prompt, /button\('draw'/, 'the prompt must not build a draw control');
  assert.doesNotMatch(read('public/src/ui/hud.js'), /setHidden\(\$\('btn-draw'\)/,
    'only one module may decide whether a draw control is on screen');
  // game.js beginTurn() draws for every seat, so a broadcast never carries
  // turnPhase 'draw' — the help must not promise a step that does not exist.
  assert.doesNotMatch(read('public/src/ui/help.js'), /Draw first|Draw to start/i);
});

test('the win overlay names the tiebreak that actually decided an attrition game', () => {
  const overlays = read('public/src/ui/overlays.js');
  assert.match(overlays, /stalemateBasis/);
  for (const basis of ['net_worth', 'turn_order', 'unopposed']) {
    assert.match(overlays, new RegExp(`case '${basis}'`), `no copy for basis ${basis}`);
  }
});

test('§P7.3 a refusal is never a disabled button', () => {
  const prompt = read('public/src/ui/prompt.js');
  assert.doesNotMatch(prompt, /play\.disabled = true/,
    'the Play control must stay live so the refusal can speak');
  assert.match(prompt, /is-refusing/);
  const machine = read('public/src/interact/index.js');
  assert.match(machine, /export function refuse/);
  assert.match(machine, /CUE\.DENIED/, 'every refusal must fire the denied cue');
  assert.match(machine, /shakeHead/, '§5: invalid targets shake their head');
});

test('§P7.2 a press on a card is acknowledged in the same task as the pointerdown', () => {
  const pointer = read('public/src/interact/pointer.js');
  // The hook must be called from onDown itself — not from a timer, not from
  // the drag threshold, which is where the only feedback used to live.
  const onDown = /function onDown\(e\)\{[\s\S]*?\n\}/.exec(pointer.replace(/\s*\{\s*/, '{'))
    || /function onDown[\s\S]*?\n\}/.exec(pointer);
  assert.ok(onDown, 'pointer.js must have onDown');
  assert.match(onDown[0], /hooks\.press\?\.\(/, 'onDown must fire the press hook synchronously');
  const drag = read('public/src/interact/drag.js');
  assert.match(drag, /function press\([\s\S]*?is-pressed[\s\S]*?CUE_PICKUP/,
    'the press must both lift and cue');
});

test('§P7.5 the hand claims every touch direction', () => {
  const css = read('public/style/interact.css');
  // table/hand.js tighten() guarantees the hand never overflows, so pan-x was
  // protecting a scroll that does not exist while killing horizontal drags.
  assert.match(css, /#hand-dock \.card \{ touch-action: none; \}/);
  assert.doesNotMatch(css, /#hand-dock \.card \{ touch-action: pan-x/);
});

test('§P7.8 the prompt bar is reconciled, never rebuilt', () => {
  const prompt = read('public/src/ui/prompt.js');
  assert.match(prompt, /function paint\(bar, items\)/);
  assert.match(prompt, /dataset\.key/, 'items must be keyed so nodes survive a re-render');
  assert.doesNotMatch(prompt, /clear\(bar\)/,
    'clearing the bar detaches a button mid-tap (tools/touchtest.mjs documents the trap)');
});

test('§P7.9 exactly one draw affordance exists', () => {
  const prompt = read('public/src/ui/prompt.js');
  const hud = read('public/src/ui/hud.js');
  assert.match(prompt, /setHidden\(\$\('btn-draw'\), true\)/,
    'the hand-bar duplicate is suppressed by the module that owns the decision');
  assert.doesNotMatch(hud, /setHidden\(\$\('btn-draw'\)/,
    'only one module may decide whether a draw control is on screen');
});

test('§P7.6 the software keyboard is handled through visualViewport (§2)', () => {
  const comms = read('public/src/ui/comms.js');
  assert.match(comms, /visualViewport/);
  assert.match(comms, /--kb-inset/);
  assert.match(read('public/style/content.css'), /\.side \{ bottom: var\(--kb-inset/);
});

test('§P7.22 exactly one reconnect hook is armed at a time', () => {
  const socket = read('public/src/net/socket.js');
  assert.match(socket, /pendingResume/,
    'bus.once() cannot self-clean while the server is down — the hook must be tracked');
  assert.match(socket, /if \(pendingResume\) \{ pendingResume\(\); pendingResume = null; \}/);
});

test('§P7.21 a dead session is fatal, not a toast', () => {
  const main = read('public/src/main.js');
  assert.match(main, /Room not found/);
  assert.match(main, /Invalid resume credentials/);
  assert.match(main, /clearCreds\(\)/);
  assert.match(main, /function endSession/);
});

test('the peek layer never intercepts input and reuses the card renderer', () => {
  const css = read('public/style/content.css');
  assert.match(css, /\.peek \{[^}]*pointer-events:\s*none/s,
    'the peek must never take a click, a drag or a hit-test');
  const peek = read('public/src/ui/peek.js');
  assert.match(peek, /cloneNode\(true\)|faceRenderer/,
    'the peek must reuse the shipped card face, not draw a second one');
  assert.match(peek, /export function setFaceRenderer/,
    'the SVG card-art system needs a seam to swap the face in');
  assert.match(peek, /removeAttribute\('data-card-id'\)/,
    'a cloned face must not duplicate a card id in the document (§0.4)');
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
