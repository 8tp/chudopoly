// test/flightlog.test.js — the flight log's derivation, and the three rules the
// data layer imposes on its surface.
//
// `public/src/ui/stats.js` splits deliberately into a PURE half (`foldRows`,
// `derive`) and a DOM half (`show`), so the arithmetic can be held against real
// recorded rows here while the rendering is gated by the harness
// (`tools/screenshot.mjs` drives it at four populations and asserts on what it
// found). This file is the arithmetic half.
//
// Three of the assertions below are SOURCE assertions rather than behavioural
// ones, and that is on purpose: "never display botModes" and "never say
// Lifetime" are prohibitions on the whole file, not on one code path. A
// behavioural test can only prove the paths it walked; a source test cannot be
// routed around by adding a branch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { stats, defaultRow, STATS_KEY } from '../public/src/state/stats.js';
import { derive, foldRows, TEXTURE_MIN, FORM_MAX } from '../public/src/ui/stats.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PANEL = path.join(ROOT, 'public/src/ui/stats.js');
const LOGBOOK = path.join(ROOT, 'tools/fixtures/logbook.json');

const source = readFileSync(PANEL, 'utf8');
/** Comments explain the rules; only executable text can break them. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

/** Bank `rows` through the SHIPPING store and hand back its data. */
function bank(rows) {
  stats.load({ storage: new MemoryStorage() });
  for (const r of rows) stats.recordGame(r);
  const data = stats.data;
  stats.load({ storage: null });
  return data;
}

function row(over = {}) {
  return { ...defaultRow(), turns: 30, humans: 1, bots: 2, seats: 3, ...over };
}

/* ── rule 3: botModes is stored and never shown ──────────────────────────── */

test('the panel never reads botModes — the split exists, the display does not', () => {
  assert.equal(code.includes('botModes'), false,
    'ui/stats.js mentions botModes in executable code. It is recorded so the split exists the '
    + 'day the hiding rule changes; rendering it launders a deliberately hidden attribute '
    + 'through a different screen.');
  const d = derive(bank([row({ won: true, botModes: ['chud'] })]), 'all');
  assert.equal(JSON.stringify(d).includes('chud'), false,
    'derive() leaked a bot personality into what the panel renders');
});

/* ── rule 1: "Since {since}", never "Lifetime" ───────────────────────────── */

