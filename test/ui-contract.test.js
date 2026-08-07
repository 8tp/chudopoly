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
    // §3.1c REPLACES §3.3. Surge Ops is rent-only and it stacks; the old
    // "next charge" wording is asserted ABSENT below, in the behavioural gate.
    [/next RENT/i, '§3.1c Surge Ops doubles the next RENT'],
    [/stacks?\b/i, '§3.1c Surge Ops stacks'],
    [/surrender every card you own/i, '§3.4 zero-value wilds still count'],
    [/holds its set size/i, '§3.5 zone cap'],
    // §3.1b REPLACES §3.7. All three of these are proved against the engine in
    // the behavioural gate below before they are demanded of the copy.
    [/hand (?:it|either) over as payment/i, '§3.1b upgrades ARE payable'],
    [/drop into your own bank|banks itself if the set breaks/i,
      '§3.1b upgrades BANK on a set break'],
    [/move it to another complete set for free|moves free between complete sets/i,
      '§3.1b upgrades move free between complete sets'],
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

  // "threeth". countWord() is the cardinal; an ordinal needs a real ordinal.
  assert.doesNotMatch(brief, /countWord\([^)]*\)\}th/,
    'countWord(n) + "th" prints "threeth" — use an ordinal');
});

/* ── §3.9, MEASURED: the copy is checked against the engine's behaviour ────
 *
 * ROUND 2 POST-MORTEM. Every assertion above this line is `assert.match` over
 * source text, and that is exactly how a rules round rewrote §3.1/§3.1b/§3.1c
 * underneath a client whose copy still said the opposite while `npm test`
 * stayed 187/187 green: the gate pinned the sentences the copy happened to
 * contain, so keeping them RIGHT and keeping them STALE were the same thing.
 *
 * The client is plain ESM with no DOM dependency below ui/, so the gates below
 * IMPORT core/cards.js and state/selectors.js, feed them a real getPlayerView()
 * snapshot, and compare the answer against the engine running the same board.
 * A rule change now breaks the gate from the ENGINE side, whatever the copy
 * says — and the string assertions that remain are anchored to a fact this file
 * has just proved.
 */

const game = require('../game.js');

/** A two-seat game with `build(a, b)` applied to the boards, `who` to move. */
function fixture(build, { who = 'b', preset } = {}) {
  const state = game.createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    preset ? { seed: 'gate', preset } : { seed: 'gate' });
  const a = game.getPlayer(state, 'a');
  const b = game.getPlayer(state, 'b');
  for (const p of [a, b]) { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; }
  build(a, b);
  state.currentPlayerIndex = state.players.findIndex(p => p.id === who);
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  state.pendingAction = null;
  return { state, a, b };
}

const prop = (id, color, name, value = 4) => ({ id, type: 'property', name, color, value });
const wild = (id, color) =>
  ({ id, type: 'wild_property', name: 'Wild Property', colors: ['any'], value: 0, placedColor: color });
const upgradeCard = (id, kind, color) => ({
  id, type: 'action', action: kind === 'hotel' ? 'foc' : 'upgrade',
  name: kind === 'hotel' ? 'Full Operational Capability' : 'Upgrade',
  value: kind === 'hotel' ? 4 : 3, upgradeType: kind, placedColor: color,
});

/** Load a real broadcast into the real client store, seated as `seat`. */
async function client(state, seat = 'a') {
  const store = await import('../public/src/state/store.js');
  const sel = await import('../public/src/state/selectors.js');
  store.reset();
  store.store.snapshot = game.getPlayerView(state, seat);
  store.setSelf(seat, seat.toUpperCase());
  store.store.room.players = state.players.map(p => ({ id: p.id, name: p.name }));
  return { sel, store: store.store };
}

