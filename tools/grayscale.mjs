#!/usr/bin/env node
/**
 * tools/grayscale.mjs — ART-DIRECTION §10's grayscale ship gate, measured.
 *
 * The gate, verbatim from §10: "Grayscale `mid-game@desktop`: is hierarchy still
 * readable? Current: **fails**." §3 states the diagnosis: "everything sits
 * within ~8% luminance."
 *
 * A checklist item nobody can run is a wish. This turns it into two numbers.
 *
 * ─── what is measured ────────────────────────────────────────────────────
 * The frame is converted to **CIE L\*** (perceptual lightness, 0–100), not to
 * linear relative luminance. Linear Y is savagely compressed at the dark end —
 * a dark apron's whole tonal life happens between Y 0.019 and Y 0.035, a 1.6%
 * span that reads as "flat" in Y and as a visible 14 L\* to an eye — so a
 * threshold in Y either passes everything dark or fails everything dark.
 *
 *   1. BULK TONAL RANGE — p5→p95 of the L\* histogram. How much of the
 *      lightness axis the frame actually uses, ignoring the 5% of pixels at
 *      each end so that a single white glyph cannot buy a pass.
 *   2. TONAL TIERS — the five key regions (cards, the primary action, the
 *      apron, the HUD, the property mats) are averaged, sorted, and clustered
 *      with a 12 L\* break. **At least three tiers** must survive. This is
 *      "hierarchy" stated as a number: a grayscale print needs a foreground, a
 *      middle and a ground, and 12 L\* is about where a step stops being a
 *      rendering artefact and starts being a decision.
 *
 * A flat |figure − ground| difference was tried FIRST and rejected: ART §0 says
 * the cards are cream stock in BOTH themes and only the table changes, so the
 * ratified light theme deliberately puts L\* 97 card stock on L\* 88 concrete.
 * A gate demanding 25 L\* of card-vs-table separation fails the design it is
 * supposed to protect. Separation in the light theme is carried by shadow and
 * edge (§4 "paper casts a soft shadow"), not by bulk lightness. The number is
 * still PRINTED, as a diagnostic, because it is worth seeing — it is just not
 * the assertion.
 *
 * ─── calibration (measured 2026-08-06, seed 1337, 1280×720, settled frames) ─
 * `--prove` re-measures the four synthetic rows on demand. Every number below
 * reproduced to ±0.0 over consecutive runs once frames were settled and client
 * storage was reset per capture (see harness.stableScreenshot / pristineStorage
 * — before those two fixes this tool reported bulk 36.8 on one run and 86.9 on
 * the next from the same seed and the same fixture).
 *
 *                                          bulk L\*   tiers   verdict
 *   mutation: every surface one flat grey        0.0     1     FAIL
 *   mutation: light apron, no §1 ink slab       58.0     2     FAIL
 *   build at 21:50, DARK                        93.7     2     FAIL
 *   build at 21:50, LIGHT                       58.3     1     FAIL
 *   build at 22:05, DARK                        93.4     3     pass
 *   build at 22:05, LIGHT                       62.8     3     pass
 *   ART §2 dark, simulated by stylesheet        91.4     4     pass
 *   ART §2 light, simulated by stylesheet       61.3     3     pass
 *
 * Thresholds (bulk ≥ 45, tiers ≥ 3) sit between builds that fail and builds
 * that pass in BOTH directions, which is the only calibration worth anything.
 * The `no §1 ink slab` mutation is the important one: it is a *plausible,
 * pretty* light theme — cream cards on warm concrete — that still fails,
 * because prettiness is not hierarchy.
 *
 * ─── what the two build rows above mean ──────────────────────────────────
 * This gate was RED when it was written and GREEN fifteen minutes later,
 * without a line of it changing, because the art-direction agent landed ART §1
 * ("primary action = achromatic ink slab, solid `--ink` in light, `--paper` in
 * dark") in `public/style/` while it was being calibrated. That slab is exactly
 * what supplies the third tier:
 *
 *   dark   END TURN L\* 22.2 → 87.3   tiers 2 → 3
 *   light  END TURN L\* 67.3 → 14.5   tiers 1 → 3
 *
 * Recorded here rather than quietly deleted, because the failing rows are the
 * evidence that the gate discriminates on a REAL build and not only on the
 * synthetic ones. If either theme regresses to a coloured or ghost primary
 * button, this goes red again for the same nameable reason.
 *
 * (ART §10 states this gate's subject "currently fails" with "everything within
 * ~8% luminance". That diagnosis was already one wave stale by 21:50: the dark
 * apron and the cream card stock had landed and the frame's bulk range was
 * 93.7 L\*. The checkbox can now be ticked, with these numbers behind it.)
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  FIXTURE_DIR, DESKTOP, SEED,
  parseArgs, launchBrowser, openPage, requireBridge, readJSON, reporter,
  stableScreenshot, pristineStorage, dim, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { lightnessField, lightnessStats, regionLightness } from './lib/pixels.mjs';
import { applyTheme, THEMES } from './lib/theme.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

/** §10 names one surface. Both themes of it, because §2 ships two. */
const FIXTURE = 'mid-game';

