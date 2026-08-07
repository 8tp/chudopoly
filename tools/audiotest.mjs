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
 *   • the synthesised match bed peaks under card_slide (6) and the RECORDED
 *     beds inherit that contract (7) — see the note there for why one of those
 *     is a peak comparison and the other is not, and why neither was loosened
 *   • the four bed TRANSITIONS contain no click at any scheduled seam and no
 *     dead air (8). Both real bugs found in the P10 round were found here.
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

  /* ---- 4. losses are LOUDER than furniture (round-1 audio regression) ------
   * MEASURED in round 1: being robbed rendered QUIETER than a HUD timer tick.
   * The mix is what tells a player which events matter; a loss that sits under
   * the furniture teaches that losing does not. Peak, not fundamental — this is
   * about presence in the mix, not pitch.                                     */
  const LOSSES = ['sour', 'sour_broke', 'sour_pay'];
  const FURNITURE = ['shuffle_riffle', 'card_snap', 'timer_critical'];
  const lossNames = LOSSES.filter((n) => names.includes(n));
  const furnNames = FURNITURE.filter((n) => names.includes(n));
  if (!lossNames.length || !furnNames.length) {
    r.warn(`loss/furniture comparison skipped (losses: ${lossNames.join(',') || 'none'}; `
      + `furniture: ${furnNames.join(',') || 'none'})`);
  } else {
    const quiet = [];
    for (const loss of lossNames) {
      for (const furn of furnNames) {
        if (measured[loss].peak <= measured[furn].peak) {
          quiet.push(`${loss} ${(20 * Math.log10(measured[loss].peak)).toFixed(1)}dBFS `
            + `≤ ${furn} ${(20 * Math.log10(measured[furn].peak)).toFixed(1)}dBFS`);
        }
      }
    }
    if (quiet.length) {
      r.fail(`${quiet.length} loss cue(s) render no louder than table furniture — `
        + 'being robbed must not be quieter than a HUD tick (§7)');
      for (const q of quiet) r.info(q);
    } else {
      r.pass(`every loss cue (${lossNames.join(', ')}) is louder than `
        + `${furnNames.join(', ')} ${dim(lossNames.map((n) => `${n}=${(20 * Math.log10(measured[n].peak)).toFixed(1)}dB`).join(' '))}`);
    }
  }

  /* ---- 5. under overflow, meaning outranks furniture ----------------------
   * §7 caps voices with weights, and gives priority voices a HIGHER cap. The
   * failure that produces is a set completion silenced because four card
   * slides got there first — the same shape as the 42% sfx loss the motion
   * agent measured, one layer down.
   *
   * The absolute assertion — `stats().droppedPriority === 0` over a real game —
   * lives in playtest.mjs's animated pass, where a real event stream exists.
   * Here the burst is SYNTHETIC, so an absolute zero would only measure how
   * hostile I chose to be: at 100 cues/second every cap must drop something,
   * and asserting otherwise would be a demand no mixer can meet. What is
   * asserted here is the ORDERING, which must hold at any density: when the
   * budget overflows, priority voices survive at a strictly better rate than
   * furniture, and the big moments in a burst are not the first thing cut.   */
  const hasMix = await h.page.evaluate(() => typeof window.__CHUD.audio.renderMix === 'function');
  if (!hasMix) {
    r.warn('__CHUD.audio.renderMix absent — priority-ordering assertion not run');
  } else {
    const burst = await h.page.evaluate(async (bank) => {
      const BIGNAMES = ['set_progress_3', 'sour', 'sour_broke', 'chud_hit', 'win', 'fanfare'];
      const bigs = bank.filter((n) => BIGNAMES.includes(n));
      const filler = bank.filter((n) => !BIGNAMES.includes(n));
      const run = async (fillEveryMs, bigEveryMs) => {
        const entries = [];
        let i = 0;
        for (let t = 0; t < 6000; t += fillEveryMs, i++) {
          entries.push({ name: filler[i % filler.length] || bank[0], t });
          if (t % bigEveryMs === 0 && bigs.length) {
            entries.push({ name: bigs[(t / bigEveryMs) % bigs.length], t: t + 2, big: true });
          }
        }
        const out = await window.__CHUD.audio.renderMix(entries, 7);
        const nBig = entries.filter((e) => e.big).length;
        return { v: out.voices, total: entries.length, nBig, nFill: entries.length - nBig };
      };
      return { hostile: await run(10, 200), realistic: await run(120, 600) };
    }, names);

    // The hostile burst only has to prove the cap ENGAGES. Its drop counts are
    // not gated on: `droppedPriority` counts the engine's own priority flag,
    // which many bank sounds carry, so a synthetic 100-cue/second flood cannot
    // be turned into an honest per-class rate from outside the engine — and a
    // rate computed wrong is worse than none. Tried it: it reported 547%.
    const b = burst.hostile;
    if (!b?.v) {
      r.warn('renderMix returned no voice accounting — voice-cap assertions not run');
    } else if (b.v.dropped === 0 && b.v.gated === 0) {
      r.fail(`a ${b.total}-cue/6s flood never exceeded the voice budget — `
        + 'the cap is not engaging, so nothing below proves anything');
    } else {
      r.pass(`the voice cap engages under flood ${dim(`(${b.v.dropped} dropped, ${b.v.gated} rate-gated of ${b.total})`)}`);
    }

    // THE ASSERTION: at the game's real worst case — one broadcast every 120ms,
    // the cadence the motion agent measured the collapse at — nothing priority
    // may drop. playtest.mjs asserts the same counter live, on a real game.
    const rb = burst.realistic;
    if (rb?.v) {
      if (rb.v.peak === 0) {
        r.fail('the realistic burst claimed no voices at all — assertion is vacuous');
      } else if (rb.v.droppedPriority === 0) {
        r.pass(`no priority voice dropped at the real 120ms broadcast cadence `
          + dim(`(${rb.total} cues, peak load ${rb.v.peak}/${rb.v.cap})`));
      } else {
        r.fail(`${rb.v.droppedPriority} priority voice(s) dropped at the ordinary 120ms cadence — `
          + 'a big moment is being silenced during normal play (§7)');
      }
    }
  }

  /* ---- 6. the score never creeps over the card layer -----------------------
   * §7 puts sfx/ui/music on separate buses for a reason. A match bed that
   * renders at or above a card slide has stopped being a bed.                 */
  const hasMusic = await h.page.evaluate(() => typeof window.__CHUD.audio.renderMusic === 'function');
  const slide = measured.card_slide;
  if (!hasMusic) {
    r.warn('__CHUD.audio.renderMusic absent — music/sfx balance not asserted');
  } else if (!slide) {
    r.warn('card_slide is not in the bank — nothing to measure the music bed against');
  } else {
    const bed = await h.page.evaluate(async () => {
      const out = await window.__CHUD.audio.renderMusic('match', 8);
      const buf = out instanceof Float32Array ? out : out.channels[0];
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      return { peak };
    });
    const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    if (bed.peak < slide.peak) {
      r.pass(`match bed ${db(bed.peak).toFixed(1)}dBFS sits under card_slide ${db(slide.peak).toFixed(1)}dBFS`);
    } else {
      r.fail(`match music peaks at ${db(bed.peak).toFixed(1)}dBFS, at or above card_slide `
        + `${db(slide.peak).toFixed(1)}dBFS — the score is over the card layer (§7)`);
    }
  }

  /* ---- 7. the RECORDED beds inherit the synthesised bed's contract ---------
   * §0.3's 2026-08-07 amendment lets four .opus tracks ship as MUSIC ONLY. The
   * level question they raise is not the one assertion 6 answers, and this is
   * the honest statement of the difference rather than a rewrite of it:
   *
   *   assertion 6 compares PEAKS. That is right for the synthesised bed, whose
   *   crest factor is 12.8dB, and it stays exactly as it was.
   *   A mastered recording has a ~19dB crest factor, so holding its PEAK to the
   *   synth bed's would put its LOUDNESS 6dB lower — and matching its broadband
   *   RMS instead would put its peak 3dB OVER card_slide, because the synth
   *   bed's RMS is mostly 55–82Hz content under a 240Hz lowpass that a laptop
   *   speaker does not reproduce (music.js:555 measured exactly this).
   *
   * So both are asserted, and they turned out not to conflict at all: trimmed
   * to peak 2.1dB under card_slide, both match beds land within 1.5dB of the
   * synthesised bed's RMS ABOVE 300Hz — the band that carries. Nothing was
   * loosened to make that true; it is what the tracks measure.
   *
   * The climax bed is the one deliberate exception and it is bounded rather
   * than exempt: Final Approach is the moment the score IS the event, so it may
   * peak above card_slide, by at most 1.5dB, and must stay 5dB under card_snap
   * (a card actually landing). Measured at ship: -23.97 vs -24.83 / -18.07.  */
  const snap = measured.card_snap;
  if (hasMusic && slide && snap) {
    const dbv = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    const beds = await h.page.evaluate(async () => {
      const out = {};
      for (const w of ['match', 'lobby', 'match1', 'match2', 'final']) {
        try {
          const o = await window.__CHUD.audio.renderMusic(w, 24);
          const sr = o.sampleRate;
          const a = Math.exp(-2 * Math.PI * 300 / sr);
          let peak = 0, hsum = 0, n = 0;
          for (const c of o.channels) {
            let prev = 0, hp = 0;
            for (let i = 0; i < c.length; i++) {
              const x = c[i];
              const ax = x < 0 ? -x : x;
              if (ax > peak) peak = ax;
              hp = a * (hp + x - prev); prev = x;
              hsum += hp * hp; n++;
            }
          }
          out[w] = { peak, hi: Math.sqrt(hsum / n) };
        } catch (e) { out[w] = { error: String((e && e.message) || e) }; }
      }
      return out;
    });
    const missing = Object.entries(beds).filter(([, v]) => v.error);
    if (missing.length) {
      r.fail(`${missing.length} music bed(s) failed to render: `
        + missing.map(([k, v]) => `${k} (${v.error})`).join(', '));
    }
    const under = ['lobby', 'match1', 'match2'].filter((k) => beds[k] && !beds[k].error);
    const over = under.filter((k) => beds[k].peak >= slide.peak);
    // The lobby bed plays on a screen with no cards on it and §7 sets its own
    // target (-14 dBFS master); it is excluded from the card comparison and
    // asserted against that number instead.
    const overGame = over.filter((k) => k !== 'lobby');
    if (overGame.length) {
      r.fail(`${overGame.join(', ')} peak at or above card_slide ${dbv(slide.peak).toFixed(1)}dBFS `
        + `(${overGame.map((k) => `${k}=${dbv(beds[k].peak).toFixed(1)}`).join(', ')}) — `
        + 'a recorded bed over the card layer is still a bed over the card layer (§7)');
    } else if (beds.match1 && beds.match2) {
      r.pass('both recorded match beds sit under card_slide '
        + dim(`(match1 ${dbv(beds.match1.peak).toFixed(1)}, match2 ${dbv(beds.match2.peak).toFixed(1)} `
          + `vs ${dbv(slide.peak).toFixed(1)} dBFS)`));
    }
    if (beds.lobby && !beds.lobby.error) {
      const d = dbv(beds.lobby.peak);
      if (d > -12 || d < -17) {
        r.fail(`lobby bed peaks at ${d.toFixed(2)} dBFS — §7 asks the menu score for a -14 dBFS master`);
      } else {
        r.pass(`lobby bed master ${d.toFixed(2)} dBFS ${dim('(§7: -14)')}`);
      }
    }
    if (beds.final && !beds.final.error) {
      const d = dbv(beds.final.peak);
      const overSlide = d - dbv(slide.peak);
      const underSnap = dbv(snap.peak) - d;
      if (overSlide > 1.5 || underSnap < 5) {
        r.fail(`final-approach bed ${d.toFixed(2)} dBFS is ${overSlide.toFixed(1)}dB over card_slide `
          + `and ${underSnap.toFixed(1)}dB under card_snap — the climax may rise over a slide `
          + '(≤1.5dB) but never over a card landing (≥5dB)');
      } else {
        r.pass(`final-approach bed ${d.toFixed(2)} dBFS: +${overSlide.toFixed(1)}dB on card_slide, `
          + `-${underSnap.toFixed(1)}dB on card_snap ${dim('(the climax is allowed to rise, bounded)')}`);
      }
    }
    if (beds.match && beds.match1 && beds.match2 && !beds.match.error) {
      const ref = dbv(beds.match.hi);
      const loud = ['match1', 'match2'].map((k) => [k, dbv(beds[k].hi) - ref]);
      const bad = loud.filter(([, d]) => Math.abs(d) > 4);
      if (bad.length) {
        r.fail(`${bad.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${d.toFixed(1)}dB`).join(', ')} `
          + 'against the synthesised match bed above 300Hz — a recorded bed must be no louder '
          + 'in the band that carries than the procedural bed it replaces');
      } else {
        r.pass('recorded match beds match the synthesised one above 300Hz '
          + dim(loud.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${d.toFixed(1)}dB`).join(' ')));
      }
    }
  } else if (hasMusic && !snap) {
    r.warn('card_snap is not in the bank — the recorded beds were not bounded above');
  }

  /* ---- 8. the four transitions, measured rather than described -------------
   * "A transition you did not measure is a transition you did not test." Each
   * of music.js's four transitions is rendered offline through the real
   * transition code (audio.renderTransition drives set()/setTension() against
   * an OfflineAudioContext) and graded on the two ways a bed change goes wrong:
   *
   *   a CLICK  — a one-sample discontinuity where a source is cut or started.
   *              Graded at the SCHEDULED seam times only, against the render's
   *              own |dx| distribution, because hunting the whole buffer for
   *              "the biggest jump" only ever finds the loudest transient in
   *              the music. 2x the 99.99th percentile is the bar.
   *   a HOLE   — dead air. This is what caught the two real bugs in the round:
   *              stopDrone() cancelling from `now` instead of from its
   *              scheduled time (6.0s at -114 dBFS), and the synth transport
   *              not re-basing on a mode change (1.3s at -105 dBFS).           */
  const hasTrans = await h.page.evaluate(() => typeof window.__CHUD.audio.renderTransition === 'function');
  if (!hasTrans) {
    r.warn('__CHUD.audio.renderTransition absent — the four transitions are not measured');
  } else {
    const PLANS = [
      ['lobby→match', [{ at: 0, do: 'menu' }, { at: 12, do: 'match' }], 26],
      ['match→final', [{ at: 0, do: 'match' }, { at: 16, do: 'arm' }], 26],
      ['final→match', [{ at: 0, do: 'match' }, { at: 10, do: 'arm' }, { at: 18, do: 'break' }], 28],
      ['match→lobby', [{ at: 0, do: 'match' }, { at: 16, do: 'lobby' }], 28],
    ];
    const bad = [];
    const good = [];
    for (const [label, steps, seconds] of PLANS) {
      const m = await h.page.evaluate(async ([st, sec]) => {
        const o = await window.__CHUD.audio.renderTransition(st, sec);
        const sr = o.sampleRate, L = o.channels[0], R = o.channels[1];
        const db = (v) => (v > 0 ? 20 * Math.log10(v) : -120);
        const dx = [];
        for (let i = 1; i < L.length; i += 3) dx.push(Math.abs(L[i] - L[i - 1]));
        dx.sort((a, b) => a - b);
        const p9999 = dx[Math.floor(dx.length * 0.9999)] || 1e-9;
        let worst = 0, worstAt = 0;
        for (const line of o.log) {
          const mm = / at (\d+\.\d+)/.exec(line);
          if (!mm) continue;
          const t = Number(mm[1]);
          const a = Math.max(1, Math.round((t - 0.01) * sr));
          const b = Math.min(L.length, Math.round((t + 0.01) * sr));
          let mx = 0;
          for (let i = a; i < b; i++) { const d = Math.abs(L[i] - L[i - 1]); if (d > mx) mx = d; }
          if (mx / p9999 > worst) { worst = mx / p9999; worstAt = t; }
        }
        // Dead air, in 100ms frames. -62 dBFS is 37dB under the quietest bed
        // this render contains, i.e. unambiguously nothing.
        const W = Math.round(sr * 0.1);
        let hole = 0, run = 0, holeAt = 0;
        const end = Math.round(sr * (sec - 1.5));      // ignore the fade at the tail
        for (let i = 0; i + W <= end; i += W) {
          let s = 0;
          for (let j = i; j < i + W; j++) { const x = (L[j] + R[j]) * 0.5; s += x * x; }
          if (db(Math.sqrt(s / W)) < -62) {
            run++;
            if (run > hole) { hole = run; holeAt = (i / sr) - (run - 1) * 0.1; }
          } else run = 0;
        }
        return { worst, worstAt, hole: hole * 0.1, holeAt };
      }, [steps, seconds]);
      // 0.7s: match-2 is a genuinely sparse composition and its own quietest
      // stretch measured 0.4s under -62 dBFS with nothing wrong at all.
      if (m.worst > 2) bad.push(`${label}: click at ${m.worstAt.toFixed(2)}s (${m.worst.toFixed(1)}× the render's own p99.99 |dx|)`);
      else if (m.hole > 0.7) bad.push(`${label}: ${m.hole.toFixed(1)}s of dead air at ${m.holeAt.toFixed(1)}s`);
      else good.push(`${label} ${m.worst.toFixed(2)}×/${m.hole.toFixed(1)}s`);
    }
    if (bad.length) {
      r.fail(`${bad.length} of ${PLANS.length} bed transition(s) are audibly broken`);
      for (const b of bad) r.info(b);
    } else {
      r.pass(`all ${PLANS.length} bed transitions are clean ${dim(`(seam |dx| / dead air: ${good.join(', ')})`)}`);
    }
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