test('§3.1b the client offers EXACTLY the cards the engine accepts as payment', async () => {
  // THE WEDGE, as a gate. game.js processPayment() only allows a short payment
  // when `selectedCardIds.length === payableCards(payer).length`, so a client
  // payable set that is even one card smaller than the engine's is a SOFTLOCK,
  // not a cosmetic difference: "surrender everything" hands over fewer cards
  // than the engine counts, the short-payment branch refuses, and the
  // pendingAction never clears.
  const boards = {
    'bank + properties + upgrades': (a) => {
      a.bank = [{ id: 1, type: 'money', name: '2M', value: 2 }];
      a.properties.red = [prop(2, 'red', 'F-22'), prop(3, 'red', 'F-16'), prop(4, 'red', 'F-35')];
      a.upgrades.red = [upgradeCard(5, 'house', 'red'), upgradeCard(6, 'hotel', 'red')];
    },
    // The reproduced wedge: every property is a zero-value wild, so the ONLY
    // value on the board is in the upgrades. netWorth 7, payable value 7.
    'a zero-value set carrying an Upgrade + FOC': (a) => {
      a.properties.darkblue = [wild(1, 'darkblue'), wild(2, 'darkblue')];
      a.upgrades.darkblue = [upgradeCard(3, 'house', 'darkblue'), upgradeCard(4, 'hotel', 'darkblue')];
    },
    'nothing at all': () => {},
  };

  for (const [label, build] of Object.entries(boards)) {
    const { state, a } = fixture(build);
    const { sel } = await client(state, 'a');
    assert.deepEqual(
      sel.payableCards().map(c => c.id).sort(),
      game.payableCards(a).map(c => c.id).sort(),
      `client payable set != engine payable set on: ${label}`);
  }

  // And the wedge board can now actually settle a debt it cannot cover.
  const { state, a, b } = fixture(boards['a zero-value set carrying an Upgrade + FOC']);
  const view = game.getPlayerView(state, 'a').players.find(p => p.id === 'a');
  assert.equal(view.netWorth, 7, 'the HUD prints 7M of net worth on this board');
  assert.equal(view.payableValue, view.netWorth,
    '§3.1b: playerNetWorth() === playerTotalValue(), so there is nothing to warn about');

  b.hand = [{ id: 90, type: 'action', action: 'finance_office', name: 'Finance Office', value: 3 }];
  assert.ok(game.playAction(state, 'b', 0, { targetId: 'a' }).ok);
  assert.equal(state.pendingAction.amount, 5, 'owes 5M against 0M of bankable property');

  const { sel } = await client(state, 'a');
  const everything = sel.payableCards().map(c => c.id);
  assert.equal(everything.length, 4);
  assert.deepEqual(game.respondToAction(state, 'a', 'accept', everything), { ok: true },
    'surrendering everything the client offers must satisfy the engine');
  assert.equal(state.pendingAction, null, 'the payment must clear the pending action');

  // Proof that the OLD client set wedged: bank + properties only, no upgrades.
  const again = fixture(boards['a zero-value set carrying an Upgrade + FOC']);
  again.b.hand = [{ id: 90, type: 'action', action: 'finance_office', name: 'FO', value: 3 }];
  game.playAction(again.state, 'b', 0, { targetId: 'a' });
  const withoutUpgrades = Object.values(again.a.properties).flat().map(c => c.id);
  assert.match(game.respondToAction(again.state, 'a', 'accept', withoutUpgrades).error || '',
    /surrender every card/i, 'the pre-fix selection is still refused by the engine');
  assert.ok(again.state.pendingAction, 'and that refusal is the softlock this gate guards');

  // The copy that told players otherwise must not come back.
  const brief = read('public/src/ui/help.js') + read('public/src/core/cards.js')
    + read('public/src/ui/details.js');
  assert.doesNotMatch(brief, /never be handed over as payment|[Nn]ever payable/,
    'upgrades are payable (game.js payableCards) — the disproved claim must not return');
  assert.doesNotMatch(brief, /counts in your net worth|counts in net worth/,
    'netWorth === payableValue, so there is no net-worth-only value to flag');
  assert.match(read('public/src/state/selectors.js'), /upgradeCards\(player\)/,
    'payableCards() must pull the upgrades in through one shared helper');
});

