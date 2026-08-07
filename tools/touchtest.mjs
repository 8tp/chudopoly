#!/usr/bin/env node
/**
 * tools/touchtest.mjs — the mobile gate (§8, §0.9, §2).
 *
 * REWRITTEN P7 round 1. The previous version passed 9/9 while the mobile critic
 * scored the shipped product 5/10 with evidence. Every one of its misses was a
 * gate gap, and each is now a named section below:
 *
 *   §A real touch      old tool dispatched `new PointerEvent()` from page JS, so
 *                      `touch-action` was never consulted and a drag that starts
 *                      horizontally — dead in the product — looked healthy.
 *                      Now every gesture is CDP Input.dispatchTouchEvent.
 *   §B tap targets     old audit selected `button,[role=button],[data-action]`.
 *                      `.propcol` (20px tall, the primary on-table targeting
 *                      surface), hand card strips, `input`, `select` were all
 *                      exempt. Now everything a finger can hit is measured.
 *   §C per surface     old tool measured layout ONCE, in whatever state was
 *                      staged last. Help, settings, side panel, emote, discard,
 *                      win and the scoop confirm were never sized. Now each
 *                      surface is opened and measured.
 *   §D occlusion       old tool used elementsFromPoint, which SKIPS
 *                      pointer-events:none — the hint layer is exactly that, so
 *                      a coach bubble over 83% of CONFIRM PAYMENT was invisible.
 *                      Now: rectangle overlap of veil layers against CTAs.
 *   §E landscape       never measured. `.self-board` was 0px tall at 844×390.
 *   §F soft keyboard   never measured. Chat composer sat 327px under it.
 *   §G dead space      never measured. ~68px of double-counted safe-area.
 *   §H offline         never measured. No reconnect affordance under a dead net.
 *   §I duplicate CTAs  never measured. Two enabled DRAW buttons, 57px apart.
 *
 * P8 ROUND 2. A fresh mobile critic found the gate passing for the wrong
 * reasons. Four of the five findings were about the gate's own integrity, not
 * about coverage, and they are fixed here:
 *
 *   §D was INCAPABLE OF FAILING. This file never reset client storage, and
 *      hints are shown once-ever out of `localStorage` — by the time the
 *      `payment-pending` stage ran, `chud_hints_v1` already held
 *      `["peek","drag","pay"]`, consumed by the live game ninety seconds
 *      earlier in the same run. The layer §D exists to catch could not appear.
 *      `openTouchPage` now clears storage per navigation (the mechanism
 *      harness.mjs already shipped for screenshot.mjs), `auditOcclusion`'s CTA
 *      list is a rule instead of a hand-maintained list of ids (it was missing
 *      `.pile[data-action="open-discard"]`, a primary on-table control), and
 *      `--prove` demonstrates §D going red.
 *
 *   §0.9 was ORDER-DEPENDENT. Same fixture, same viewport: applied as the FIRST
 *      state the hand strips measure [46,46,46,44,42,42,42,56] — three under
 *      44px — and applied after any other state they measure
 *      [47,48,48,46,44,44,44,56] — none under. (A module-level `cssStep` cache
 *      in the client only captures on a layout with no inline margin, so a hand
 *      that has been tightened once holds a stale natural step; that bug is
 *      being fixed separately.) This file staged payment and targeting before
 *      discard-limit and therefore always measured the lucky branch. Every
 *      staged surface is now measured COLD — fresh document, state applied
 *      once, no interaction — and settled by geometry rather than by a sleep.
 *
 *   TAP TARGETS SKIPPED THE REAL HIT AREA. `auditTapTargets` dropped
 *      `opacity: 0` elements, so the visually-hidden `<input>` that IS the
 *      target of a 44×23 settings switch was never measured.
 *
 *   "EVERY INTERACTIVE ELEMENT IS ON-SCREEN" only tested the viewport, never
 *      overflow scrollers — which is why it could not see three of the four
 *      targetable opponent boards sitting at `visibleH 0` in landscape.
 *
 *   PENDING CLIENT WAS FLAKY: exit 2 on 2 of 6 runs with a second headless
 *      Chromium live, from an 8s bridge budget. Now 30s, still strict about
 *      real absence.
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR, PHONE, PHONE_DPR, LANDSCAPE, SEED, parseArgs, launchBrowser,
  reporter, readJSON, green, red, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import {
  openTouchPage, centre, settleLayout, waitForBridge, KEYBOARD_PX,
} from './lib/touch.mjs';
import * as audit from './lib/audit.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;
/** See waitForBridge: 8s was measuring the machine, not the client. */
const BRIDGE_MS = 30000;