const MIN_BULK = 45;      // L*, p5→p95 of the whole frame
const MIN_TIERS = 3;      // distinct tonal tiers among the key regions
const TIER_BREAK = 12;    // L* gap that separates one tier from the next

/**
 * Region selectors, first match wins per key. `figure` regions are the things a
 * player manipulates; `ground` regions are the furniture they sit on. The
 * figure/ground split is printed as a diagnostic only (see the header).
 */
const REGIONS = {
  card: { role: 'figure', sel: ['#zone-hand [data-card-id]', '#self-board [data-card-id]', '[data-card-id]'] },
  cta: { role: 'figure', sel: ['#btn-end-turn', '#prompt button', '.btn-primary'] },
  apron: { role: 'ground', sel: ['#table-center', '#table'] },
  chrome: { role: 'ground', sel: ['#hud'] },
  mat: { role: 'ground', sel: ['#self-board .propcol', '#self-board'] },
};

/** Sorted region means → tiers, split wherever the gap exceeds TIER_BREAK. */
function tiersOf(tiers) {
  const vals = Object.entries(tiers).sort((a, b) => a[1] - b[1]);
  const groups = [];
  for (const [key, v] of vals) {
    const last = groups[groups.length - 1];
    if (last && v - last.hi <= TIER_BREAK) { last.hi = v; last.keys.push(key); }
    else groups.push({ lo: v, hi: v, keys: [key] });
  }
  return groups;
}

/** Rects for every region, in CSS px, measured in the page. */
function collectRects(regions) {
  const out = {};
  for (const [key, spec] of Object.entries(regions)) {
    for (const sel of spec.sel) {
      const els = [...document.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect();
        const st = getComputedStyle(e);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        return r.width > 6 && r.height > 6 && r.top < innerHeight && r.bottom > 0;
      });
      if (!els.length) continue;
      out[key] = els.slice(0, 8).map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      });
      break;
    }
  }
  return out;
}

