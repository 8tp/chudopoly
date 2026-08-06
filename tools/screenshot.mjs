#!/usr/bin/env node
/**
 * tools/screenshot.mjs — the §8 human/critic review set.
 *
 * Every shot is a recorded fixture (§9) pushed through __CHUD.applyState +
 * drainEvents, captured at desktop 1280×720 and phone 390×844. NOT pixel-gated
 * — §8 says review sets are for humans, imagediff arrives in P7.
 *
 * Output: tools/shots/<name>@<w>x<h>.png plus tools/shots/contactsheet.png,
 * composited with pngjs (pure JS, no native/binary dependency — §0.3 applies to
 * shipped assets, and these are gitignored build output either way).
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  FIXTURE_DIR, SHOT_DIR, DESKTOP, PHONE, PHONE_DPR, PHONE_UA, SEED,
  parseArgs, ensureDir, launchBrowser, openPage, requireBridge, readJSON,
  green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

/**
 * §8 shot list. `fixture` names a file in tools/fixtures/; `at` optionally
 * picks a state INDEX inside a transcript so one recorded game yields many
 * moments without re-recording. `screen` restricts a shot to one viewport.
 */
const SHOTS = [
  { name: 'home', route: '/?harness=1', fixture: null },
  { name: 'help', route: '/?harness=1#help', fixture: null },
  { name: 'lobby', fixture: 'lobby' },
  { name: 'early-game', fixture: 'early-game' },
  { name: 'mid-game', fixture: 'mid-game' },
  { name: 'big-hand', fixture: 'big-hand' },
  { name: 'targeting', fixture: 'targeting' },
  { name: 'payment', fixture: 'payment-pending' },
  { name: 'opsec-chain', fixture: 'opsec-chain' },
  { name: 'five-player', fixture: 'five-player' },
  { name: 'win', fixture: 'finished' },
  // Arc slices: one real game, six moments (§9 — reachable states only).
  { name: 'arc-1-opening', fixture: 'arc', at: 0 },
  { name: 'arc-2', fixture: 'arc', at: 1 },
  { name: 'arc-3', fixture: 'arc', at: 2 },
  { name: 'arc-4', fixture: 'arc', at: 3 },
  { name: 'arc-5-late', fixture: 'arc', at: 4 },
];

const SCREENS = [
  { tag: 'desktop', viewport: DESKTOP, dpr: 1 },
  { tag: 'phone', viewport: PHONE, dpr: PHONE_DPR, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
];

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

try {
  browser = await launchBrowser();

  for (const screen of SCREENS) {
    const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`, screen);
    await requireBridge(h.page, 8000);

    for (const shot of SHOTS) {
      if (shot.screen && shot.screen !== screen.tag) continue;
      try {
        if (shot.fixture) {
          const states = loadStates(shot.fixture);
          if (!states?.length) {
            console.log(`  ${yellow('!')} ${shot.name.padEnd(14)} ${dim(`fixture ${shot.fixture}.json missing`)}`);
            continue;
          }
          const idx = shot.at == null ? states.length - 1 : (shot.at < 0 ? states.length + shot.at : shot.at);
          const state = states[Math.max(0, Math.min(states.length - 1, idx))];
          await h.page.evaluate((s) => {
            window.__CHUD.applyState(s);
            window.__CHUD.drainEvents?.();
          }, state);
        } else if (shot.route) {
          await h.page.goto(`${server.url}${shot.route}`, { waitUntil: 'load', timeout: 20000 });
          await requireBridge(h.page, 8000);
        }
        await h.page.waitForTimeout(180);
        const file = path.join(SHOT_DIR, `${shot.name}@${screen.tag}.png`);
        await h.page.screenshot({ path: file, animations: 'disabled', timeout: 15000 });
        captured.push({ name: `${shot.name} · ${screen.tag}`, file });
        console.log(`  ${green('✓')} ${shot.name.padEnd(14)} ${dim(screen.tag)}`);
      } catch (e) {
        console.log(`  ${red('✗')} ${shot.name.padEnd(14)} ${dim(`${screen.tag}: ${e.message.split('\n')[0]}`)}`);
        code = EXIT_FAIL;
      }
    }

    if (h.errors.length) {
      console.log(`  ${red('✗')} ${h.errors.length} console/page error(s) on ${screen.tag}`);
      for (const e of h.errors.slice(0, 5)) console.log(red(`      ${e}`));
      code = EXIT_FAIL;
    }
    await h.close();
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
      JSON.stringify({ seed, generatedAt: new Date().toISOString(), shots: captured.map((c) => path.basename(c.file)) }, null, 1)
    );
    console.log(`  ${green('✓')} contactsheet.png ${dim(`${COLS}×${rows}, ${captured.length} tiles`)}`);
  } else {
    console.log(red('  ✗ nothing captured'));
    code = EXIT_FAIL;
  }
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('screenshot: PASS')) : red(bold('screenshot: FAIL')));
process.exit(code);
