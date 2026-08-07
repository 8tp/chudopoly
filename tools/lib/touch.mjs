/**
 * tools/lib/touch.mjs — REAL touch input, via CDP Input.dispatchTouchEvent.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Why this file exists (P7 round-1 finding, mobile critic):
 * touchtest.mjs used to dispatch `new PointerEvent(...)` from page JS. Those
 * events are created and delivered inside the renderer's script context — they
 * never enter the browser's real input pipeline, so:
 *
 *   • `touch-action` is never consulted (the compositor is not involved),
 *   • scroll/gesture arbitration never happens,
 *   • `preventDefault()` on a passive listener has no observable consequence,
 *   • no `touchstart`/`touchmove`/`touchend` is produced at all — only pointer.
 *
 * Result: the gate reported 9/9 PASS while a real thumb-drag that started
 * horizontally was dead on arrival (the compositor claimed the gesture for a
 * pan before the client ever saw a move). CDP `Input.dispatchTouchEvent` enters
 * at the browser process, produces real touch + compensated pointer + mouse
 * events, and is subject to touch-action exactly like a finger.
 *
 * Everything in tools/ that claims to test touch MUST go through here.
 */
import {
  PHONE, PHONE_DPR, PHONE_UA, LANDSCAPE,
} from './harness.mjs';

/** iPhone 14/15 portrait software keyboard height, in CSS px. */
export const KEYBOARD_PX = 336;

/** Wrap a CDP session in the gesture vocabulary a thumb actually has. */
export function touchDriver(cdp) {
  const send = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points, modifiers: 0 });
  const pt = (x, y, id = 1) => ({
    x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1, id,
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** A real tap: touchStart, dwell, touchEnd. No synthetic click is injected. */
  const tap = async (x, y, holdMs = 55) => {
    await send('touchStart', [pt(x, y)]);
    await wait(holdMs);
    await send('touchEnd', []);
  };

  /** Long press — the gesture that opens details / triggers context menus. */
  const press = async (x, y, ms = 650) => {
    await send('touchStart', [pt(x, y)]);
    await wait(ms);
    await send('touchEnd', []);
  };

  /**
   * Follow a path of points. `path` is [[x,y], ...] AFTER the start point.
   * stepMs 16 ≈ one frame; a human drag is 200–400ms, not one instant jump —
   * and the difference matters because drag thresholds are time+distance based.
   */
  const drag = async (x0, y0, path, { stepMs = 16, holdMs = 40, onStep } = {}) => {
    await send('touchStart', [pt(x0, y0)]);
    await wait(holdMs);
    for (let i = 0; i < path.length; i++) {
      await wait(stepMs);
      await send('touchMove', [pt(path[i][0], path[i][1])]);
      if (onStep) await onStep(i, path[i]);
    }
    await wait(stepMs);
    await send('touchEnd', []);
  };

  /** Straight-line drag from (x0,y0) to (x1,y1) in `steps` moves. */
  const swipe = (x0, y0, x1, y1, steps = 16, opts = {}) => drag(x0, y0,
    Array.from({ length: steps }, (_, i) => [
      x0 + ((x1 - x0) * (i + 1)) / steps,
      y0 + ((y1 - y0) * (i + 1)) / steps,
    ]), opts);

  /**
   * A drag whose FIRST movement is horizontal, then turns vertical. This is the
   * worst case for `touch-action` / scroll arbitration and is the exact gesture
   * the mobile critic found dead: the browser hands a horizontal-first gesture
   * to the pan handler unless the element opts out.
   */
  const dragHorizontalFirst = (x0, y0, x1, y1, opts = {}) => {
    const path = [];
    const lead = Math.max(40, Math.abs(x1 - x0) * 0.5) * (x1 >= x0 ? 1 : -1);
    for (let i = 1; i <= 8; i++) path.push([x0 + (lead * i) / 8, y0 + i]);
    const mx = x0 + lead;
    const my = y0 + 8;
    for (let i = 1; i <= 10; i++) {
      path.push([mx + ((x1 - mx) * i) / 10, my + ((y1 - my) * i) / 10]);
    }
    return drag(x0, y0, path, opts);
  };

  return { rawTouch: send, touchPoint: pt, tap, press, drag, swipe, dragHorizontalFirst };
}

/**
 * Open a page with a real touchscreen attached. Same error collection contract
 * as harness.openPage, plus the CDP session and the gesture vocabulary.
 */
export async function openTouchPage(browser, url, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport || PHONE,
    deviceScaleFactor: opts.dpr ?? PHONE_DPR,
    isMobile: true,
    hasTouch: true,
    userAgent: opts.userAgent || PHONE_UA,
    // P8 round 2: this was hardcoded 'dark', so the light theme was never
    // touch-tested at all — half of ART §2 had no mobile gate.
    colorScheme: opts.colorScheme || 'dark',
    reducedMotion: opts.reducedMotion || 'no-preference',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  /**
   * P8 round 2 GAP (mobile critic): touchtest never reset client storage, and
   * hints are shown ONCE EVER out of `localStorage`. Instrumented at the
   * `payment-pending` stage, `chud_hints_v1` already held `["peek","drag","pay"]`
   * — consumed by the live game ninety seconds earlier in the same run. So §D's
   * "no decorative layer covers a primary CTA" was asserting against a build
   * where the decorative layer could no longer appear: an assertion structurally
   * incapable of failing.
   *
   * harness.mjs documented this exact trap for screenshot.mjs and shipped
   * `pristineStorage` for it; this file simply never called it. Same init-script
   * approach here so it survives every `page.goto` a stage does.
   */
  if (opts.pristine !== false) {
    await context.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ }
    });
  }
  const cdp = await context.newCDPSession(page);
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  return {
    page, context, cdp, errors,
    ...touchDriver(cdp),
    /** Cut the wire at the network stack — the client cannot tell this from a tunnel. */
    setOffline: (offline) => cdp.send('Network.emulateNetworkConditions', {
      offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }).catch(() => cdp.send('Network.enable').then(() => cdp.send('Network.emulateNetworkConditions', {
      offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }))),
    close: () => context.close(),
  };
}