test('§3.1b upgrades BANK on a set break and MOVE free between complete sets', async () => {
  // Claim 1: the break banks them, stripped of their upgrade tags — it does not
  // discard them. game.js bankUpgradeCard().
  const { state, a, b } = fixture((pa) => {
    pa.properties.darkblue = [prop(1, 'darkblue', 'HQ'), prop(2, 'darkblue', 'Pentagon')];
    pa.upgrades.darkblue = [upgradeCard(3, 'house', 'darkblue')];
  }, { who: 'b' });
  b.hand = [{ id: 90, type: 'action', action: 'chud', name: 'THE CHUD CARD', value: 4 }];
  assert.ok(game.playAction(state, 'b', 0, { targetId: 'a', targetCardId: 1 }).ok);
  game.respondToAction(state, 'a', 'accept', []);
  assert.equal(game.isSetComplete(a, 'darkblue'), false, 'the set is broken');
  assert.deepEqual(a.upgrades, {}, 'the upgrade left the set');
  assert.deepEqual(a.bank.map(c => c.id), [3], 'and landed in the OWNER\'s bank, not the discard');
  assert.equal(a.bank[0].upgradeType, undefined, 'stripped, so it renders as an ordinary card');
  assert.equal(state.discardPile.some(c => c.id === 3), false, 'nothing was discarded');

  // Claim 2: moveUpgrade() costs no play, and the client can reach it.
  const moved = fixture((pa) => {
    pa.properties.darkblue = [prop(1, 'darkblue', 'HQ'), prop(2, 'darkblue', 'Pentagon')];
    pa.properties.intel = [prop(5, 'intel', 'SIGINT'), prop(6, 'intel', 'HUMINT')];
    pa.upgrades.darkblue = [upgradeCard(3, 'house', 'darkblue')];
  }, { who: 'a' });
  moved.state.playsRemaining = 0;                       // no plays left at all
  const { sel } = await client(moved.state, 'a');
  assert.deepEqual(sel.upgradeMoveColors(3), ['intel'],
    'the client must offer the same destination the engine accepts');
  assert.deepEqual(game.moveProperty(moved.state, 'a', 3, 'intel'), { ok: true },
    'moveProperty routes an upgrade to moveUpgrade() and it costs no play');
  assert.equal(moved.state.playsRemaining, 0, 'and it really did cost no play');
  // The engine refuses an incomplete destination; the client must not offer one.
  assert.match(game.moveProperty(moved.state, 'a', 3, 'red').error, /not a complete set/);

  const brief = read('public/src/ui/help.js') + read('public/src/core/cards.js');
  assert.doesNotMatch(brief, /discarded if the set breaks|go to the discard the moment the set/i,
    'upgrades are banked, not discarded — the disproved claim must not return');
});

