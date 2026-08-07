/**
 * Shared harness plumbing. HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Exit-code contract used by every tool in tools/ and by `npm run verify`:
 *   0 = pass
 *   1 = real failure (gate must block)
 *   2 = SKIP — the thing under test does not exist yet (client/engine still
 *       being written). verify prints a loud warning and keeps going.
 *
 * Code 2 exists because P2 (this harness) lands before P3 (public/src/) and
 * concurrently with P1's engine rewrite. Without it every tool would report a
 * red failure for work that simply has not been done yet, and a real red would
 * be invisible in the noise.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TOOLS = path.join(ROOT, 'tools');
export const FIXTURE_DIR = path.join(TOOLS, 'fixtures');
export const SHOT_DIR = path.join(TOOLS, 'shots');

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_SKIP = 2;

export const DESKTOP = { width: 1280, height: 720 };
export const PHONE = { width: 390, height: 844 };
/**
 * The same phone rotated. Added P7 round 1: the mobile critic found
 * `.self-board { height: 0 }` at 844×390 — the game was completely unplayable
 * in landscape and no gate looked, because every tool measured portrait only.
 */
export const LANDSCAPE = { width: 844, height: 390 };
export const PHONE_DPR = 3;
export const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** Default harness seed. Every tool pins one so failures are reproducible. */
export const SEED = Number(process.env.CHUD_SEED || 1337);

export function green(s) { return `\x1b[32m${s}\x1b[0m`; }
export function red(s) { return `\x1b[31m${s}\x1b[0m`; }
export function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
export function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
export function dim(s) { return `\x1b[2m${s}\x1b[0m`; }

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      out[a.slice(2)] = next && !next.startsWith('--') ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

/** Tiny result collector so every tool prints the same shape. */
export function reporter(title) {
  console.log(bold(title));
  const state = { code: EXIT_PASS, passes: 0, fails: 0 };
  return {
    pass(m) { state.passes++; console.log(`  ${green('✓')} ${m}`); },
    fail(m) { state.fails++; state.code = EXIT_FAIL; console.log(`  ${red('✗')} ${m}`); },
    warn(m) { console.log(`  ${yellow('!')} ${m}`); },
    info(m) { console.log(`    ${dim(m)}`); },
    get code() { return state.code; },
    finish(label = title) {
      const ok = state.code === EXIT_PASS;
      console.log(ok
        ? green(bold(`${label}: PASS (${state.passes})`))
        : red(bold(`${label}: FAIL (${state.fails}/${state.passes + state.fails})`)));
      return state.code;
    },
  };
}

/** Bail out with the SKIP code and a message verify knows how to display. */
export function pending(what, why) {
  console.log(yellow(bold(`  PENDING ${what}`)) + ` — ${why}`);
  process.exit(EXIT_SKIP);
}

/** Load playwright lazily so Node-only tools still run without it installed. */
export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    console.log(red('playwright is not installed — run: npm i && npx playwright install chromium'));
    process.exit(EXIT_FAIL);
  }
}

const BASE_CHROME_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-font-subpixel-positioning',
  '--hide-scrollbars',
  '--mute-audio',
];

export async function launchBrowser(extraArgs = []) {
  const { chromium } = await loadPlaywright();
  return chromium.launch({ headless: true, args: [...BASE_CHROME_ARGS, ...extraArgs] });
}

/**
 * Open a page against the running server with the harness bridge requested.
 * Collects pageerrors and console.errors; callers assert on them.
 */
export async function openPage(browser, url, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport || DESKTOP,
    deviceScaleFactor: opts.dpr ?? 1,
    isMobile: !!opts.isMobile,
    hasTouch: !!opts.hasTouch,
    userAgent: opts.userAgent,
    colorScheme: 'dark',
    reducedMotion: opts.reducedMotion || 'no-preference',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  return { page, context, errors, close: () => context.close() };
}

/**
 * The §9 bridge gate. Returns the bridge handle or exits 2.
 * Every browser tool calls this immediately after openPage.
 */
export async function requireBridge(page, timeoutMs = 8000) {
  const found = await page
    .waitForFunction(() => !!window.__CHUD, null, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!found) {
    pending('CLIENT', 'window.__CHUD is absent with ?harness=1 — public/src/ (P3) has not landed yet');
  }
  await page.evaluate(() => window.__CHUD.ready).catch(() => {});
  return true;
}

export function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
}
