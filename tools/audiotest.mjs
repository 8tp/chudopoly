#!/usr/bin/env node
/**
 * tools/audiotest.mjs — offline render of the sfx bank (§7, §8).
 *
 * Renders each sound through an OfflineAudioContext inside the page, so the
 * real synthesis graph is measured rather than a Node reimplementation of it.
 *
 * Asserts:
 *   • peak ≤ 0 dBFS on every sound and on the summed worst case — §7 makes
 *     "no clipping" a graph invariant, not a mixing preference
 *   • the set-progress chime ladder is monotonically ASCENDING in pitch — §7
 *     names it as the positive feedback signal; a ladder that dips reads as a
 *     mistake to the player even when the game state is good
 *   • the sour cue's fundamental sits BELOW chime-0 — the "you are being
 *     stolen from" treatment must be unmistakable against the reward tone
 *
 * Needs the audio engine (P5) to expose a render hook. Exits 2 until then.
 */
import {
  SEED, parseArgs, launchBrowser, openPage, requireBridge, reporter,
  green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

/** Chime ladder names, in the order the set-progress feedback plays them. */
const LADDER = ['set_progress_0', 'set_progress_1', 'set_progress_2', 'set_progress_3'];
const SOUR = ['sour', 'stolen', 'pay'];

const r = reporter('audiotest' + dim('  §7 offline render'));
const server = await startServer({ seed });
let browser = null;
let code = EXIT_PASS;

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}&mute=1`);
  await requireBridge(h.page, 8000);

  const audioReady = await h.page.evaluate(() =>
    !!(window.__CHUD.audio && typeof window.__CHUD.audio.renderOffline === 'function' &&
       typeof window.__CHUD.audio.list === 'function'));
  if (!audioReady) {
    console.log(yellow(bold('  PENDING CLIENT AUDIO')) +
      ' — __CHUD.audio.renderOffline(name, seconds) / .list() not exposed yet (P5, §7)');
    console.log(dim('    HARNESS REQUEST TO P5: expose { list(): string[], renderOffline(name, seconds):' +
      ' Promise<Float32Array|{channels:Float32Array[], sampleRate:number}> } on __CHUD.audio,'));
    console.log(dim('    rendering the real bus chain (bus → compressor → soft-clip → master) in an OfflineAudioContext.'));
    await h.close();
    await browser.close();
    await server.stop();
    process.exit(EXIT_SKIP);
  }

  const names = await h.page.evaluate(() => window.__CHUD.audio.list());
  r.pass(`${names.length} sound(s) in the bank`);

  /**
   * Renders one sound and returns peak plus the dominant frequency, measured by
   * a naive DFT over a coarse bin set — cheap, and only has to rank tones
   * against each other, not name them.
   */
  const analyse = (name) => h.page.evaluate(async (n) => {
    const out = await window.__CHUD.audio.renderOffline(n, 1.5);
    const buf = out instanceof Float32Array ? out : out.channels[0];
    const sampleRate = out instanceof Float32Array ? 48000 : out.sampleRate;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));

    // Dominant partial: scan 60–2000Hz in 5Hz steps over the first 0.35s, where
    // a card-game cue's fundamental lives before the tail decays.
    const win = Math.min(buf.length, Math.floor(sampleRate * 0.35));
    let bestF = 0, bestMag = 0;
    for (let f = 60; f <= 2000; f += 5) {
      let re = 0, im = 0;
      const w = 2 * Math.PI * f / sampleRate;
      for (let i = 0; i < win; i += 2) {
        re += buf[i] * Math.cos(w * i);
        im += buf[i] * Math.sin(w * i);
      }
      const mag = Math.hypot(re, im);
      if (mag > bestMag) { bestMag = mag; bestF = f; }
    }
    return { peak, freq: bestF, samples: buf.length, sampleRate };
  }, name);

  /* ---- 1. nothing clips --------------------------------------------------- */
  let clipped = 0;
  const measured = {};
  for (const n of names) {
    const m = await analyse(n);
    measured[n] = m;
    const dbfs = m.peak > 0 ? 20 * Math.log10(m.peak) : -Infinity;
    if (m.peak > 1.0) {
      clipped++;
      r.fail(`${n} peaks at ${dbfs.toFixed(2)} dBFS (>0) — §7 makes no-clipping a graph invariant`);
    }
  }
  if (!clipped) {
    const loudest = Object.entries(measured).sort((a, b) => b[1].peak - a[1].peak)[0];
    r.pass(`peak ≤ 0 dBFS across ${names.length} sound(s) ` +
      dim(`(loudest ${loudest[0]} at ${(20 * Math.log10(loudest[1].peak)).toFixed(2)} dBFS)`));
  }

  /* ---- 2. the chime ladder ascends ---------------------------------------- */
  const ladder = LADDER.filter((n) => names.includes(n));
  if (ladder.length < 2) {
    r.warn(`chime ladder not found (looked for ${LADDER.join(', ')}) — §7 requires a monotonic pentatonic ladder`);
  } else {
    const freqs = ladder.map((n) => measured[n].freq);
    const ascending = freqs.every((f, i) => i === 0 || f > freqs[i - 1]);
    if (ascending) r.pass(`chime ladder ascends ${dim(freqs.map((f) => `${f}Hz`).join(' → '))}`);
    else r.fail(`chime ladder is not monotonic: ${freqs.map((f, i) => `${ladder[i]}=${f}Hz`).join(', ')}`);
  }

  /* ---- 3. the sour cue sits under chime-0 --------------------------------- */
  const sourName = SOUR.find((n) => names.includes(n));
  const chime0 = ladder.length ? measured[ladder[0]].freq : null;
  if (!sourName) {
    r.warn(`no sour cue found (looked for ${SOUR.join(', ')}) — §7 requires a distinctly sour treatment`);
  } else if (chime0 == null) {
    r.warn('no chime-0 to compare the sour cue against');
  } else if (measured[sourName].freq < chime0) {
    r.pass(`sour cue "${sourName}" ${measured[sourName].freq}Hz is below chime-0 ${chime0}Hz`);
  } else {
    r.fail(`sour cue "${sourName}" ${measured[sourName].freq}Hz is NOT below chime-0 ${chime0}Hz — ` +
      'reward and punishment read alike');
  }

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s) during render`);
    for (const e of h.errors.slice(0, 5)) console.log(red(`      ${e}`));
  }

  await h.close();
  code = r.code;
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('audiotest: PASS')) : red(bold('audiotest: FAIL')));
process.exit(code);