test('§3.1c Surge Operations stacks, and the client neither blocks it nor mis-multiplies', async () => {
  // The engine, driven: two copies are legal and rent is x4. Finance Office and
  // Roll Call are NOT surged at any stack depth — chargeAmount() passes
  // surgeable:true from the rent branch only.
  const charges = (stack) => {
    const { state, a } = fixture((pa) => {
      pa.properties.red = [prop(1, 'red', 'F-22'), prop(2, 'red', 'F-16'), prop(3, 'red', 'F-35')];
    }, { who: 'a' });
    state.playsRemaining = 9;
    for (let i = 0; i < stack; i++) {
      a.hand = [{ id: 500 + i, type: 'action', action: 'surge_ops', name: 'Surge Ops', value: 1 }];
      const res = game.playAction(state, 'a', 0, {});
      assert.ok(res.ok, `the engine refused Surge Ops #${i + 1}: ${res.error}`);
    }
    const view = game.getPlayerView(state, 'a');
    const fire = (card, opts) => {
      const copy = JSON.parse(JSON.stringify(state));
      copy.players[copy.players.findIndex(p => p.id === 'a')].hand = [card];
      return game.playAction(copy, 'a', 0, opts).ok ? copy.pendingAction.amount : null;
    };
    return {
      surgeOps: view.surgeOps,
      surgeMultiplier: view.surgeMultiplier,
      rent: fire({ id: 900, type: 'rent', name: 'Rent', colors: ['red', 'yellow'], value: 1 },
        { targetColor: 'red' }),
      financeOffice: fire({ id: 901, type: 'action', action: 'finance_office', name: 'FO', value: 3 },
        { targetId: 'b' }),
      rollCall: fire({ id: 902, type: 'action', action: 'roll_call', name: 'RC', value: 2 }, {}),
    };
  };
  assert.deepEqual(charges(0), { surgeOps: 0, surgeMultiplier: 1, rent: 6, financeOffice: 5, rollCall: 2 });
  assert.deepEqual(charges(1), { surgeOps: 1, surgeMultiplier: 2, rent: 12, financeOffice: 5, rollCall: 2 });
  assert.deepEqual(charges(2), { surgeOps: 2, surgeMultiplier: 4, rent: 24, financeOffice: 5, rollCall: 2 });

  // So: the client must not refuse the second copy...
  const { state, a } = fixture((pa) => {
    pa.properties.red = [prop(1, 'red', 'F-22')];
    pa.hand = [{ id: 500, type: 'action', action: 'surge_ops', name: 'Surge Ops', value: 1 }];
  }, { who: 'a' });
  state._surgeOps = 1;
  const { sel } = await client(state, 'a');
  assert.equal(sel.blockedReason(a.hand[0]), '',
    'the client refused a play the engine accepts (Surge Ops stacks)');

  // ...and the peek must read the shipped multiplier rather than a boolean.
  const details = read('public/src/ui/details.js');
  assert.match(details, /surgeMultiplier/,
    'getPlayerView ships surgeMultiplier (2**stack); a boolean cannot express x4');
  const context = /function actionContext[\s\S]*?\n\}/.exec(details);
  assert.ok(context, 'details.js must have actionContext()');
  assert.doesNotMatch(context[0], /each \* 2|each\*2/,
    'Finance Office and Roll Call are never surged — chargeAmount() surges rent only');
  const brief = read('public/src/ui/help.js') + read('public/src/core/cards.js') + details;
  for (const [gone, why] of [
    [/next charge you make this turn/i, 'it doubles RENT, not "the next charge"'],
    [/Roll Call, any demand/i, 'Finance Office and Roll Call are never surged'],
    [/One at a time/i, 'it stacks'],
    [/already active/i, 'a second copy is legal and makes it x4'],
    [/this charge is DOUBLED/i, 'two stacked copies are x4, not "doubled"'],
  ]) assert.doesNotMatch(brief, gone, `Surge Ops copy is stale: ${why}`);
});

test('§3.1 TDY Orders is guarded on BOTH sides, and the glow says so', async () => {
  // game.js playAction 'tdy_orders' runs zoneRequisitionable() over the target's
  // zone AND over mine. Drive every combination rather than trusting the source.
  const build = (a, b) => {
    a.properties.darkblue = [prop(1, 'darkblue', 'HQ'), prop(2, 'darkblue', 'Pentagon')];  // complete
    a.properties.red = [prop(3, 'red', 'F-22')];                                            // loose
    b.properties.intel = [prop(4, 'intel', 'SIGINT'), prop(5, 'intel', 'HUMINT')];          // complete
    b.properties.green = [prop(6, 'green', 'Elite')];                                       // loose
  };
  const tdy = (myCardId, targetCardId) => {
    const { state, a } = fixture(build, { who: 'a' });
    a.hand = [{ id: 90, type: 'action', action: 'tdy_orders', name: 'TDY Orders', value: 3 }];
    return game.playAction(state, 'a', 0, { targetId: 'b', targetCardId, myCardId });
  };
  assert.match(tdy(1, 6).error, /out of one of your complete sets/, 'my set is guarded');
  assert.match(tdy(3, 4).error, /cannot touch a complete set/, 'their set is guarded');
  assert.match(tdy(1, 4).error, /complete set/, 'both at once is guarded');
  assert.ok(tdy(3, 6).ok, 'loose for loose is the only legal TDY');
  // CHUD is the one card that still reaches into a complete set.
  const chud = fixture(build, { who: 'a' });
  chud.a.hand = [{ id: 91, type: 'action', action: 'chud', name: 'THE CHUD CARD', value: 4 }];
  assert.ok(game.playAction(chud.state, 'a', 0, { targetId: 'b', targetCardId: 4 }).ok,
    'CHUD is unguarded — that, and giving nothing back, is what makes it unique');

  // The client must glow exactly the legal cards, on both boards.
  const { state } = fixture(build, { who: 'a' });
  const { sel } = await client(state, 'a');
  assert.deepEqual(sel.tradeableProps().map(x => x.card.id), [3],
    'only my loose property may be offered');
  assert.deepEqual(sel.stealableCards('b', 'tdy_orders').map(x => x.card.id), [6],
    'only their loose property is a legal TDY target');
  assert.deepEqual(sel.stealableCards('b', 'midnight_requisition').map(x => x.card.id), [6],
    'Midnight Requisition is guarded the same way');
  assert.deepEqual(sel.stealableCards('b', 'chud').map(x => x.card.id).sort(), [4, 5, 6],
    'CHUD reaches everything');

  const brief = read('public/src/ui/help.js') + read('public/src/core/cards.js');
  assert.doesNotMatch(brief, /trades? INTO a complete set|complete set is not safe from/i,
    'TDY can no longer touch a complete set — the disproved claim must not return');
  assert.match(brief, /gives nothing back|give nothing back/i,
    'CHUD must still be described by what makes it unique');
});