test('the panel dates the logbook and never claims a lifetime', () => {
  assert.match(code, /Since \$\{/,
    'nothing in ui/stats.js prints "Since {since}" — a browser-local record has to say so');
  assert.equal(/lifetime/i.test(code), false,
    'ui/stats.js uses the word "lifetime". localStorage is per-profile, editable from devtools '
    + 'and cleared with site data; framing it as a logbook is what makes the claim true.');
  const d = derive(bank([row({ won: true })]), 'all');
  assert.match(d.since, /^\d{4}-\d{2}-\d{2}$/, 'derive() must carry the stored ISO day through');
});

/* ── rule 2: a gapped row is an undercount ───────────────────────────────── */

test('a gapped flight counts as a flight and a result, and sets no personal best', () => {
  const clean = row({ won: true, turns: 40, biggest: 5, opsecDepth: 2 });
  // The same game, recorded across a reconnect: bigger numbers, but the client
  // only saw part of it, so none of them may claim a best.
  const gapped = row({ won: true, turns: 12, biggest: 99, opsecDepth: 9, gaps: 3 });

  const folded = foldRows([clean, gapped]);
  assert.equal(folded.flights, 2, 'both flights happened');
  assert.equal(folded.wins, 2, 'both were wins — that fact survives any hole in the record');
  assert.equal(folded.gapped, 1, 'the hole is counted, so the panel can say the totals are a floor');
  assert.equal(folded.biggestCharge, 5, 'a gapped row must not set the biggest charge');
  assert.equal(folded.fastestWinTurns, 40, 'a gapped row must not set the fastest win');
  assert.equal(folded.opsecDepthBest, 2, 'a gapped row must not set the deepest OPSEC chain');

  // And the store agrees — the surface is not applying a rule of its own.
  const d = derive(bank([clean, gapped]), 'all');
  assert.equal(d.biggestCharge, 5);
  assert.equal(d.fastestWinTurns, 40);
  assert.equal(d.gapped, 1);
});

/* ── band 1: the denominator is never optional ───────────────────────────── */

test('the win rate is always rendered against its own denominator', () => {
  assert.match(code, /Won \$\{d\.wins\} of \$\{plural\(d\.flights/,
    'the rate and its count must be built together — a percentage over three flights rendered '
    + 'at display size is a lie, and the denominator is the only thing that stops it');
  const d = derive(bank([row({ won: true }), row(), row()]), 'all');
  assert.equal(d.rate, 33);
  assert.equal(d.flights, 3);
  assert.equal(d.wins, 1);
  assert.equal(d.losses, 2);
});

test('an empty logbook derives to no rate at all, never to 0%', () => {
  const d = derive(bank([]), 'all');
  assert.equal(d.rate, null, 'a rate over zero flights is not 0%, it is nothing');
  assert.equal(d.flights, 0);
  assert.ok(TEXTURE_MIN > 0);
});

/* ── segmentation ────────────────────────────────────────────────────────── */

test('the three scopes partition the logbook exactly', () => {
  const rows = [
    row({ won: true, humans: 1, bots: 2 }),      // vs bots
    row({ won: false, humans: 1, bots: 3 }),     // vs bots
    row({ won: true, humans: 2, bots: 1 }),      // vs people
  ];
  const data = bank(rows);
  const all = derive(data, 'all');
  const bots = derive(data, 'bots');
  const people = derive(data, 'people');

  assert.equal(all.flights, 3);
  assert.equal(bots.flights + people.flights, all.flights, 'the split must lose nobody');
  assert.equal(bots.wins + people.wins, all.wins);
  assert.equal(people.flights, 1);
  assert.equal(people.wins, 1);
  assert.equal(bots.flights, 2);
});

test('a human-only default would open on an empty panel — All must be the default', () => {
  // Every recorded game in this project's logs has exactly one human seat, and
  // that is what makes the default load-bearing rather than a preference.
  const data = bank([row({ won: true }), row()]);
  assert.equal(derive(data, 'people').flights, 0);
  assert.ok(derive(data, 'all').flights > 0);
  assert.match(code, /let scope = 'all'/, 'the panel must open on All');
});

/* ── the ring, and what the panel says about it ──────────────────────────── */

test('the form line is the tail of the window, newest last, capped', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(row({ won: i % 2 === 0, code: 'ABCD' }));
  const d = derive(bank(rows), 'all');
  assert.equal(d.form.length, FORM_MAX);
  assert.equal(d.form[d.form.length - 1].won, rows[rows.length - 1].won,
    'the last mark is the most recent flight');
});

test('when totals outrun the ring the panel is told, so it can name both windows', () => {
  const rows = [];
  for (let i = 0; i < 140; i++) rows.push(row({ won: i % 3 === 0 }));
  const data = bank(rows);
  const d = derive(data, 'all');
  assert.equal(d.recorded, 140, 'totals keep counting after a row rolls off the ring');
  assert.equal(d.detailed, 100, 'the ring is capped');
  assert.equal(d.rolled, true);
  // Band 1/2 come from `totals`, so they must NOT shrink to the ring.
  assert.equal(d.flights, 140);
  // And a personal best set on a row that has rolled off must still be there.
  assert.ok(d.fastestWinTurns > 0);
});

/* ── the real recording, when there is one ───────────────────────────────── */

test('the recorded logbook derives without throwing, in every scope', () => {
  if (!existsSync(LOGBOOK)) return;      // fixture is produced by tools/recordlog.mjs
  const f = JSON.parse(readFileSync(LOGBOOK, 'utf8'));
  stats.load({ storage: new MemoryStorage() });
  const data = (() => {
    const shim = new MemoryStorage();
    shim.setItem(STATS_KEY, JSON.stringify(f.blob));
    stats.load({ storage: shim });
    const d = stats.data;
    stats.load({ storage: null });
    return d;
  })();
  for (const scope of ['all', 'bots', 'people']) {
    const d = derive(data, scope);
    assert.ok(d.flights >= 0);
    assert.ok(d.wins <= d.flights, `${scope}: more wins than flights`);
    assert.equal(d.losses, d.flights - d.wins);
    if (d.flights > 0) assert.ok(d.rate >= 0 && d.rate <= 100);
  }
  const all = derive(data, 'all');
  assert.equal(all.flights, f.blob.totals.games,
    'band 1 must quote the stored total, not the ring');
});
