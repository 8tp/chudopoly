#!/usr/bin/env node
/**
 * tools/screenshot.mjs — the §8 human/critic review set, and (new in P7 round 1)
 * a gate on the review set's own honesty.
 *
 * Round-1 finding this tool now blocks:
 *
 *   • `targeting@desktop.png` was BYTE-IDENTICAL to `big-hand@desktop.png`
 *     (md5 verified), because targeting is a CLIENT-SIDE mode that no recorded
 *     server snapshot can encode. Two names, one picture, and the entire review
 *     round had zero visual evidence of the targeting/selection moment. Fixed
 *     three ways: shots may now DRIVE the client into a mode before capture and
 *     must ASSERT they got there (`drive` + `expect`); every PNG is hashed and
 *     any two differently-named shots sharing a hash FAIL the gate.
 *   • The look critic found truncated text in every single in-game shot
 *     ('Midnigh Requisi', 'ACTIO', 'YOU…'). Nothing measured text fit, so it
 *     shipped. Now each shot runs tools/lib/audit.mjs's clipped-text pass in the
 *     page and any card/HUD string that does not fit its box FAILS.
 *   • Six surfaces had no shot at all: settings, side panel/log, emote, discard,
 *     the armed board at both viewports, and landscape. All added.
 *
 * Output: tools/shots/<name>@<screen>.png plus contactsheet.png.
 * §8 still says the review set is not PIXEL-gated (no imagediff) — these
 * assertions are about the set being complete and truthful, not about pixels.
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import {
  FIXTURE_DIR, SHOT_DIR, DESKTOP, PHONE, PHONE_DPR, PHONE_UA, LANDSCAPE, SEED,
  parseArgs, ensureDir, launchBrowser, openPage, requireBridge, readJSON,
  green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import * as audit from './lib/audit.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

/* ─────────────────────── in-page drivers (client-side modes) ──────────────
 * These run inside the page after the fixture is applied. They exist because
 * some of the most important moments in this game are not server state:
 * targeting, payment selection, discard picking, sheets and overlays are all
 * client modes. A "fixture" for them is a state plus a gesture.
 * Each returns a string describing what it reached; screenshot.mjs compares it
 * to the shot's `expect` and FAILS the shot if it does not match.
 * ------------------------------------------------------------------------ */