test('pureSetRequired: the client counts sets the way zoneIsSet() does', async () => {
  const cards = await import('../public/src/core/cards.js');
  const wildsOnly = (p) => { p.properties.darkblue = [wild(1, 'darkblue'), wild(2, 'darkblue')]; };
  const mixed = (p) => { p.properties.intel = [wild(3, 'intel'), prop(4, 'intel', 'SIGINT', 2)]; };

  for (const preset of ['chudopoly', 'mdFaithful']) {
    const { state, a } = fixture((pa) => { wildsOnly(pa); mixed(pa); }, { who: 'a', preset });
    const { sel } = await client(state, 'a');
    const flags = sel.activeRuleFlags();
    assert.equal(flags.pureSetRequired, game.rulesOf(a).pureSetRequired,
      `${preset}: the client must read the flag off the broadcast ruleset`);
    for (const color of ['darkblue', 'intel']) {
      assert.equal(cards.isComplete(a, color, flags), game.isSetComplete(a, color),
        `${preset}/${color}: client isComplete disagrees with engine isSetComplete`);
      assert.equal(cards.requisitionable(a, color, flags), game.zoneRequisitionable(a, color),
        `${preset}/${color}: client requisitionable disagrees with zoneRequisitionable`);
    }
    // The swatch row and the number printed beside it must agree.
    assert.equal(sel.completeSetsOf('a').length, game.completedSets(a),
      `${preset}: the win overlay's swatches must match the engine's completedSets count`);
  }
  // The rule is "at least one real property", not "no wilds" — one wild and one
  // property IS a set under MD Faithful.
  const md = fixture(mixed, { who: 'a', preset: 'mdFaithful' });
  assert.equal(game.isSetComplete(md.a, 'intel'), true);
  assert.doesNotMatch(read('public/src/ui/help.js'), /no wilds in a winning set/,
    'pureSetRequired takes ONE real property; it does not ban wilds');
});