/**
 * Wait until layout has stopped moving, then measure. Returns how long it took.
 *
 * P8 round 2: the hand-fan tap-target verdict moved between runs and between
 * settle times — `[46,46,46,44,42,42,42,56]` on one pass and
 * `[47,48,48,46,44,44,44,56]` on another — so `waitForTimeout(300)` was deciding
 * whether the gate was red. A fixed sleep is a guess about a machine's load; two
 * consecutive identical geometry reads are a fact about the layout. Same
 * argument as harness.stableScreenshot, one level up.
 */
export async function settleLayout(page, { gap = 120, budgetMs = 3000 } = {}) {
  const read = () => page.evaluate(() => [...document.querySelectorAll(
    '#zone-hand [data-card-id], [data-zone="hand"] [data-card-id], .propcol, button, #sheet, #side',
  )].map((e) => {
    const r = e.getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
  }).join('|'));
  const started = Date.now();
  let prev = await read();
  while (Date.now() - started < budgetMs) {
    await page.waitForTimeout(gap);
    const next = await read();
    if (next === prev) return { settled: true, ms: Date.now() - started };
    prev = next;
  }
  return { settled: false, ms: Date.now() - started };
}

/**
 * The §9 bridge, waited for HONESTLY.
 *
 * P8 round 2: touchtest returned `PENDING CLIENT` (exit 2, which strict verify
 * treats as failure) on 2 of 6 runs whenever a second headless Chromium was
 * live — an 8s budget on a loaded machine is a measurement of the machine, not
 * of the client. The budget is now 30s, which is not leniency about real
 * absence: `window.__CHUD` either gets defined by module evaluation or it never
 * does, and a client that has not shipped it still reports absent. What changes
 * is that "slow" stops being reported as "not implemented".
 */
export async function waitForBridge(page, budgetMs = 30000) {
  const started = Date.now();
  const found = await page.waitForFunction(() => !!window.__CHUD, null, { timeout: budgetMs })
    .then(() => true).catch(() => false);
  if (!found) return { ok: false, ms: Date.now() - started };
  await page.evaluate(() => window.__CHUD.ready).catch(() => {});
  return { ok: true, ms: Date.now() - started };
}

/** Centre + geometry of the nth match, or null if absent/zero-sized. */
export function centre(page, selector, nth = 0) {
  return page.evaluate(([sel, n]) => {
    const el = document.querySelectorAll(sel)[n];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return {
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), left: Math.round(r.left),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
    };
  }, [selector, nth]);
}

export { PHONE, PHONE_DPR, PHONE_UA, LANDSCAPE };
