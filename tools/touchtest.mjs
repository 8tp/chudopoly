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
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR, PHONE, PHONE_DPR, LANDSCAPE, SEED, parseArgs, launchBrowser,
  reporter, readJSON, green, red, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { openTouchPage, centre, KEYBOARD_PX } from './lib/touch.mjs';
import * as audit from './lib/audit.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

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

  const bridged = await page.waitForFunction(() => !!window.__CHUD, null, { timeout: 8000 })
    .then(() => true).catch(() => false);
  if (!bridged) {
    console.log('  PENDING CLIENT — window.__CHUD absent with ?harness=1');
    await h.close(); await browser.close(); await server.stop();
    process.exit(2);
  }
  await page.evaluate(() => window.__CHUD.ready).catch(() => {});
  r.pass('booted on an emulated iPhone with a real touchscreen');

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
  async function measureSurface(label) {
    const t = await page.evaluate(audit.auditTapTargets);
    const occ = await page.evaluate(audit.auditOcclusion);
    const dup = await page.evaluate(audit.auditDuplicateCTAs);
    const rec = { label, small: t.fatal, zones: t.zones, advisory: t.advisory, off: t.offscreen, occ, dup, t };
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
  const stage = async (name) => {
    const state = fixture(name);
    if (!state) { r.fail(`fixture ${name}.json missing — run npm run tool:record`); return false; }
    await page.goto(`${server.url}/?harness=1&seed=${seed}&stage=${name}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__CHUD, null, { timeout: 8000 });
    await page.evaluate(() => window.__CHUD.ready).catch(() => {});
    await page.evaluate((s) => { window.__CHUD.applyState(s); window.__CHUD.drainEvents?.(); }, state);
    await page.waitForTimeout(300);
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
  } else r.pass(`tap targets ≥ 44px on all ${surfaceIssues.length} measured surfaces`);

  const zoneHits = new Set(surfaceIssues.flatMap((s) => s.zones || []));
  if (zoneHits.size) {
    r.fail(`${zoneHits.size} distinct card zone(s) under 44px — §5 says tapping any zone zooms it, `
      + 'so a zone thinner than a thumb hides the data it is supposed to reveal');
    r.info([...zoneHits].slice(0, 10).join(', '));
  } else r.pass('every card zone is at least 44px');

  const offs = surfaceIssues.filter((s) => s.off.length);
  if (offs.length) {
    r.fail(`interactive elements outside the viewport on ${offs.length} surface(s)`);
    for (const s of offs) r.info(`${s.label}: ${s.off.slice(0, 5).join(', ')}`);
  } else r.pass('every interactive element is on-screen on every surface');

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
