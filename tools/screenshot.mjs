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
 * P8 additions:
 *   • Six more surfaces shipped with no shot: the discard browser and its deck
 *     census, the full Mission Log, the win recap, the discard-to-limit READY
 *     state, and — the one the whole of ART §5 is about — a card HELD mid-drag
 *     with legal mats ringed, illegal mats desaturated, the landing ghost in the
 *     hovered column and the hand retracted. That last one needs input held open
 *     across the capture, so drivers moved to lib/drivers.mjs and grew a
 *     host-side kind (real `page.mouse`, never released before the shutter).
 *   • The PEEK (ART §8), which is now the primary "read a card" path and had no
 *     shot at all — the only `peek-*.png` on disk were hand-captured against the
 *     retired navy theme, so anyone reviewing them was judging a build that no
 *     longer exists. It is held open across the shutter like the drag, and the
 *     gesture differs per viewport: hover on desktop, a real CDP touch hold on
 *     the phone (driving the phone take with a mouse returns `peek:absent`,
 *     which is the correct answer to the wrong gesture). Nothing screenshotting
 *     the peek is how a transparent peek-tier rent card shipped.
 *   • The REFUSAL (§P7.3) — the persistent `.is-refusing` state, not the 420ms
 *     shake.
 *   • A THEME axis. ART §2 ships light + dark; the review set captured one
 *     appearance, so half the design was unreviewable. Rather than double all
 *     48 shots, a representative subset (home, mid-game, final-approach, win,
 *     help, discard-browser, peek-hover) is captured in both. A theme pair that
 *     comes out BYTE-IDENTICAL is reported by name — "the theme system does not
 *     reach this surface" is precisely the two-names-one-picture failure this
 *     file exists to catch, and it is worth more said out loud than as a generic
 *     hash clash. `--prove-theme` demonstrates that verdict going red.
 *   • Every shot now waits for a SETTLED frame and resets client storage first.
 *     Without either, two takes of `mid-game@desktop` from the same state and
 *     the same theme differed by 21593 pixels (the coach layer is shown "once
 *     ever" out of localStorage, which survives `page.goto`) — so both
 *     byte-identical rules were comparing frames that differed for reasons that
 *     had nothing to do with what they measure.
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
  parseArgs, ensureDir, launchBrowser, openPage, requireBridge, readJSON, stableScreenshot, pristineStorage,
  green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import * as audit from './lib/audit.mjs';
import { drive, releaseInput } from './lib/drivers.mjs';
import { applyTheme, sameAppearance, THEMES } from './lib/theme.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

/**
 * §8 shot list. `fixture` names a file in tools/fixtures/; `at` picks a state
 * INDEX inside a transcript; `screen` restricts a shot to one viewport;
 * `drive` names a lib/drivers.mjs entry run after the state is applied;
 * `expect` is a prefix the driver's return value must start with or the shot
 * FAILS; `themes: true` adds the light pass (desktop only — see THEME_SCREEN).
 */
const SHOTS = [
  { name: 'home', route: '/?harness=1', fixture: null, themes: true },
  { name: 'help', fixture: null, drive: 'help', expect: 'sheet:open', themes: true },
  { name: 'lobby', fixture: 'lobby' },
  { name: 'early-game', fixture: 'early-game' },
  { name: 'mid-game', fixture: 'mid-game', themes: true },
  { name: 'big-hand', fixture: 'big-hand' },
  // The four client-side moments the round-1 set could not show at all.
  { name: 'targeting', fixture: 'targeting', drive: 'targeting', expect: 'target:' },
  { name: 'payment', fixture: 'payment-pending', drive: 'payment', expect: 'mode:payment' },
  { name: 'discard', fixture: 'discard-limit', drive: 'discard-limit', expect: 'mode:discard' },
  { name: 'opsec-decision', fixture: 'opsec-decision' },
  { name: 'opsec-chain', fixture: 'opsec-chain' },
  // Chrome surfaces that had no shot at all.
  { name: 'settings', fixture: 'mid-game', drive: 'settings', expect: 'sheet:open' },
  { name: 'side-log', fixture: 'mid-game', drive: 'side', expect: 'side:open' },
  { name: 'emote', fixture: 'mid-game', drive: 'emote', expect: 'sheet:open' },
  { name: 'five-player', fixture: 'five-player' },
  { name: 'final-approach', fixture: 'final-approach', themes: true },
  { name: 'win', fixture: 'finished', themes: true },
  /* ── P8 surfaces (see the header) ──────────────────────────────────────── */
  { name: 'discard-browser', fixture: 'mid-game', drive: 'discard', expect: 'sheet:open', themes: true },
  { name: 'discard-census', fixture: 'mid-game', drive: 'discard-census', expect: 'sheet:open census', screen: 'desktop' },
  { name: 'mission-log', fixture: 'mid-game', drive: 'log', expect: 'sheet:open' },
  { name: 'discard-ready', fixture: 'discard-limit', drive: 'discard-ready', expect: 'ready:' },
  // Desktop only, and the phone's absence is a MEASUREMENT, not an oversight:
  // `win-recap@phone` came out byte-identical to `win@phone` because at
  // 390×844 the recap is already fully on screen and there is nothing to
  // scroll to. A second name for the same picture is the one thing this file
  // exists to forbid, so the phone take was removed rather than kept as filler.
  { name: 'win-recap', fixture: 'finished', drive: 'win-recap', expect: 'recap:', screen: 'desktop' },
  // The moment ART §5 is entirely about, held open across the shutter.
  { name: 'drag-mid', fixture: 'mid-game', drive: 'drag-mid', expect: 'drag:held' },
  // ART §8's peek, likewise held: hover-open at 140ms, close-delay 160ms, so
  // there is no state to screenshot once the pointer has left.
  // On a phone it is a 300ms touch hold, not a hover — content.css gates the
  // hover path behind `@media (hover:hover)`, and driving the phone take with
  // a mouse returned `peek:absent`, the right answer to the wrong gesture.
  { name: 'peek-hover', fixture: 'mid-game', drive: 'peek', expect: 'peek:open', screen: 'desktop', themes: true },
  { name: 'peek-hold', fixture: 'mid-game', drive: 'peek-hold', expect: 'peek:open', screen: 'phone' },
  { name: 'peek-opponent', fixture: 'mid-game', drive: 'peek-board', expect: 'peek:open', screen: 'desktop' },
  // §P7.3: a refusal that explains itself instead of greying out — the
  // PERSISTENT half (`.is-refusing` + the sentence in `title`), never the
  // 420ms shake, which would be a shot of whenever the shutter happened to fall.
  // The fixture is chosen by MEASUREMENT: a refusal shot needs a reason to
  // refuse, and on `mid-game` it is your turn with plays in hand so nothing
  // does. Every fixture was swept with this driver; `targeting` gives the most
  // interesting refusal in the set — a RULES one ("Needs a complete set without
  // an Upgrade") rather than "it is not your turn", which the arc fixtures give.
  { name: 'refusal', fixture: 'targeting', drive: 'refusal', expect: 'refusing:' },
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

/** The light pass runs at desktop only: it doubles a subset, not the set. */
const THEME_SCREEN = 'desktop';

/**
 * `--prove-theme` (§8: "a gate must be proven to fail").
 *
 * It re-takes ONLY the themed subset at desktop, with the light pass forced to
 * render under `prefers-color-scheme: dark` — i.e. a build whose theme system
 * does nothing. Every pair must then come out byte-identical and the theme
 * verdict must go red. If it stays green, the verdict is a decoration and the
 * run says so.
 */
const PROVE_THEME = !!args['prove-theme'];
const THEME_LIST = PROVE_THEME
  ? [THEMES[0], { ...THEMES[1], scheme: THEMES[0].scheme, attr: THEMES[0].attr }]
  : THEMES;

/** Shots that only exist on one screen still have to be asked for by name. */
const screenTakes = (shot, tag) => (shot.screen ? shot.screen === tag : tag !== 'landscape');

/** Every (shot, screen) pair expands into one take per theme it asks for. */
function takesFor(shot, tag) {
  if (!shot.themes || tag !== THEME_SCREEN) return [THEME_LIST[0]];
  return THEME_LIST;
}

const SHOT_LIST = PROVE_THEME ? SHOTS.filter((s) => s.themes) : SHOTS;
const SCREEN_LIST = PROVE_THEME ? SCREENS.filter((s) => s.tag === THEME_SCREEN) : SCREENS;

const planned = SCREEN_LIST.reduce((n, s) => n + SHOT_LIST
  .filter((sh) => screenTakes(sh, s.tag))
  .reduce((m, sh) => m + takesFor(sh, s.tag).length, 0), 0);
console.log(bold('screenshot')
  + dim(`  ${SHOT_LIST.length} shots × ${SCREEN_LIST.length} screens × ${THEME_LIST.length} themes = ${planned} takes → tools/shots/`)
  + (PROVE_THEME ? yellow('  --prove-theme: the light pass is deliberately rendered dark') : ''));

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
const themePairs = new Map();      // `${shot}@${screen}` → {dark:{hash,fp}, light:{…}}
const unsettled = [];              // shots whose frame never stopped changing

const fail = (m) => { code = EXIT_FAIL; problems.push(m); console.log(`  ${red('✗')} ${m}`); };

/** One capture: reload, theme, fixture, drive, measure, shoot, hash. */
async function take(h, screen, shot, theme) {
  const label = `${shot.name}@${screen.tag}${theme.tag}`;
  try {
    // Every take gets a full page reload on a unique URL. Without it, state
    // bleeds between shots — a sheet left open by one shot stayed open over
    // every later capture.
    const u = new URL(shot.route || '/?harness=1', server.url);
    u.searchParams.set('seed', seed);
    u.searchParams.set('shot', shot.name);
    await h.page.goto(u.href, { waitUntil: 'load', timeout: 20000 });
    await requireBridge(h.page, 8000);
    // After navigation: `data-theme` lives on a document this goto replaced.
    const fp = await applyTheme(h.page, theme);

    if (shot.fixture) {
      const states = loadStates(shot.fixture);
      if (!states?.length) {
        fail(`${label} — fixture ${shot.fixture}.json missing; run npm run tool:record`);
        return;
      }
      const idx = shot.at == null ? states.length - 1 : (shot.at < 0 ? states.length + shot.at : shot.at);
      const state = states[Math.max(0, Math.min(states.length - 1, idx))];
      await h.page.evaluate((s) => {
        window.__CHUD.applyState(s);
        window.__CHUD.drainEvents?.();
      }, state);
      await h.page.waitForTimeout(120);
    }

    /* ---- drive into the client-side mode this shot is ABOUT -------------- */
    if (shot.drive) {
      const reached = await drive(h.page, shot.drive);
      if (shot.expect && !String(reached).startsWith(shot.expect)) {
        // Capture anyway — the picture of the failure is the evidence — but the
        // gate is red. A shot that silently degrades to "whatever the fixture
        // looked like" is exactly the round-1 targeting lie.
        fail(`${label} — driver '${shot.drive}' reached '${reached}', expected '${shot.expect}*'`);
      }
    }

    await h.page.waitForTimeout(180);

    /* ---- text fit, measured in the page at capture time ------------------ */
    const clips = await h.page.evaluate(audit.auditClippedText);
    if (clips.length) clipped.push({ shot: label, items: clips });

    /* ---- shoot a SETTLED frame ------------------------------------------
     * Not a timeout. `--prove-theme` found `mid-game@desktop` producing two
     * DIFFERENT images from the same state and the same theme, because the
     * coach hint over the board fades on its own schedule — which means the
     * byte-identical checks (both the duplicate-shot rule and the theme-pair
     * rule) were comparing frames that happened to be caught at different
     * moments. A review set whose evidence changes between two identical runs
     * cannot support either assertion.                                       */
    const file = path.join(SHOT_DIR, `${label}.png`);
    const frame = await stableScreenshot(h.page);
    fs.writeFileSync(file, frame.buffer);
    if (!frame.settled) unsettled.push(label);
    // A host driver may still be holding the pointer down (`drag-mid`).
    // Released only AFTER the shutter, and before the next navigation.
    await releaseInput(h.page);

    const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    if (shot.themes) {
      const key = `${shot.name}@${screen.tag}`;
      if (!themePairs.has(key)) themePairs.set(key, {});
      themePairs.get(key)[theme.key] = { hash, fp, label };
    }
    if (hashes.has(hash)) {
      // Theme pairs get their own verdict below; this generic message would
      // bury the interesting half ("which surface is theme-deaf") in noise.
      if (!shot.themes) fail(`${label} is BYTE-IDENTICAL to ${hashes.get(hash)} — two names, one picture`);
    } else {
      hashes.set(hash, label);
    }
    captured.push({ name: `${shot.name} · ${screen.tag}${theme.tag}`, file });
    console.log(`  ${green('✓')} ${shot.name.padEnd(16)} `
      + `${dim(`${screen.tag}${theme.tag ? ` ${theme.key}` : ''}`)}`
      + `${clips.length ? yellow(`  ${clips.length} clipped`) : ''}`);
  } catch (e) {
    fail(`${label} — ${e.message.split('\n')[0]}`);
  }
}

try {
  browser = await launchBrowser();

  for (const screen of SCREEN_LIST) {
    const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`, screen);
    // Every take starts from a first-time player's storage, or the coach layer
    // appears in whichever shot happens to be first (see pristineStorage).
    await pristineStorage(h.context);
    await requireBridge(h.page, 8000);

    for (const shot of SHOT_LIST) {
      if (!screenTakes(shot, screen.tag)) continue;
      for (const theme of takesFor(shot, screen.tag)) await take(h, screen, shot, theme);
    }

    if (h.errors.length) {
      fail(`${h.errors.length} console/page error(s) on ${screen.tag}`);
      for (const e of h.errors.slice(0, 5)) console.log(red(`      ${e}`));
    }
    await h.close();
  }

  /* ---- theme coverage verdict --------------------------------------------
   * ART §2 ships two appearances. If the light take of a surface is the same
   * bytes as its dark take, the review set has two names and one picture again
   * — the exact defect this file was written for, only now it hides a whole
   * half of the design system instead of one interaction mode.               */
  {
    let deaf = 0;
    for (const [key, pair] of themePairs) {
      if (!pair.dark || !pair.light) continue;
      if (pair.dark.hash !== pair.light.hash) continue;
      deaf++;
      fail(`${key}: the light and dark takes are BYTE-IDENTICAL — the theme system does not reach this surface`);
      const t = pair.light.fp;
      console.log(dim(`      prefers-color-scheme:dark=${t.matchesDark} data-theme='${t.dataTheme}' `
        + `app background ${t.appBg}, colour ${t.appFg}`));
      if (sameAppearance(pair.dark.fp, pair.light.fp)) {
        console.log(dim(`      tokens are identical in both: ${t.tokens || '(no §2 tokens defined)'}`));
      }
    }
    if (!deaf && themePairs.size) {
      console.log(`  ${green('✓')} ${themePairs.size} surface(s) render differently in light and dark`);
    }
    if (PROVE_THEME) {
      // The whole point of the flag: every pair MUST have collapsed. Reset the
      // exit code either way — this run is a demonstration, not a review set.
      const ok = deaf === themePairs.size && deaf > 0;
      console.log(ok
        ? green(`  ✓ --prove-theme: all ${deaf} theme pair(s) went red when the light pass was rendered dark`)
        : red(`  ✗ --prove-theme: only ${deaf}/${themePairs.size} pair(s) went red — the theme verdict is a decoration`));
      code = ok ? EXIT_PASS : EXIT_FAIL;
      problems.length = 0;
    }
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

  /* ---- frames that never settled -----------------------------------------
   * Not fatal — some of these shots are ABOUT a live moment. But an unsettled
   * frame is a shot whose bytes are a coin flip, so both byte-identical rules
   * are only as trustworthy as this list is short.                            */
  if (unsettled.length) {
    console.log(`  ${yellow('!')} ${unsettled.length} shot(s) never stopped changing before the `
      + `shutter: ${unsettled.slice(0, 6).join(', ')}${unsettled.length > 6 ? ' …' : ''}`);
  } else {
    console.log(`  ${green('✓')} every frame settled before capture`);
  }

  /* ---- contact sheet ------------------------------------------------------ */
  if (captured.length) {
    const COLS = 4;
    const CELL_W = 320;
    const CELL_H = 200;
    const rows = Math.ceil(captured.length / COLS);
    const sheet = new PNG({ width: COLS * CELL_W, height: rows * CELL_H, filterType: 4 });
    // Mid grey, not near-black: the sheet now carries light AND dark takes
    // (ART §2), and a near-black backing made every light tile look like it had
    // a halo while a white one did the same to the dark ones. 50% is neutral to
    // both, which is the only honest backing for a two-theme set.
    sheet.data.fill(128);
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
        themes: THEMES.map((t) => t.key),
        themePairs: [...themePairs].map(([k, p]) => ({
          surface: k,
          differs: !!(p.dark && p.light) && p.dark.hash !== p.light.hash,
        })),
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
