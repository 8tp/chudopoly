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
    colorScheme: 'dark',
    reducedMotion: opts.reducedMotion || 'no-preference',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
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