async function measure(page, extraCss) {
  if (extraCss) await page.addStyleTag({ content: extraCss });
  // Not a timeout: the fan lays out and the card faces build over several
  // frames, and p95 sits exactly on the boundary of how much card stock is
  // painted (see harness.stableScreenshot's note).
  const frame = await stableScreenshot(page);
  const png = PNG.sync.read(frame.buffer);
  const field = lightnessField(png);
  const stats = lightnessStats(field);
  const scale = png.width / (await page.evaluate(() => innerWidth));
  const rects = await page.evaluate(collectRects, REGIONS);

  const tiers = {};
  for (const [key, rs] of Object.entries(rects)) {
    const vals = rs.map((r) => regionLightness(field, png, r, scale)).filter((v) => v != null);
    if (vals.length) tiers[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const mean = (keys) => {
    const vs = keys.filter((k) => tiers[k] != null).map((k) => tiers[k]);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  };
  const figure = mean(Object.keys(REGIONS).filter((k) => REGIONS[k].role === 'figure'));
  const ground = mean(Object.keys(REGIONS).filter((k) => REGIONS[k].role === 'ground'));
  return {
    bulk: stats.bulk,
    p5: stats.p5, p50: stats.p50, p95: stats.p95,
    bins: stats.bins,
    tiers,
    figure, ground,
    delta: figure != null && ground != null ? Math.abs(figure - ground) : null,
    missing: Object.keys(REGIONS).filter((k) => tiers[k] == null),
    settled: frame.settled,
    settleMs: frame.ms,
  };
}

/* The two simulations that prove the gate is satisfiable, expressed as the ART
 * §2 token values applied by brute force. They are NOT a proposed patch —
 * public/ is not ours (§1) — they are the calibration rig. */
const SIM_DARK = `
  #table, .table, #app, #table-center, .pile, #hand-dock, #hud, .opponents > *
    { background: #15171C !important; }
  .propcol { background: #20242B !important; }
  .card, .card-face, .card-inner { background: #FBF8F1 !important; }
  .card, .card * { color: #14161A !important; }
  .btn-primary, #btn-end-turn { background: #F2EEE4 !important; color: #14161A !important; }`;
const SIM_LIGHT = `
  #table, .table, #app, #table-center, .pile, #hand-dock, #hud, .opponents > *
    { background: #E8E2D4 !important; }
  .propcol { background: #D5CDBB !important; }
  .card, .card-face, .card-inner { background: #FBF8F1 !important; }
  .card, .card * { color: #14161A !important; }
  .btn-primary, #btn-end-turn { background: #14161A !important; color: #FBF8F1 !important; }`;
const SIM_FLAT = `
  *, *::before, *::after { background: #2a2d33 !important; color: #303338 !important;
    box-shadow: none !important; border-color: #2a2d33 !important; text-shadow: none !important; }`;
/* The failure mode the tier count exists to catch: a perfectly reasonable light
 * apron with cream cards on it and a primary action that is NOT the §1 ink
 * slab. Everything lands in one 12 L* band and grayscale has nothing to read. */
const SIM_NO_SLAB = `
  #table, .table, #app, #table-center, .pile, #hand-dock, #hud, .opponents > *
    { background: #E8E2D4 !important; }
  .propcol { background: #DED7C8 !important; }
  .card, .card-face, .card-inner { background: #FBF8F1 !important; }
  .btn-primary, #btn-end-turn { background: #DCD5C6 !important; color: #4A4E56 !important; }`;

const r = reporter('grayscale');
const server = await startServer({ seed });
let browser = null;
let code = EXIT_PASS;

const line = (m) => `bulk p5→p95 ${m.bulk.toFixed(1)} L*  ·  ${tiersOf(m.tiers).length} tier(s)  ·  `
  + Object.entries(m.tiers).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' ');
const verdict = (m) => (m.bulk >= MIN_BULK && tiersOf(m.tiers).length >= MIN_TIERS ? 'pass' : 'fail');

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`, { viewport: DESKTOP, dpr: 1 });
  // Same reason as screenshot.mjs: the coach layer is shown "once ever" out of
  // localStorage, so without this the first surface measured carries a hint
  // bubble and no other one does.
  await pristineStorage(h.context);
  await requireBridge(h.page, 8000);

  const states = (() => {
    const f = readJSON(path.join(FIXTURE_DIR, `${FIXTURE}.json`));
    return Array.isArray(f) ? f : f.states;
  })();
  if (!states?.length) {
    r.fail(`fixture ${FIXTURE}.json missing; run npm run tool:record`);
    throw new Error('no fixture');
  }

  const load = async (theme, css) => {
    const u = new URL('/?harness=1', server.url);
    u.searchParams.set('seed', seed);
    await h.page.goto(u.href, { waitUntil: 'load', timeout: 20000 });
    await requireBridge(h.page, 8000);
    await applyTheme(h.page, theme);
    await h.page.evaluate((s) => {
      window.__CHUD.applyState(s);
      window.__CHUD.drainEvents?.();
    }, states[states.length - 1]);
    await h.page.waitForTimeout(200);
    return measure(h.page, css);
  };

  /* ── the gate itself: §10's surface, in every theme §2 ships ──────────── */
  for (const theme of THEMES) {
    const m = await load(theme);
    const label = `${FIXTURE}@desktop ${theme.key}`;
    if (m.missing.length) r.warn(`${label}: no region matched ${m.missing.join(', ')}`);
    if (!m.settled) r.warn(`${label}: the frame never stopped changing in ${m.settleMs}ms — numbers below are of a moving target`);

    if (m.bulk >= MIN_BULK) r.pass(`${label} tonal range: ${m.bulk.toFixed(1)} L* ≥ ${MIN_BULK}`);
    else {
      r.fail(`${label} tonal range: ${m.bulk.toFixed(1)} L* < ${MIN_BULK} `
        + `— 90% of the frame lives between L* ${m.p5.toFixed(1)} and ${m.p95.toFixed(1)}; `
        + 'in grayscale it is one tone (ART §3, §10)');
    }

    const groups = tiersOf(m.tiers);
    const shape = groups.map((g) => `${g.keys.join('+')} ${g.lo.toFixed(0)}${g.hi > g.lo ? `–${g.hi.toFixed(0)}` : ''}`).join('  |  ');
    if (groups.length >= MIN_TIERS) r.pass(`${label} tonal tiers: ${groups.length} ≥ ${MIN_TIERS}   ${dim(shape)}`);
    else {
      r.fail(`${label} tonal tiers: ${groups.length} < ${MIN_TIERS} `
        + `— in grayscale this frame has no foreground/middle/ground separation (ART §10)`);
      r.info(`tiers found: ${shape}`);
    }
    r.info(Object.entries(m.tiers).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ')
      + `  ${dim(`[diagnostic: figure ${m.figure?.toFixed(1) ?? '—'} vs ground ${m.ground?.toFixed(1) ?? '—'}, `
        + `Δ ${m.delta?.toFixed(1) ?? '—'}]`)}`
      + dim(`  deciles ${m.bins.map((b) => Math.round(b * 100)).join('/')}`));
  }

  /* ── proof the gate discriminates (§8) ────────────────────────────────── */
  if (args.prove) {
    console.log(dim('\n  ── --prove: the same two numbers on four synthetic builds ──'));
    for (const [name, theme, css, want] of [
      ['mutation: one flat grey', THEMES[0], SIM_FLAT, 'fail'],
      ['mutation: light apron, no ink slab', THEMES[1], SIM_NO_SLAB, 'fail'],
      ['ART §2 dark, simulated', THEMES[0], SIM_DARK, 'pass'],
      ['ART §2 light, simulated', THEMES[1], SIM_LIGHT, 'pass'],
    ]) {
      const m = await load(theme, css);
      const got = verdict(m);
      if (got === want) r.pass(`${name}: ${got} as expected  ${dim(line(m))}`);
      else r.fail(`${name}: expected ${want}, measured ${got}  ${line(m)}`);
    }
  } else {
    console.log(dim('  (run with --prove to re-measure the calibration rig: '
      + 'a flat-grey mutation must go red, the two simulated ART §2 themes green)'));
  }

  if (h.errors.length) r.warn(`${h.errors.length} console/page error(s) while measuring`);
  await h.close();
} catch (e) {
  if (!String(e.message).includes('no fixture')) {
    r.fail(`${e.message.split('\n')[0]}`);
  }
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

r.finish('grayscale');
process.exit(r.code === EXIT_PASS && code === EXIT_PASS ? EXIT_PASS : EXIT_FAIL);