const DRIVERS = {
  /** Tap hand cards until one enters target mode, then stop and hold it. */
  targeting: async () => {
    const hand = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    for (const card of hand) {
      card.click();
      await new Promise((r) => setTimeout(r, 80));
      const play = document.querySelector('[data-action="play-card"]:not([disabled])');
      if (play) { play.click(); await new Promise((r) => setTimeout(r, 140)); }
      if (window.__CHUD.mode?.kind === 'target') {
        return `target:${window.__CHUD.mode.needs?.[0] || '?'}`;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    return `stuck:${window.__CHUD.mode?.kind || 'none'}`;
  },
  /** Open payment selection and select cards, so the confirm bar is live. */
  payment: async () => {
    const begin = document.querySelector('[data-action="begin-payment"]');
    if (begin) { begin.click(); await new Promise((r) => setTimeout(r, 180)); }
    const cards = [...document.querySelectorAll('[data-payable="1"], [data-zone="bank"] [data-card-id]')];
    for (const c of cards.slice(0, 3)) { c.click(); await new Promise((r) => setTimeout(r, 60)); }
    return `mode:${window.__CHUD.mode?.kind || 'none'}`;
  },
  /** End turn over the hand limit → discard picker. */
  discard: async () => {
    const et = document.getElementById('btn-end-turn');
    if (et) { et.click(); await new Promise((r) => setTimeout(r, 220)); }
    const cards = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    if (window.__CHUD.mode?.kind === 'discard' && cards[0]) {
      cards[0].click(); await new Promise((r) => setTimeout(r, 80));
    }
    return `mode:${window.__CHUD.mode?.kind || 'none'}`;
  },
  settings: async () => {
    document.querySelector('#hud [data-action="settings"]')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },
  emote: async () => {
    document.getElementById('btn-emote')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },
  side: async () => {
    document.querySelector('#hud [data-action="toggle-side"]')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('side')?.hidden === false ? 'side:open' : 'side:closed';
  },
  help: async () => {
    document.querySelector('#hud [data-action="help"], [data-action="help"]')?.click();
    await new Promise((r) => setTimeout(r, 360));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },
};

/**
 * §8 shot list. `fixture` names a file in tools/fixtures/; `at` picks a state
 * INDEX inside a transcript; `screen` restricts a shot to one viewport;
 * `drive` names a DRIVERS entry run after the state is applied; `expect` is a
 * prefix the driver's return value must start with or the shot FAILS.
 */
const SHOTS = [
  { name: 'home', route: '/?harness=1', fixture: null },
  { name: 'help', fixture: null, drive: 'help', expect: 'sheet:open' },
  { name: 'lobby', fixture: 'lobby' },
  { name: 'early-game', fixture: 'early-game' },
  { name: 'mid-game', fixture: 'mid-game' },
  { name: 'big-hand', fixture: 'big-hand' },
  // The four client-side moments the round-1 set could not show at all.
  { name: 'targeting', fixture: 'targeting', drive: 'targeting', expect: 'target:' },
  { name: 'payment', fixture: 'payment-pending', drive: 'payment', expect: 'mode:payment' },
  { name: 'discard', fixture: 'discard-limit', drive: 'discard', expect: 'mode:discard' },
  { name: 'opsec-decision', fixture: 'opsec-decision' },
  { name: 'opsec-chain', fixture: 'opsec-chain' },
  // Chrome surfaces that had no shot at all.
  { name: 'settings', fixture: 'mid-game', drive: 'settings', expect: 'sheet:open' },
  { name: 'side-log', fixture: 'mid-game', drive: 'side', expect: 'side:open' },
  { name: 'emote', fixture: 'mid-game', drive: 'emote', expect: 'sheet:open' },
  { name: 'five-player', fixture: 'five-player' },
  { name: 'final-approach', fixture: 'final-approach' },
  { name: 'win', fixture: 'finished' },
  // Landscape — the viewport where `.self-board` was 0px tall and no shot looked.
  { name: 'landscape-mid', fixture: 'mid-game', screen: 'landscape' },
  { name: 'landscape-armed', fixture: 'final-approach', screen: 'landscape' },
  // Arc slices: one real game, six moments (§9 — reachable states only).
  { name: 'arc-1', fixture: 'arc', at: 0 },
  { name: 'arc-2', fixture: 'arc', at: 1 },
  { name: 'arc-3', fixture: 'arc', at: 2 },
  { name: 'arc-4', fixture: 'arc', at: 3 },
  { name: 'arc-5', fixture: 'arc', at: 4 },
  { name: 'arc-6-late', fixture: 'arc', at: 5 },
];

const SCREENS = [
  { tag: 'desktop', viewport: DESKTOP, dpr: 1 },
  { tag: 'phone', viewport: PHONE, dpr: PHONE_DPR, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  { tag: 'landscape', viewport: LANDSCAPE, dpr: 2, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
];

/** Shots that only exist on one screen still have to be asked for by name. */
const screenTakes = (shot, tag) => (shot.screen ? shot.screen === tag : tag !== 'landscape');

console.log(bold('screenshot') + dim(`  ${SHOTS.length} shots × ${SCREENS.length} screens → tools/shots/`));

function loadStates(name) {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  const f = readJSON(file);
  return Array.isArray(f) ? f : f.states;
}

ensureDir(SHOT_DIR);
const server = await startServer({ seed });
let browser = null;
let code = EXIT_PASS;
const captured = [];
const hashes = new Map();          // sha1 → first shot that produced it
const clipped = [];                // {shot, items[]}
const problems = [];

const fail = (m) => { code = EXIT_FAIL; problems.push(m); console.log(`  ${red('✗')} ${m}`); };

try {
  browser = await launchBrowser();

  for (const screen of SCREENS) {
    const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`, screen);
    await requireBridge(h.page, 8000);

    for (const shot of SHOTS) {
      if (!screenTakes(shot, screen.tag)) continue;
      const label = `${shot.name}@${screen.tag}`;
      try {
        // Every shot gets a full page reload on a unique URL. Without it, state
        // bleeds between shots — a sheet left open by one shot stayed open over
        // every later capture.
        const u = new URL(shot.route || '/?harness=1', server.url);
        u.searchParams.set('seed', seed);
        u.searchParams.set('shot', shot.name);
        await h.page.goto(u.href, { waitUntil: 'load', timeout: 20000 });
        await requireBridge(h.page, 8000);
        if (shot.fixture) {
          const states = loadStates(shot.fixture);
          if (!states?.length) {
            fail(`${label} — fixture ${shot.fixture}.json missing; run npm run tool:record`);
            continue;
          }
          const idx = shot.at == null ? states.length - 1 : (shot.at < 0 ? states.length + shot.at : shot.at);
          const state = states[Math.max(0, Math.min(states.length - 1, idx))];
          await h.page.evaluate((s) => {
            window.__CHUD.applyState(s);
            window.__CHUD.drainEvents?.();
          }, state);
          await h.page.waitForTimeout(120);
        }

        /* ---- drive into the client-side mode this shot is ABOUT ---------- */
        if (shot.drive) {
          const reached = await h.page.evaluate(DRIVERS[shot.drive]);
          if (shot.expect && !String(reached).startsWith(shot.expect)) {
            // Capture anyway — the picture of the failure is the evidence — but
            // the gate is red. A shot that silently degrades to "whatever the
            // fixture looked like" is exactly the round-1 targeting lie.
            fail(`${label} — driver '${shot.drive}' reached '${reached}', expected '${shot.expect}*'`);
          }
        }

        await h.page.waitForTimeout(180);

        /* ---- text fit, measured in the page at capture time -------------- */
        const clips = await h.page.evaluate(audit.auditClippedText);
        if (clips.length) clipped.push({ shot: label, items: clips });

        const file = path.join(SHOT_DIR, `${label}.png`);
        await h.page.screenshot({ path: file, animations: 'disabled', timeout: 15000 });
        const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
        if (hashes.has(hash)) {
          fail(`${label} is BYTE-IDENTICAL to ${hashes.get(hash)} — two names, one picture`);
        } else {
          hashes.set(hash, label);
        }
        captured.push({ name: `${shot.name} · ${screen.tag}`, file });
        console.log(`  ${green('✓')} ${shot.name.padEnd(16)} ${dim(screen.tag)}${clips.length ? yellow(`  ${clips.length} clipped`) : ''}`);
      } catch (e) {
        fail(`${label} — ${e.message.split('\n')[0]}`);
      }
    }

    if (h.errors.length) {
      fail(`${h.errors.length} console/page error(s) on ${screen.tag}`);
      for (const e of h.errors.slice(0, 5)) console.log(red(`      ${e}`));
    }
    await h.close();
  }

  /* ---- clipped text verdict ----------------------------------------------
   * The look critic read 'Midnigh Requisi' and 'ACTIO' off shipped shots. A
   * screenshot review cannot be trusted to catch this every round; measurement
   * can. Reported per shot with the string and the pixels it needed.            */
  if (clipped.length) {
    const total = clipped.reduce((n, c) => n + c.items.length, 0);
    fail(`${total} clipped/overflowing text run(s) across ${clipped.length} shot(s) — card and HUD text must fit its box`);
    for (const c of clipped.slice(0, 8)) {
      console.log(dim(`      ${c.shot}:`));
      for (const it of c.items.slice(0, 4)) {
        console.log(dim(`        ${it.el} "${it.text}" needs ${it.need}px, has ${it.have}px (${it.axis})`));
      }
    }
  } else {
    console.log(`  ${green('✓')} no clipped card/HUD text in any shot`);
  }

  /* ---- contact sheet ------------------------------------------------------ */
  if (captured.length) {
    const COLS = 4;
    const CELL_W = 320;
    const CELL_H = 200;
    const rows = Math.ceil(captured.length / COLS);
    const sheet = new PNG({ width: COLS * CELL_W, height: rows * CELL_H, filterType: 4 });
    sheet.data.fill(12); // near-black backing — §6 is dark-only; a white sheet lies about contrast
    for (let i = 0; i < sheet.data.length; i += 4) sheet.data[i + 3] = 255;

    captured.forEach((shot, i) => {
      const src = PNG.sync.read(fs.readFileSync(shot.file));
      const scale = Math.min(CELL_W / src.width, CELL_H / src.height);
      const dw = Math.max(1, Math.floor(src.width * scale));
      const dh = Math.max(1, Math.floor(src.height * scale));
      const ox = (i % COLS) * CELL_W + Math.floor((CELL_W - dw) / 2);
      const oy = Math.floor(i / COLS) * CELL_H + Math.floor((CELL_H - dh) / 2);
      // Nearest-neighbour box sample. A contact sheet is for "is this shot
      // obviously broken", not for judging aliasing.
      for (let y = 0; y < dh; y++) {
        const sy = Math.min(src.height - 1, Math.floor(y / scale));
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(src.width - 1, Math.floor(x / scale));
          const si = (sy * src.width + sx) * 4;
          const di = ((oy + y) * sheet.width + ox + x) * 4;
          sheet.data[di] = src.data[si];
          sheet.data[di + 1] = src.data[si + 1];
          sheet.data[di + 2] = src.data[si + 2];
          sheet.data[di + 3] = 255;
        }
      }
    });

    const sheetFile = path.join(SHOT_DIR, 'contactsheet.png');
    fs.writeFileSync(sheetFile, PNG.sync.write(sheet));
    fs.writeFileSync(
      path.join(SHOT_DIR, 'index.json'),
      JSON.stringify({
        seed,
        generatedAt: new Date().toISOString(),
        shots: captured.map((c) => path.basename(c.file)),
        clipped,
        problems,
      }, null, 1)
    );
    console.log(`  ${green('✓')} contactsheet.png ${dim(`${COLS}×${rows}, ${captured.length} tiles`)}`);
    console.log(`  ${green('✓')} ${hashes.size} distinct image(s) from ${captured.length} shot(s)`);
  } else {
    fail('nothing captured');
  }
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('screenshot: PASS')) : red(bold(`screenshot: FAIL (${problems.length})`)));
process.exit(code);