test('the journal surfaces every ending basis and the non-converting checkpoint', () => {
  const journal = read('public/src/ui/journal.js');

  // Drive the engine to the exact beat, so the gate fails when the engine stops
  // emitting it as well as when the client stops wording it.
  const state = game.createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], { seed: 'fa' });
  const a = game.getPlayer(state, 'a');
  a.properties = {
    darkblue: [prop(1, 'darkblue', 'HQ'), prop(2, 'darkblue', 'Pentagon')],
    intel: [prop(3, 'intel', 'SIGINT'), prop(4, 'intel', 'HUMINT')],
    brown: [prop(5, 'brown', 'MQ-9'), prop(6, 'brown', 'RQ-4')],
  };
  // Arm A on someone else's turn, so A's own next turn falls INSIDE the window.
  state.currentPlayerIndex = state.players.findIndex(p => p.id === 'b');
  a.finalApproach = true;
  a.armedAtTurn = state.turnCounter;
  for (let i = 0; i < 6 && !state.winner; i++) game.forceEndTurn(state);
  const pending = (state.events || []).find(ev => ev.t === 'final_approach_pending');
  assert.ok(pending, 'game.js resolveFinalApproach must still emit final_approach_pending');
  for (const field of ['actor', 'sets', 'checkpointTurn']) {
    assert.ok(field in pending, `the event must carry ${field}`);
  }
  const skip = /const SKIP = new Set\(\[([\s\S]*?)\]\)/.exec(journal);
  assert.ok(skip, 'journal.js must declare SKIP');
  assert.doesNotMatch(skip[1], /final_approach_pending/,
    'the engine\'s own answer to "why didn\'t I win on my own turn?" must not be dropped');
  assert.match(journal, /case 'final_approach_pending'/, 'and it must have a beat');
  assert.match(journal, /checkpointTurn/, 'the beat must print the turn the win locks in on');

  // Every stalemate basis endInStalemate() can publish needs wording, in the
  // journal AND on the win overlay.
  const bases = /let basis = '(\w+)'/.exec(read('game.js'));
  assert.ok(bases, 'game.js endInStalemate must declare a default basis');
  const overlays = read('public/src/ui/overlays.js');
  for (const basis of ['sets', 'net_worth', 'turn_order', 'unopposed']) {
    assert.match(journal, new RegExp(basis), `journal has no wording for basis ${basis}`);
    assert.match(overlays, new RegExp(`case '${basis}'`), `overlay has no copy for basis ${basis}`);
  }
});

/* ── P7 round 1: the defects fresh critics proved, kept fixed ────────────── */

test('§P7.14 the CHUD/TDY distinction is whatever the engine currently makes it', () => {
  // ROUND 2: this test used to assert that TDY "trades into a set". §3.1 then
  // reversed that rule and the test kept the false sentence pinned in place —
  // which is how the drift survived a rules round with the suite green. So it
  // no longer asserts a remembered distinction: it MEASURES which action cards
  // can reach into a complete set, and demands the copy match that answer.
  const { state, a } = fixture((pa, pb) => {
    pa.properties.red = [prop(1, 'red', 'F-22')];                                   // loose, to offer
    pb.properties.intel = [prop(2, 'intel', 'SIGINT'), prop(3, 'intel', 'HUMINT')]; // complete
  }, { who: 'a' });

  const canReachACompleteSet = (action, opts) => {
    const copy = JSON.parse(JSON.stringify(state));
    copy.players[copy.players.findIndex(p => p.id === 'a')].hand =
      [{ id: 90, type: 'action', action, name: action, value: 3 }];
    return !game.playAction(copy, 'a', 0, opts).error;
  };
  const reach = {
    chud: canReachACompleteSet('chud', { targetId: 'b', targetCardId: 2 }),
    tdy_orders: canReachACompleteSet('tdy_orders', { targetId: 'b', targetCardId: 2, myCardId: 1 }),
    midnight_requisition: canReachACompleteSet('midnight_requisition', { targetId: 'b', targetCardId: 2 }),
  };
  assert.deepEqual(reach, { chud: true, tdy_orders: false, midnight_requisition: false },
    'the set of cards that can rob a complete set changed — the help copy must be rewritten '
    + 'to match, and this gate updated from the engine, not from memory');
  assert.ok(a);

  const brief = read('public/src/ui/help.js') + read('public/src/core/cards.js');
  // Since CHUD is the only one, that exclusivity is now TRUE and must be stated.
  assert.match(brief, /only card in the deck that can (?:reach into|touch)/i,
    'CHUD is the only card that can touch a complete set — say so');
  assert.match(brief, /gives nothing back|give nothing back/i,
    'and it must still be described by the thing that survives every rules round');
  assert.match(brief, /Neither card may come out of a/i,
    'TDY is guarded on BOTH sides — the copy must say so, since the engine does');
  assert.match(brief, /refuses? it on YOUR side of the trade/i,
    'and the Goal page must say it too — the guard on my own board is the surprising half');
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
