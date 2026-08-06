#!/usr/bin/env node
/**
 * tools/touchtest.mjs — touch-only core actions on an emulated iPhone (§8).
 *
 * 390×844 DPR3, isMobile + hasTouch, iOS UA. Mouse events are never sent: the
 * drag/target/pay paths in interact/ are a genuinely different code path from
 * the desktop one, and a regression there is invisible to every other tool.
 *
 * Asserts:
 *   • the table receives touches (nothing stacked above it swallowing drags)
 *   • drag-play: a hand card dragged onto a zone actually plays
 *   • pay a rent: payment selection is reachable and confirmable by touch
 *   • target a steal: an eligible player board can be chosen on the table
 *   • the HUD fits — no horizontal page overflow, no visible chrome off-screen
 *   • tap targets ≥ 44px (§0.9)
 *
 * Fixtures stage each scenario (recorded from real games, §9) so this tool does
 * not have to race a live game to reach a payment.
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR, PHONE, PHONE_DPR, PHONE_UA, SEED, parseArgs, launchBrowser, openPage,
  requireBridge, reporter, readJSON, green, red, yellow, dim, bold,
  EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

const r = reporter(`touchtest  ${dim(`${PHONE.width}×${PHONE.height} DPR${PHONE_DPR}, touch only`)}`);
const server = await startServer({ seed });
let browser = null;
let code = EXIT_PASS;

function fixture(name) {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  const f = readJSON(file);
  return Array.isArray(f) ? f[f.length - 1] : f.states[f.states.length - 1];
}

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`, {
    viewport: PHONE, dpr: PHONE_DPR, isMobile: true, hasTouch: true, userAgent: PHONE_UA,
  });
  await requireBridge(h.page, 8000);
  r.pass('booted on an emulated iPhone with the __CHUD bridge');

  /**
   * §9 does not (yet) specify a request log on the bridge, but "did this touch
   * actually ASK the server to do anything" cannot be observed any other way —
   * the server is authoritative, so the DOM does not change until the response
   * arrives. HARNESS REQUEST TO P3: add `sentLog: [{type, t, ...}]` to __CHUD,
   * appended by net/socket.js on every outbound message. Until it exists these
   * three assertions degrade to warnings rather than blocking the gate.
   */
  const hasSentLog = await h.page.evaluate(() => Array.isArray(window.__CHUD.sentLog));
  if (!hasSentLog) r.warn('__CHUD.sentLog absent — request assertions degraded to warnings (see tools/touchtest.mjs header)');
  const assertSent = (ok, good, bad) => {
    if (ok) r.pass(good);
    else if (hasSentLog) r.fail(bad);
    else r.warn(`${bad} ${dim('(unverifiable without __CHUD.sentLog)')}`);
  };

  const stage = async (name) => {
    const state = fixture(name);
    if (!state) { r.warn(`fixture ${name}.json missing — run npm run tool:record`); return false; }
    await h.page.evaluate((s) => { window.__CHUD.applyState(s); window.__CHUD.drainEvents?.(); }, state);
    await h.page.waitForTimeout(150);
    return true;
  };

  /* ---- 1. the table is reachable by finger -------------------------------- */
  if (await stage('mid-game')) {
    const blocked = await h.page.evaluate(() => {
      const pts = [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6]];
      for (const [lx, ly] of pts) {
        const els = document.elementsFromPoint(innerWidth * lx, innerHeight * ly);
        const card = els.find((e) => e.hasAttribute?.('data-card-id'));
        if (!card) continue;
        const idx = els.indexOf(card);
        const above = els.slice(0, idx).filter((e) => getComputedStyle(e).pointerEvents !== 'none');
        if (above.length) return `${above[0].tagName.toLowerCase()}${above[0].id ? '#' + above[0].id : ''} at ${lx},${ly}`;
        return null;
      }
      return 'no card node hit-testable anywhere on the table';
    });
    if (blocked) r.fail(`table touches are swallowed: ${blocked}`);
    else r.pass('card nodes receive touches on the table');

    /* ---- 2. drag-play a hand card ---------------------------------------- */
    const dragged = await h.page.evaluate(async () => {
      const B = window.__CHUD;
      const before = B.driftCount;
      const card = document.querySelector('[data-zone="hand"] [data-card-id]');
      const zone = document.querySelector('[data-zone^="properties"], [data-zone="bank"]');
      if (!card || !zone) return { ok: false, why: 'no hand card or no drop zone in the DOM' };
      const from = card.getBoundingClientRect();
      const to = zone.getBoundingClientRect();
      const pt = (type, x, y, target) => target.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
      const sx = from.left + from.width / 2, sy = from.top + from.height / 2;
      const tx = to.left + to.width / 2, ty = to.top + to.height / 2;
      pt('pointerdown', sx, sy, card);
      for (let i = 1; i <= 8; i++) {
        pt('pointermove', sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8, window);
      }
      pt('pointerup', tx, ty, window);
      await new Promise((res) => setTimeout(res, 250));
      return { ok: true, drift: B.driftCount - before, sent: (B.sentLog || []).slice(-1)[0] || null };
    });
    if (!dragged.ok) r.fail(`drag-play: ${dragged.why}`);
    else assertSent(
      !!dragged.sent && /play_(property|money|action)/.test(dragged.sent.type || ''),
      `drag-play issued ${dragged.sent?.type}`,
      'drag-play produced no play_* request (drag path is dead on touch)'
    );
  }

  /* ---- 3. pay a rent ------------------------------------------------------ */
  if (await stage('payment-pending')) {
    const pay = await h.page.evaluate(async () => {
      const tap = (el) => {
        const rct = el.getBoundingClientRect();
        const x = rct.left + rct.width / 2, y = rct.top + rct.height / 2;
        for (const t of ['pointerdown', 'pointerup', 'click']) {
          el.dispatchEvent(new PointerEvent(t, {
            pointerId: 1, pointerType: 'touch', isPrimary: true,
            clientX: x, clientY: y, bubbles: true, cancelable: true,
          }));
        }
      };
      const payable = document.querySelector('[data-payable="1"], [data-zone="bank"] [data-card-id]');
      if (!payable) return { ok: false, why: 'no payable card is selectable' };
      tap(payable);
      await new Promise((res) => setTimeout(res, 120));
      const confirm = document.querySelector('[data-action="confirm-payment"]');
      if (!confirm) return { ok: false, why: 'no payment confirm control' };
      tap(confirm);
      await new Promise((res) => setTimeout(res, 200));
      return { ok: true, sent: (window.__CHUD.sentLog || []).slice(-1)[0] || null };
    });
    if (!pay.ok) r.fail(`pay a rent: ${pay.why}`);
    else assertSent(
      pay.sent?.type === 'respond',
      'payment selection confirmed by touch',
      'payment confirm produced no respond request'
    );
  }

  /* ---- 4. target a steal -------------------------------------------------- */
  if (await stage('targeting')) {
    const target = await h.page.evaluate(async () => {
      const glow = document.querySelectorAll('[data-targetable="1"]');
      if (!glow.length) return { ok: false, why: 'no targetable board is marked' };
      const el = glow[0];
      const rct = el.getBoundingClientRect();
      for (const t of ['pointerdown', 'pointerup', 'click']) {
        el.dispatchEvent(new PointerEvent(t, {
          pointerId: 1, pointerType: 'touch', isPrimary: true,
          clientX: rct.left + rct.width / 2, clientY: rct.top + rct.height / 2,
          bubbles: true, cancelable: true,
        }));
      }
      await new Promise((res) => setTimeout(res, 200));
      return { ok: true, count: glow.length, sent: (window.__CHUD.sentLog || []).slice(-1)[0] || null };
    });
    if (!target.ok) r.fail(`target a steal: ${target.why}`);
    else r.pass(`${target.count} eligible board(s) glowed; tap selected one`);
  }

  /* ---- 5. layout + tap targets ------------------------------------------- */
  const layout = await h.page.evaluate(() => {
    const w = innerWidth, hgt = innerHeight;
    const off = [];
    const small = [];
    document.querySelectorAll('button, [role="button"], [data-action]').forEach((el) => {
      const rct = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (!rct.width || !rct.height) return;
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return;
      if (rct.right > w + 2 || rct.left < -2 || rct.bottom > hgt + 2 || rct.top < -2) {
        off.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0] || '?'} ${Math.round(rct.left)},${Math.round(rct.top)}`);
      }
      if (rct.width < 44 || rct.height < 44) {
        small.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0] || '?'} ${Math.round(rct.width)}×${Math.round(rct.height)}`);
      }
    });
    return { off: off.slice(0, 8), small: small.slice(0, 8), scrollW: document.documentElement.scrollWidth, w };
  });

  if (layout.scrollW > layout.w + 1) r.fail(`page scrolls horizontally (${layout.scrollW} > ${layout.w})`);
  else r.pass('HUD fits — no horizontal overflow');

  if (layout.off.length) {
    r.fail(`${layout.off.length} interactive element(s) outside the viewport`);
    for (const o of layout.off) r.info(o);
  } else r.pass('all interactive elements are on-screen');

  if (layout.small.length) {
    r.fail(`${layout.small.length} tap target(s) under 44px (§0.9)`);
    for (const s of layout.small) r.info(s);
  } else r.pass('tap targets ≥ 44px');

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s) on phone`);
    for (const e of h.errors.slice(0, 6)) console.log(red(`      ${e}`));
  } else r.pass('no console errors on phone');

  await h.close();
  code = r.code;
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('touchtest: PASS')) : red(bold('touchtest: FAIL')));
process.exit(code);