const r = reporter(`touchtest  ${dim(`${PHONE.width}×${PHONE.height} DPR${PHONE_DPR} + ${LANDSCAPE.width}×${LANDSCAPE.height}, real touch only`)}`);
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
  const h = await openTouchPage(browser, `${server.url}/?harness=1&seed=${seed}`);
  const page = h.page;

  const bridged = await waitForBridge(page, BRIDGE_MS);
  if (!bridged.ok) {
    console.log(`  PENDING CLIENT — window.__CHUD absent with ?harness=1 after ${bridged.ms}ms`);
    await h.close(); await browser.close(); await server.stop();
    process.exit(2);
  }
  r.pass(`booted on an emulated iPhone with a real touchscreen ${dim(`(bridge in ${bridged.ms}ms)`)}`);

  const sentCount = () => page.evaluate(() => (window.__CHUD.sentLog || []).length);
  const lastSent = () => page.evaluate(() => (window.__CHUD.sentLog || []).slice(-1)[0] || null);
  const modeKind = () => page.evaluate(() => window.__CHUD.mode?.kind);
  const tapSel = async (sel, nth = 0, hold) => {
    const c = await centre(page, sel, nth);
    if (!c) return false;
    await h.tap(c.x, c.y, hold);
    return true;
  };

  /* ═══ §B/§C: one audit routine, run per surface ════════════════════════ */
  const surfaceIssues = [];
  /**
   * Staged surfaces that never got measured.
   *
   * P8 round 2, measured on one run in four: `§H` left the browser unable to
   * reach the server, all five staged surfaces died on ERR_CONNECTION_REFUSED —
   * and the run still printed "✓ tap targets ≥ 44px on all 9 measured
   * surfaces", because the summaries below count what they were GIVEN. A green
   * summary over a set that is missing the surfaces the run was about is the
   * same defect as an assertion that cannot fail, so the summaries are now
   * suppressed and the run is red whenever this list is non-empty.
   */
  const stagesFailed = [];
  async function measureSurface(label) {
    // Settle by GEOMETRY, never by a sleep: the hand-fan verdict flipped between
    // three-under-44px and none-under depending on when the measurement landed.
    const s = await settleLayout(page);
    if (!s.settled) r.warn(`[${label}] layout never stopped moving in ${s.ms}ms — the numbers below are of a moving target`);
    const t = await page.evaluate(audit.auditTapTargets);
    const occ = await page.evaluate(audit.auditOcclusion);
    const dup = await page.evaluate(audit.auditDuplicateCTAs);
    const rec = {
      label, small: t.fatal, zones: t.zones, advisory: t.advisory,
      off: t.offscreen, clipped: t.clipped, occ, dup, t,
    };
    surfaceIssues.push(rec);
    if (t.scrollW > t.w + 1) {
      r.fail(`[${label}] page scrolls horizontally (${t.scrollW} > ${t.w})`);
    }
    return rec;
  }

  /* ═══════════════ live game on the phone, driven by thumb ═════════════ */
  await page.evaluate(() => window.__CHUD.setInstant(false));
  if (!(await tapSel('#name-input'))) r.fail('#name-input is not tappable on the home screen');
  await page.keyboard.type('TOUCH');
  await measureSurface('home');
  if (!(await tapSel('#btn-quick-play'))) r.fail('quick-play button missing');
  const inGame = await page.waitForFunction(
    () => !document.getElementById('screen-game')?.hidden, null, { timeout: 25000 },
  ).then(() => true).catch(() => false);
  if (!inGame) r.fail('quick play never reached the game screen by touch');
  await page.waitForTimeout(2200);

  if (inGame) {
    /* ── §I duplicate CTAs, measured BEFORE the draw resolves ─────────── */
    const preDraw = await measureSurface('game:draw-phase');
    if (preDraw.dup.length) {
      r.fail(`${preDraw.dup.length} duplicate enabled control(s) on screen at once (§I)`);
      for (const d of preDraw.dup) r.info(`${d.key} ×${d.count}, ${d.gap}px apart — ${d.where.join(' / ')}`);
    } else r.pass('no duplicate enabled CTA on screen');

    /* ── our turn arrives, and DRAW must not be lying ────────────────────
     * The engine auto-draws (P7, commit 65e36ef): `turnPhase` is never
     * broadcast as 'draw' any more, so there is nothing to tap and the old
     * assertion here ("a real tap on DRAW reaches the server") is not just
     * stale, it is unsatisfiable. What is worth asserting is the inverse — a
     * visible, ENABLED draw control under auto-draw is a control that does
     * nothing, and a dead primary button teaches the player that taps do not
     * work.                                                                  */
    const myTurn = await page.waitForFunction(() => {
      const B = window.__CHUD;
      return !!B.snapshot && B.snapshot.currentPlayerId === B.selfId;
    }, null, { timeout: 40000 }).then(() => true).catch(() => false);
    if (!myTurn) r.fail('the turn never came round to this seat within 40s');
    else {
      await page.waitForTimeout(600);
      const draw = await page.evaluate(() => {
        const els = [...document.querySelectorAll('[data-action="draw"]')];
        const live = els.filter((el) => {
          if (el.disabled) return false;
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
          for (let p = el; p; p = p.parentElement) if (p.hasAttribute?.('hidden')) return false;
          return el.getBoundingClientRect().height > 0;
        });
        return { total: els.length, live: live.length, phase: window.__CHUD.snapshot?.turnPhase };
      });
      if (draw.live) {
        r.fail(`${draw.live} enabled DRAW control(s) on screen while turnPhase is '${draw.phase}' `
          + '— the engine auto-draws, so tapping it does nothing');
      } else r.pass(`no dead DRAW affordance under auto-draw ${dim(`(turnPhase '${draw.phase}')`)}`);
    }

    /* ── §A drag-play, vertical then horizontal-first ──────────────────── */
    async function realDrag(label, horizontalFirst) {
      const from = await centre(page, '#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]', 0);
      const to = await centre(page, '#self-board .propcol, #self-board [data-zone^="properties"], [data-zone="bank"]', 0);
      if (!from || !to) { r.fail(`${label}: no hand card / drop zone in the DOM`); return; }
      const before = await sentCount();
      let sawDragging = false;
      const onStep = async (i) => {
        if (i !== 4 && i !== 9) return;
        sawDragging = sawDragging || await page.evaluate(
          () => !!document.querySelector('.is-dragging, [data-dragging="1"]'),
        );
      };
      if (horizontalFirst) await h.dragHorizontalFirst(from.x, from.y, to.x, to.y, { onStep });
      else await h.swipe(from.x, from.y, to.x, to.y, 18, { onStep });
      await page.waitForTimeout(800);
      const after = await sentCount();
      if (after > before) r.pass(`${label}: the drag played a card (${(await lastSent())?.type})`);
      else r.fail(`${label}: real touch drag produced NO request — the gesture never reached the client${sawDragging ? '' : ' (drag never even started; touch-action is claiming it)'} (§A)`);
      // Leave no half-open mode behind.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    }
    await realDrag('drag-play (vertical)', false);
    await realDrag('drag-play (horizontal-first)', true);

    /* ── double-fire / ghost tap ───────────────────────────────────────── */
    const et = await centre(page, '#btn-end-turn');
    if (et && !(await page.evaluate(() => document.getElementById('btn-end-turn')?.disabled))) {
      const b = await sentCount();
      await h.tap(et.x, et.y, 25);
      await page.waitForTimeout(60);
      await h.tap(et.x, et.y, 25);
      await page.waitForTimeout(900);
      const sends = (await sentCount()) - b;
      if (sends <= 1) r.pass('a double-tap on END TURN sends at most one request');
      else r.fail(`a double-tap on END TURN sent ${sends} requests — no debounce (ghost/double-fire)`);
    }

    /* ── §C every surface a thumb can open ─────────────────────────────── */
    const surfaces = [
      ['help sheet', '#hud [data-action="help"]', '#sheet [data-action="close-sheet"]'],
      ['settings sheet', '#hud [data-action="settings"]', '#sheet [data-action="close-sheet"]'],
      ['emote sheet', '#btn-emote', '#sheet [data-action="close-sheet"]'],
      ['scoop confirm', '#btn-scoop', '#sheet [data-action="close-sheet"]'],
      // P8 round 2: the discard browser is opened by tapping the centre-table
      // pile — a primary on-table control that was in NO gate's selector list.
      ['discard browser', '[data-action="open-discard"]', '#sheet [data-action="close-sheet"]'],
      ['side panel', '#hud [data-action="toggle-side"]', '#side [data-action="toggle-side"]'],
    ];
    for (const [label, open, close] of surfaces) {
      const opened = await tapSel(open);
      if (!opened) { r.fail(`[${label}] no control to open it by touch`); continue; }
      await page.waitForTimeout(700);
      const visible = await page.evaluate(() => {
        const s = document.getElementById('sheet');
        const side = document.getElementById('side');
        return { sheet: s ? !s.hidden : false, side: side ? !side.hidden : false };
      });
      if (!visible.sheet && !visible.side) r.fail(`[${label}] tapping its control opened nothing`);
      await measureSurface(label);

      /* ── §F soft keyboard, only meaningful with the composer on screen ── */
      if (label === 'side panel') {
        await tapSel('#chat-input');
        await page.waitForTimeout(200);
        await page.evaluate(audit.shrinkViewportForKeyboard, KEYBOARD_PX);
        await page.waitForTimeout(600);
        const kb = await page.evaluate(audit.measureComposer, KEYBOARD_PX);
        if (!kb.input) r.fail('[§F] no #chat-input to measure against the keyboard');
        else if (kb.input.bottom > kb.line + 2) {
          r.fail(`[§F] chat composer sits ${Math.round(kb.input.bottom - kb.line)}px UNDER the software keyboard `
            + `(bottom ${kb.input.bottom}, keyboard line ${kb.line}) — §2 keeps visualViewport handling`);
        } else r.pass('chat composer stays above the software keyboard (visualViewport honored)');
        if (kb.send && kb.send.bottom > kb.line + 2) {
          r.fail(`[§F] the SEND button is ${Math.round(kb.send.bottom - kb.line)}px under the keyboard`);
        }
        await page.evaluate(audit.shrinkViewportForKeyboard, 0);
        await page.waitForTimeout(300);
      }

      await tapSel(close);
      await page.waitForTimeout(450);
      const stillOpen = await page.evaluate(() => {
        const s = document.getElementById('sheet');
        const side = document.getElementById('side');
        return (s && !s.hidden) || (side && !side.hidden);
      });
      if (stillOpen) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(350);
        const reallyStuck = await page.evaluate(() => {
          const s = document.getElementById('sheet');
          const side = document.getElementById('side');
          return (s && !s.hidden) || (side && !side.hidden);
        });
        if (reallyStuck) r.fail(`[${label}] cannot be dismissed by touch OR Escape — the thumb is trapped`);
        else r.fail(`[${label}] its close control does not respond to touch (Escape works)`);
      }
    }

    /* ── §G safe-area dead space ───────────────────────────────────────── */
    const dead = await page.evaluate(audit.auditDeadSpace);
    // Emulated Chromium reports zero insets, so an unexplained band is either a
    // double-counted env() or a hardcoded notch guess.
    if (dead.top > 24 || dead.bottom > 24) {
      r.fail(`[§G] ${dead.top}px dead at the top, ${dead.bottom}px at the bottom on a device with NO insets `
        + '— safe-area is being counted twice or hardcoded');
    } else r.pass(`no dead chrome band (${dead.top}px top, ${dead.bottom}px bottom)`);

    /* ── §H offline / reconnect UX ─────────────────────────────────────── */
    await h.setOffline(true).catch(() => {});
    await page.evaluate(() => { try { window.__CHUD_SOCKET_KILL = true; } catch {} });
    // Force the socket shut: emulateNetworkConditions does not tear down an
    // already-open WebSocket, and a client that only reacts to `close` would
    // otherwise look fine while being completely deaf.
    await h.cdp.send('Network.enable').catch(() => {});
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      // Nothing in the shipped client exposes the socket, so provoke the same
      // event the network does: the client's own close path.
      window.dispatchEvent(new Event('offline'));
    });
    await page.waitForTimeout(2500);
    const offline = await page.evaluate(() => {
      const conn = document.getElementById('hud-conn');
      const toast = document.getElementById('toast');
      const cs = conn ? getComputedStyle(conn) : null;
      return {
        connClass: conn?.className || '',
        connText: (conn?.textContent || '').trim(),
        connTitle: conn?.getAttribute('title') || '',
        connVisible: !!cs && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05,
        toast: (toast && !toast.hidden ? toast.textContent : '').trim(),
        online: navigator.onLine,
      };
    });
    const signalled = /off|down|lost|reconnect|retry|drop|bad|warn|is-/i.test(
      `${offline.connClass} ${offline.connText} ${offline.connTitle} ${offline.toast}`,
    );
    if (signalled && offline.connVisible) r.pass(`connection loss is shown to the player ${dim(offline.connClass || offline.toast)}`);
    else r.fail('[§H] the network went away and the UI says nothing — no visible reconnect affordance');
    await h.setOffline(false).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(2500);
    const recovered = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-card-id]').length,
      err: window.__CHUD.lastError ? String(window.__CHUD.lastError) : null,
      gameVisible: !document.getElementById('screen-game')?.hidden,
    }));
    if (recovered.gameVisible && recovered.cards > 0) r.pass('the table is still there after the network returns');
    else r.fail(`[§H] the client did not recover from an offline window (cards=${recovered.cards}, game=${recovered.gameVisible})`);
    if (recovered.err) r.fail(`__CHUD.lastError after reconnect: ${recovered.err}`);

    /* ── §E landscape ──────────────────────────────────────────────────── */
    await page.setViewportSize(LANDSCAPE);
    await page.waitForTimeout(900);
    const land = await page.evaluate(() => {
      const g = (id) => {
        const e = document.getElementById(id);
        if (!e) return null;
        const rc = e.getBoundingClientRect();
        return { w: Math.round(rc.width), h: Math.round(rc.height), top: Math.round(rc.top), bottom: Math.round(rc.bottom) };
      };
      return {
        self: g('self-board'), hand: g('zone-hand'), table: g('table'),
        opponents: g('opponents'), dock: g('hand-dock'),
        handCards: document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]').length,
        propCards: document.querySelectorAll('#self-board [data-card-id]').length,
        innerH: innerHeight,
      };
    });
    // A zone with no height is not "tight", it is gone. The player cannot see
    // their own board, which makes the game unplayable, not merely cramped.
    const MIN_ZONE = 44;
    for (const [key, min] of [['self', MIN_ZONE], ['hand', MIN_ZONE], ['table', 80], ['opponents', 40]]) {
      const z = land[key];
      if (!z) { r.fail(`[§E landscape] #${key} is missing entirely`); continue; }
      if (z.h < min) r.fail(`[§E landscape] ${key} is ${z.h}px tall at ${LANDSCAPE.width}×${LANDSCAPE.height} (needs ≥${min}) — unplayable`);
      else r.pass(`[landscape] ${key} ${z.w}×${z.h}`);
    }
    if (land.handCards === 0) r.fail('[§E landscape] no hand cards render at all');
    await measureSurface('landscape');
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(600);
  }


  /* ═══════════════ fixture-staged flows (payment, target, discard, win) ═ */
  /**
   * Stage a fixture from a KNOWN STARTING STATE and measure it before anything
   * is touched.
   *
   * The cold measurement is the point. Every §0.9 number this file reported for
   * a staged surface used to be taken after the surface had been interacted
   * with, and the client's layout is not idempotent across those two paths — the
   * hand fan measures [46,46,46,44,42,42,42,56] cold and
   * [47,48,48,46,44,44,44,56] warm, i.e. red and green. A gate must not inherit
   * whatever the previous stage happened to leave behind, so: fresh document,
   * storage cleared by the init script, state applied exactly once, settle by
   * geometry, measure. Interaction-driven measurements still happen afterwards
   * and are labelled separately.
   */
  const stage = async (name, { cold = true } = {}) => {
    const state = fixture(name);
    if (!state) { r.fail(`fixture ${name}.json missing — run npm run tool:record`); stagesFailed.push(name); return false; }
    /* §H leaves CDP network emulation behind on some runs, and a later stage
     * then dies on ERR_CONNECTION_REFUSED — one aborted run in four. Clearing
     * the emulation and retrying once distinguishes "the harness left the wire
     * cut" from "the server is genuinely gone": the second failure is still
     * reported and still fails the gate. */
    const goStage = () => page.goto(`${server.url}/?harness=1&seed=${seed}&stage=${name}`, { waitUntil: 'load' });
    try {
      await goStage();
    } catch (e) {
      await h.setOffline(false).catch(() => {});
      await page.waitForTimeout(300);
      try {
        await goStage();
        r.warn(`stage ${name}: first navigation failed (${e.message.split('\n')[0]}), succeeded on retry`);
      } catch (e2) {
        /* Say WHICH side died. A Node-side fetch does not go through the page's
         * CDP network emulation, so this separates "§H left the wire cut in the
         * browser" from "the server process is gone" — one aborted run in four
         * looked identical from inside the page and they need different fixes. */
        const alive = await fetch(server.url, { method: 'GET' })
          .then((res) => `server answered ${res.status}`)
          .catch((err) => `server is down (${err.cause?.code || err.message})`);
        r.fail(`stage ${name}: navigation failed — ${e2.message.split('\n')[0]}; ${alive}`
          + (server.died !== null ? `; server.js exited ${server.died}` : ''));
        if (server.died !== null && !stagesFailed.length) {
          // Print it ONCE, on the first stage that noticed: the reason the
          // server went away is in its own log and nowhere else.
          for (const l of server.logs().trim().split('\n').slice(-8)) r.info(l);
        }
        stagesFailed.push(name);
        return false;
      }
    }
    const b = await waitForBridge(page, BRIDGE_MS);
    if (!b.ok) { r.fail(`stage ${name}: the bridge never appeared in ${b.ms}ms`); return false; }
    await page.evaluate((s) => { window.__CHUD.applyState(s); window.__CHUD.drainEvents?.(); }, state);
    if (cold) await measureSurface(`${name} (cold)`);
    return true;
  };

  /* ── payment by touch, and §D occlusion of the confirm bar ───────────── */
  if (await stage('payment-pending')) {
    await tapSel('[data-action="begin-payment"]');
    await page.waitForTimeout(300);
    const payable = await page.evaluate(
      () => document.querySelectorAll('[data-payable="1"], [data-zone="bank"] [data-card-id]').length,
    );
    if (!payable) r.fail('payment: nothing is selectable to pay with');
    for (let i = 0; i < Math.min(payable, 4); i++) {
      await tapSel('[data-payable="1"], [data-zone="bank"] [data-card-id]', i);
      await page.waitForTimeout(140);
    }
    const occ = await page.evaluate(audit.auditOcclusion);
    if (occ.length) {
      r.fail(`[§D] ${occ.length} primary CTA(s) covered by a pointer-events:none layer`);
      for (const o of occ) r.info(`"${o.cta}" ${o.pct}% covered by ${o.by}`);
    } else r.pass('no decorative layer covers a primary CTA during payment (§D)');
    const before = await sentCount();
    await tapSel('[data-action="confirm-payment"]');
    await page.waitForTimeout(600);
    if ((await sentCount()) > before) r.pass('payment confirmed by a real finger tap');
    else r.fail('CONFIRM PAYMENT did not respond to a real touch');
    await measureSurface('payment');
  }

  /* ── targeting is a CLIENT-SIDE mode: it has to be driven, not staged ── */
  if (await stage('targeting')) {
    const entered = await page.evaluate(async () => {
      const hand = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
      for (const card of hand) {
        window.__CHUD_TAPPING = card.dataset.cardId;
        card.click();
        await new Promise((res) => setTimeout(res, 120));
        const play = document.querySelector('[data-action="play-card"]:not([disabled])');
        if (play) { play.click(); await new Promise((res) => setTimeout(res, 200)); }
        if (window.__CHUD.mode?.kind === 'target') return window.__CHUD.mode.needs?.[0] || 'target';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((res) => setTimeout(res, 80));
      }
      return null;
    });
    if (!entered) {
      r.fail('targeting: no card in the staged hand can enter target mode — the fixture cannot show targeting');
    } else {
      const glow = await page.evaluate(
        () => document.querySelectorAll('[data-targetable="1"], .is-targetable, [data-droppable="1"]').length,
      );
      if (!glow) r.fail(`targeting: mode is '${entered}' but nothing on the table is marked targetable`);
      else r.pass(`targeting mode entered (needs ${entered}); ${glow} target(s) marked`);
      const t = await centre(page, '[data-targetable="1"], .is-targetable', 0);
      if (t) {
        const before = await sentCount();
        // Choosing a target is not always the last step (rent picks a player
        // AND a colour), so "did it work" is: a request went out, OR the mode
        // moved on, OR the pick was recorded. Only "nothing at all changed"
        // is the dead-touch defect.
        const modeBefore = await page.evaluate(() => JSON.stringify(window.__CHUD.mode));
        await h.tap(t.x, t.y);
        await page.waitForTimeout(600);
        const modeAfter = await page.evaluate(() => JSON.stringify(window.__CHUD.mode));
        if ((await sentCount()) > before || modeAfter !== modeBefore) {
          r.pass(`a real tap on a glowing target advanced the choice ${dim(`→ ${await modeKind()}`)}`);
        } else r.fail('tapping a glowing target with a real finger changed nothing — the on-table target is dead to touch');
      }
      await measureSurface('targeting');
    }
  }

  /* ── discard-to-limit ─────────────────────────────────────────────────── */
  if (await stage('discard-limit')) {
    await tapSel('#btn-end-turn');
    await page.waitForTimeout(400);
    const k = await modeKind();
    if (k !== 'discard') r.fail(`discard: END TURN over the hand limit put us in '${k}', not discard mode`);
    else {
      r.pass('over the hand limit, END TURN opens discard selection');
      await measureSurface('discard');
      const occ = await page.evaluate(audit.auditOcclusion);
      if (occ.length) {
        r.fail(`[§D] ${occ.length} CTA(s) covered during discard`);
        for (const o of occ) r.info(`"${o.cta}" ${o.pct}% covered by ${o.by}`);
      }
    }
  }

  /* ── §E landscape at FIVE players ──────────────────────────────────────
   * Landscape was measured once, in whatever seat count the live game happened
   * to have (3), and only as four zone heights. Five opponents is where the
   * boards get pushed into a scroller — and the clipped-control check in the
   * verdict below is the thing that can see that. */
  await page.setViewportSize(LANDSCAPE);
  if (await stage('five-player', { cold: false })) {
    await measureSurface('landscape · five players (cold)');
  }
  await page.setViewportSize(PHONE);

  /* ── win overlay ──────────────────────────────────────────────────────── */
  if (await stage('finished')) {
    const shown = await page.evaluate(() => {
      const w = document.getElementById('win-overlay');
      return w ? !w.hidden : false;
    });
    if (!shown) r.fail('win: the finished fixture does not raise #win-overlay');
    else r.pass('win overlay is up');
    await measureSurface('win overlay');
  }

  /* ═══════════════ verdict over every surface measured ══════════════════ */
  if (stagesFailed.length) {
    r.fail(`${stagesFailed.length} staged surface(s) were never measured (${stagesFailed.join(', ')}) `
      + '— every "all surfaces" verdict below is over an incomplete set and must not be read as green');
  }
  const complete = stagesFailed.length === 0;
  /** A summary may only report success when it saw everything it claims to cover. */
  const summary = (ok, msg) => (ok && complete ? r.pass(msg) : (ok ? r.info(`${msg} (incomplete set)`) : null));

  const smalls = surfaceIssues.filter((s) => s.small.length);
  if (smalls.length) {
    // Distinct signatures, not raw hits: one 20px .propcol repeated across ten
    // set columns and eleven surfaces is ONE defect, and a count of 101 reads
    // like a wall of noise nobody fixes.
    const total = new Set(surfaceIssues.flatMap((s) => s.small)).size;
    r.fail(`${total} distinct tap target(s) under 44px across ${smalls.length} surface(s) (§0.9, §B)`);
    for (const s of smalls) {
      r.info(`${s.label}: ${[...new Set(s.small)].slice(0, 8).join(', ')}`);
    }
  } else summary(true, `tap targets ≥ 44px on all ${surfaceIssues.length} measured surfaces`);

  const zoneHits = new Set(surfaceIssues.flatMap((s) => s.zones || []));
  if (zoneHits.size) {
    r.fail(`${zoneHits.size} distinct card zone(s) under 44px — §5 says tapping any zone zooms it, `
      + 'so a zone thinner than a thumb hides the data it is supposed to reveal');
    r.info([...zoneHits].slice(0, 10).join(', '));
  } else summary(true, 'every card zone is at least 44px');

  const offs = surfaceIssues.filter((s) => s.off.length);
  if (offs.length) {
    r.fail(`interactive elements outside the viewport on ${offs.length} surface(s)`);
    for (const s of offs) r.info(`${s.label}: ${s.off.slice(0, 5).join(', ')}`);
  } else summary(true, 'every interactive element is on-screen on every surface');

  /* The other half of "on-screen": inside the viewport but scrolled out of its
   * own overflow container, which the viewport test cannot see. */
  const clips = surfaceIssues.filter((s) => (s.clipped || []).length);
  if (clips.length) {
    const total = new Set(surfaceIssues.flatMap((s) => s.clipped || [])).size;
    r.fail(`${total} distinct control(s) clipped by a scrolling ancestor across ${clips.length} surface(s) `
      + '— on-screen and still unreachable');
    for (const s of clips) r.info(`${s.label}: ${[...new Set(s.clipped)].slice(0, 5).join(', ')}`);
  } else summary(true, 'no control is clipped away by an overflow container');

  const occAll = surfaceIssues.filter((s) => s.occ.length);
  if (occAll.length) {
    r.fail(`CTAs occluded by decorative layers on ${occAll.length} surface(s) (§D)`);
    for (const s of occAll) r.info(`${s.label}: ${s.occ.map((o) => `"${o.cta}" ${o.pct}% by ${o.by}`).join('; ')}`);
  }

  const advisories = surfaceIssues.flatMap((s) => s.advisory);
  if (advisories.length) {
    r.warn(`${advisories.length} sub-44px card node(s) that are zoom affordances, not controls (advisory, §5)`);
  }

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s) on phone`);
    for (const e of h.errors.slice(0, 6)) console.log(red(`      ${e}`));
  } else r.pass('no console errors on phone');

  /* ═══ --prove: §D and §0.9 must be able to go red (§8) ══════════════════
   * §D passed every round while being structurally unable to fail (see the
   * header). An assertion nobody has seen fail is a decoration, so this injects
   * the exact defect it exists to catch — a pointer-events:none veil laid over
   * the primary action — and requires the verdict to flip.                    */
  if (args.prove) {
    console.log(dim('\n  ── --prove: the same assertions against injected defects ──'));
    await stage('payment-pending', { cold: false });
    await settleLayout(page);

    /* Half one: with a veil actually over a CTA, the verdict must flip. */
    const clean = await page.evaluate(audit.auditOcclusion);
    const injected = await page.evaluate(() => {
      const vis = (el) => {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
        for (let p = el; p; p = p.parentElement) if (p.hasAttribute?.('hidden')) return false;
        const r2 = el.getBoundingClientRect();
        return r2.width > 20 && r2.height > 20 && r2.top < innerHeight && r2.bottom > 0;
      };
      const cta = [...document.querySelectorAll(
        '[data-action]:not([disabled]), #prompt button, #hand-dock button, .btn-primary',
      )].filter(vis)[0];
      if (!cta) return null;
      const r2 = cta.getBoundingClientRect();
      const veil = document.createElement('div');
      veil.className = 'hint-card';
      veil.textContent = 'injected coach bubble';
      Object.assign(veil.style, {
        position: 'fixed', left: `${r2.left - 4}px`, top: `${r2.top - 4}px`,
        width: `${r2.width + 8}px`, height: `${r2.height + 8}px`,
        background: '#888', pointerEvents: 'none', zIndex: '9999',
        // `.hint-card` ships `opacity: 0` and animates in via `.is-in`, so the
        // first version of this injection produced an INVISIBLE veil and the
        // demonstration failed for a reason that had nothing to do with §D.
        opacity: '1', visibility: 'visible',
      });
      document.body.appendChild(veil);
      return (cta.textContent || cta.dataset.action || cta.id || 'button').trim().slice(0, 24);
    });
    await page.waitForTimeout(120);
    const veiled = await page.evaluate(audit.auditOcclusion);
    if (!injected) {
      r.fail('--prove §D: no visible CTA on the staged surface to cover — the demonstration cannot run');
    } else if (veiled.length > clean.length) {
      r.pass(`--prove §D: covering "${injected}" took the verdict ${clean.length} → ${veiled.length} `
        + dim(`("${veiled[0].cta}" ${veiled[0].pct}% by ${veiled[0].by})`));
    } else {
      r.fail(`--prove §D: covering "${injected}" left the verdict at ${veiled.length} — §D cannot `
        + 'distinguish a covered CTA from an uncovered one, so its green is a decoration');
    }

    /* Half two: prove the STORAGE half, which is what made §D unfalsifiable.
     *
     * A/B on the one variable: a freshly staged surface builds coach nodes,
     * and the same surface with `chud_hints_v1` pre-seeded as "all seen" builds
     * none. That second state is exactly what every stage inherited before this
     * run cleared storage — the layer §D exists to catch could not be created,
     * so §D was green by construction. The seeding init script is added AFTER
     * the pristine one and therefore wins; --prove is the end of the run.     */
    const countHints = () => page.evaluate(
      () => document.querySelectorAll('.hints .hint-card, .hint-card').length,
    );
    const withPristine = await countHints();
    await h.context.addInitScript(() => {
      try {
        localStorage.setItem('chud_hints_v1',
          JSON.stringify(['peek', 'drag', 'pay', 'play', 'bank', 'discard', 'target', 'end']));
      } catch { /* private mode */ }
    });
    await stage('payment-pending', { cold: false });
    await settleLayout(page);
    const withSpent = await countHints();
    if (withPristine > 0 && withSpent === 0) {
      r.pass(`--prove: the coach layer is storage-gated — ${withPristine} node(s) on pristine storage, `
        + `${withSpent} once the once-ever keys are spent. Not clearing storage is what made §D unfalsifiable.`);
    } else {
      r.fail(`--prove: pristine ${withPristine} hint node(s) vs spent ${withSpent} — the storage fix `
        + 'cannot be shown to change what §D is able to see');
    }
  }

  await h.close();

  /* ═══ ART §2 ships TWO appearances; this file measured one ══════════════
   * `openTouchPage` hardcoded `colorScheme: 'dark'`, so the light theme had no
   * mobile gate at all. A full second pass would double a slow gate for little
   * return — light and dark are geometrically identical in this build, which is
   * a claim worth CHECKING rather than assuming, so the light pass is cold
   * measurements only (tap targets, occlusion, clipping) over the surfaces most
   * likely to differ, and any divergence from the dark numbers is reported.  */
  {
    const lh = await openTouchPage(browser, `${server.url}/?harness=1&seed=${seed}`, { colorScheme: 'light' });
    const lb = await waitForBridge(lh.page, BRIDGE_MS);
    if (!lb.ok) r.fail('light-theme pass: the bridge never appeared');
    else {
      for (const name of ['mid-game', 'discard-limit', 'five-player']) {
        const state = fixture(name);
        if (!state) continue;
        await lh.page.goto(`${server.url}/?harness=1&seed=${seed}&stage=${name}&theme=light`, { waitUntil: 'load' });
        if (!(await waitForBridge(lh.page, BRIDGE_MS)).ok) continue;
        await lh.page.evaluate((s) => { window.__CHUD.applyState(s); window.__CHUD.drainEvents?.(); }, state);
        await settleLayout(lh.page);
        const t = await lh.page.evaluate(audit.auditTapTargets);
        const occ = await lh.page.evaluate(audit.auditOcclusion);
        surfaceIssues.push({
          label: `${name} (cold, light)`, small: t.fatal, zones: t.zones, advisory: t.advisory,
          off: t.offscreen, clipped: t.clipped, occ, dup: [], t,
        });
      }
      const dk = (n) => surfaceIssues.find((s) => s.label === `${n} (cold)`);
      let diverged = 0;
      for (const name of ['mid-game', 'discard-limit', 'five-player']) {
        const a = dk(name);
        const b = surfaceIssues.find((s) => s.label === `${name} (cold, light)`);
        if (!a || !b) continue;
        if (a.small.join('|') !== b.small.join('|')) {
          diverged++;
          r.fail(`[${name}] the light theme has DIFFERENT tap targets from dark — `
            + `${a.small.length} under 44px in dark, ${b.small.length} in light`);
        }
      }
      if (!diverged) r.pass('light and dark are geometrically identical on the surfaces measured');
      if (lh.errors.length) r.fail(`${lh.errors.length} console/page error(s) in the light theme`);
    }
    await lh.close();
  }

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
