import { touchDriver } from './touch.mjs';

/**
 * tools/lib/drivers.mjs — the "a fixture is a state PLUS a gesture" library.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Lifted out of screenshot.mjs in P8 because a second gate needs the same
 * surfaces: checkContrast.mjs must measure text on the discard browser, the
 * help sheet and the win recap, and those are CLIENT modes — no recorded server
 * snapshot can encode them. Two tools driving the same moment two different
 * ways is how screenshot and touchtest silently disagreed in round 1.
 *
 * Two kinds of driver:
 *
 *   DRIVERS[name]      a self-contained async function handed to page.evaluate.
 *                      No closures, no imports — it is serialised to the page.
 *   HOST[name]         runs in NODE with the Playwright `page`, for gestures
 *                      that must enter the browser's real input pipeline and
 *                      then be HELD while the frame is captured (`drag-mid`).
 *
 * Every driver returns a STRING describing what it reached. The caller compares
 * it to the shot's `expect` prefix and fails the shot if it does not match — a
 * driver that silently degrades to "whatever the fixture looked like" is the
 * exact round-1 targeting lie (two names, one picture).
 */

/** Set by a host driver that leaves a finger down; lifted by releaseInput. */
let heldTouch = null;

export const DRIVERS = {
  /** Tap hand cards until one enters target mode, then stop and hold it. */
  targeting: async () => {
    const hand = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    for (const card of hand) {
      card.click();
      await new Promise((r) => setTimeout(r, 80));
      const play = document.querySelector('[data-action="play-card"]:not([disabled])');
      if (play) { play.click(); await new Promise((r) => setTimeout(r, 140)); }
      if (window.__CHUD.mode?.kind === 'target') {
        return `target:${window.__CHUD.mode.needs?.[0] || '?'}`;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    return `stuck:${window.__CHUD.mode?.kind || 'none'}`;
  },

  /** Open payment selection and select cards, so the confirm bar is live. */
  payment: async () => {
    const begin = document.querySelector('[data-action="begin-payment"]');
    if (begin) { begin.click(); await new Promise((r) => setTimeout(r, 180)); }
    const cards = [...document.querySelectorAll('[data-payable="1"], [data-zone="bank"] [data-card-id]')];
    for (const c of cards.slice(0, 3)) { c.click(); await new Promise((r) => setTimeout(r, 60)); }
    return `mode:${window.__CHUD.mode?.kind || 'none'}`;
  },

  /** End turn over the hand limit → discard picker, one card marked. */
  'discard-limit': async () => {
    const et = document.getElementById('btn-end-turn');
    if (et) { et.click(); await new Promise((r) => setTimeout(r, 220)); }
    const cards = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    if (window.__CHUD.mode?.kind === 'discard' && cards[0]) {
      cards[0].click(); await new Promise((r) => setTimeout(r, 80));
    }
    return `mode:${window.__CHUD.mode?.kind || 'none'}`;
  },

  /**
   * §P8's discard-to-limit READY state, which nothing looked at: the count chip
   * reading n/n, the confirm carrying `.is-ready` rather than `.is-refusing`,
   * and every doomed card struck through (`.card.is-discarding`). The one-tap
   * default ("Cheapest n") is the path most players will take, so it is the
   * path the review set shows.
   */
  'discard-ready': async () => {
    const et = document.getElementById('btn-end-turn');
    if (et) { et.click(); await new Promise((r) => setTimeout(r, 240)); }
    if (window.__CHUD.mode?.kind !== 'discard') return `mode:${window.__CHUD.mode?.kind || 'none'}`;
    const isReady = () => !!document.querySelector('[data-action="confirm-discard"].is-ready');
    const auto = document.querySelector('[data-action="discard-cheapest"]');
    if (auto) { auto.click(); await new Promise((r) => setTimeout(r, 200)); }
    // Fall back to tapping cards if the one-tap default is absent or short.
    // The stop condition is the CONFIRM'S OWN STATE, not a count read off the
    // bridge: `mode.excess` is not part of the §9 contract, and a driver that
    // waits on a field that is always `undefined` never loops and never says so.
    for (let guard = 0; guard < 12 && !isReady(); guard++) {
      const next = [...document.querySelectorAll('#zone-hand [data-card-id]')]
        .find((c) => !c.classList.contains('is-discarding'));
      if (!next) break;
      next.click();
      await new Promise((r) => setTimeout(r, 90));
    }
    const ready = isReady();
    const struck = document.querySelectorAll('.card.is-discarding').length;
    const chip = document.querySelector('#prompt .chip.total')?.textContent?.trim() || '';
    if (!ready) return `notready:struck=${struck} chip="${chip}"`;
    return `ready:${struck} struck, chip "${chip}"`;
  },

  settings: async () => {
    document.querySelector('#hud [data-action="settings"]')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  emote: async () => {
    document.getElementById('btn-emote')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  side: async () => {
    document.querySelector('#hud [data-action="toggle-side"]')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('side')?.hidden === false ? 'side:open' : 'side:closed';
  },

  help: async () => {
    document.querySelector('#hud [data-action="help"], [data-action="help"]')?.click();
    await new Promise((r) => setTimeout(r, 360));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  /* ── P8 surfaces that shipped with no shot at all ──────────────────────── */

  /**
   * ui/discard.js turns the centre-table pile into a control. Requested by the
   * UI agent, which had captured this by hand rather than editing tools/.
   */
  discard: async () => {
    document.querySelector('[data-action="open-discard"]')?.click();
    await new Promise((r) => setTimeout(r, 340));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  /** The same sheet, second tab: "What's left" — the deck census. */
  'discard-census': async () => {
    document.querySelector('[data-action="open-discard"]')?.click();
    await new Promise((r) => setTimeout(r, 340));
    document.querySelector('[data-action="discard-panel"][data-panel="left"]')?.click();
    await new Promise((r) => setTimeout(r, 220));
    const open = document.getElementById('sheet')?.hidden === false;
    const on = document.querySelector('[data-action="discard-panel"][data-panel="left"].is-on');
    if (!open) return 'sheet:closed';
    return on ? 'sheet:open census' : 'sheet:open pile-tab-still-selected';
  },

  /**
   * ui/journal.js's full Mission Log. The door lives in the side drawer's head,
   * which is `hidden` until the drawer is open, so the drawer is opened first —
   * a click routed from inside a `hidden` ancestor is not a click a player can
   * make, and a driver that takes one is lying about reachability.
   */
  log: async () => {
    const reachable = () => [...document.querySelectorAll('[data-action="open-log"]')]
      .find((b) => b.getBoundingClientRect().height > 0);
    if (!reachable()) {
      document.querySelector('#hud [data-action="toggle-side"]')?.click();
      await new Promise((r) => setTimeout(r, 320));
    }
    const btn = reachable();
    if (!btn) return 'sheet:closed no-open-log-control';
    btn.click();
    await new Promise((r) => setTimeout(r, 360));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  /**
   * §P7.3's out-loud refusal: "NOT disabled. A disabled button is the deadest
   * possible refusal — no shake, no cue, no haptic, no sentence."
   *
   * The transient half (`.is-refused`, a 420ms shake) is deliberately not what
   * this captures — a shot of a 420ms animation is a shot of whenever the
   * shutter happened to fall. The PERSISTENT half is: select a card whose play
   * is blocked and the strip's primary carries `.is-refusing` plus the sentence
   * in its `title`. That state holds until the player does something else, so
   * it is a picture rather than a stopwatch.
   */
  refusal: async () => {
    const hand = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    for (const card of hand) {
      card.click();
      await new Promise((r) => setTimeout(r, 120));
      const btn = document.querySelector('[data-action="play-card"].is-refusing, '
        + '[data-action="bank-card"].is-refusing');
      if (btn) return `refusing:${(btn.getAttribute('title') || '').slice(0, 60)}`;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    return `norefusal:${hand.length} card(s) tried, mode ${window.__CHUD.mode?.kind || 'none'}`;
  },

  /**
   * The win overlay's §P8 "HOW IT WENT" recap. It sits below the fold of a
   * capped `.win-box` at five players, so it is scrolled into view — the review
   * set exists to show the thing, not to prove it is in the DOM.
   */
  'win-recap': async () => {
    const overlay = document.getElementById('win-overlay');
    if (!overlay || overlay.hidden) return 'recap:no-win-overlay';
    const box = overlay.querySelector('.jr-recap');
    if (!box) return 'recap:absent';
    box.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 240));
    const beats = box.querySelectorAll('.jr-list.is-recap > *').length;
    const r = box.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight) return `recap:offscreen ${beats}`;
    return `recap:${beats} beat${beats === 1 ? '' : 's'}`;
  },
};

/* ────────────────────────── host-side (real input) ─────────────────────── */

/**
 * ART §5's six drop affordances, all of which only exist DURING a drag:
 * legal mats ringed, illegal mats desaturated, the landing ghost in the hovered
 * column, the hand retracted. Nothing in the review set had ever seen them,
 * because a screenshot is taken between gestures and a drag is the gesture.
 *
 * So this one starts a real drag through the browser's input pipeline
 * (`page.mouse`, i.e. CDP `Input.dispatchMouseEvent` — pointer events created in
 * page script never consult `touch-action`, see lib/touch.mjs) and DOES NOT
 * RELEASE. The caller screenshots while the button is still down.
 *
 * It asserts on the interaction layer's own state — `.is-held`,
 * `body.is-dragging-card`, `[data-droppable]`, `.drop-ghost` — never on
 * elapsed time. interact/pointer.js takes a drag at 8px of travel
 * (pointer.js:36 SLOP); the path below crosses that in the first two moves and
 * then walks to whatever the client itself marked droppable, so the shot cannot
 * drift out of agreement with the client's own rules.
 */
export const HOST = {
  /**
   * ART §8's peek — "reading a card costs zero taps". It only exists while the
   * pointer is over a card (hover open 140ms, close delay 160ms), so like
   * `drag-mid` it must be held open across the shutter and cannot be reached
   * from page script.
   *
   * `where: 'hand' | 'board'` picks which card is read; the board case is the
   * one that proves the peek works on cards you do not own.
   */
  peek: async (page, where = 'hand') => {
    const sel = where === 'board'
      ? '#opponents [data-card-id], #self-board [data-card-id]'
      : '#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]';
    const at = await page.evaluate((s) => {
      const cards = [...document.querySelectorAll(s)];
      const c = cards[Math.floor(cards.length / 2)] || cards[0];
      if (!c) return null;
      const r = c.getBoundingClientRect();
      // Upper half: a fanned card's lower half is covered by its neighbour.
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.3 };
    }, sel);
    if (!at) return `peek:no-card (${where})`;
    await page.mouse.move(at.x - 30, at.y + 40);
    await page.mouse.move(at.x, at.y);
    await page.mouse.move(at.x + 1, at.y);
    // 140ms hover-open + a frame to paint. Asserted on `.peek`, not on this.
    await page.waitForTimeout(420);
    return page.evaluate(() => {
      const p = document.querySelector('.peek');
      if (!p) return 'peek:absent';
      const name = p.querySelector('.peek-name')?.textContent?.trim() || '';
      const r = p.getBoundingClientRect();
      if (!r.width || !r.height) return 'peek:zero-size';
      return `peek:open "${name}" ${Math.round(r.width)}×${Math.round(r.height)}`;
    });
  },

  'peek-board': (page) => HOST.peek(page, 'board'),

  /**
   * The same peek, on a phone, where it is a 300ms TOUCH HOLD and not a hover
   * (ART §8: "Touch hold 300ms … a peek is free and dismisses on release", and
   * content.css gates the hover path behind `@media (hover:hover)`). Measured:
   * driving it with `page.mouse` on a mobile context returns `peek:absent`,
   * which is the correct answer to the wrong gesture.
   *
   * Real touch, through CDP, for the reason lib/touch.mjs documents at length:
   * pointer events synthesised in page script never enter the input pipeline.
   * The finger stays DOWN — the peek dismisses on release — so `releaseInput`
   * lifts it after the shutter.
   */
  'peek-hold': async (page) => {
    const at = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
      const c = cards[Math.floor(cards.length / 2)] || cards[0];
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.3) };
    });
    if (!at) return 'peek:no-card';
    const cdp = await page.context().newCDPSession(page);
    const { rawTouch, touchPoint } = touchDriver(cdp);
    await rawTouch('touchStart', [touchPoint(at.x, at.y)]);
    heldTouch = rawTouch;
    await page.waitForTimeout(560);           // 300ms hold + open + paint
    return page.evaluate(() => {
      const p = document.querySelector('.peek');
      if (!p) return 'peek:absent';
      const name = p.querySelector('.peek-name')?.textContent?.trim() || '';
      const r = p.getBoundingClientRect();
      if (!r.width || !r.height) return 'peek:zero-size';
      return `peek:open "${name}" ${Math.round(r.width)}×${Math.round(r.height)}`;
    });
  },

  'drag-mid': async (page) => {
    const from = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
      const c = cards[Math.floor(cards.length / 2)] || cards[0];
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: c.dataset.cardId };
    });
    if (!from) return 'drag:no-hand-card';

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Past SLOP (8px) in two steps, then a slow lift so the follow loop has
    // real velocity to lean the card with (ART §4 drag tilt).
    for (const dy of [6, 14, 34, 64]) {
      await page.mouse.move(from.x + 4, from.y - dy);
      await page.waitForTimeout(24);
    }

    // interact/drag.js only draws the landing silhouette over a RANK-0 target
    // (drag.js placeGhost: "a ghost inside #table would be a dashed card in the
    // middle of the felt promising a place the card is not going"). Rank is not
    // in the DOM, so the driver walks the precise targets — `.propcol` first —
    // until the client itself draws the ghost. Measured: aiming at the first
    // `[data-droppable="1"]` in document order got a ghost on the phone and not
    // on the desktop, where the first match is the wider region.
    const candidates = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-droppable="1"]')];
      const rank = (e) => (e.classList.contains('propcol') ? 0 : e.matches('.cardzone, [data-zone]') ? 1 : 2);
      return els
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 8 && r.height > 8)
        .sort((a, b) => rank(a.e) - rank(b.e))
        .slice(0, 4)
        .map(({ r }) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
    });

    let cursor = { x: from.x + 4, y: from.y - 64 };
    for (const target of candidates) {
      // Walk in, don't teleport: the hover/ghost state is driven by moves.
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(
          cursor.x + ((target.x - cursor.x) * i) / 6,
          cursor.y + ((target.y - cursor.y) * i) / 6,
        );
        await page.waitForTimeout(20);
      }
      await page.mouse.move(target.x, target.y);
      await page.waitForTimeout(110);
      cursor = target;
      if (await page.evaluate(() => !!document.querySelector('.drop-ghost'))) break;
    }

    return page.evaluate(() => {
      const held = document.querySelectorAll('.card.is-held, .card.is-dragging').length;
      const legal = document.querySelectorAll('[data-droppable="1"]').length;
      const illegal = document.querySelectorAll('[data-drop-illegal="1"]').length;
      const ghost = document.querySelectorAll('.drop-ghost').length;
      const body = document.body.classList.contains('is-dragging-card');
      const detail = `held=${held} legal=${legal} illegal=${illegal} ghost=${ghost} body=${body}`;
      // The four things the shot is ABOUT. Any of them missing and the picture
      // shows a table with a card floating over it, which is not the moment.
      if (!body || !held || !legal || !ghost) return `drag:incomplete ${detail}`;
      return `drag:held ${detail}`;
    });
  },
};

/** Run whichever kind of driver `name` is. Returns the reached string. */
export async function drive(page, name) {
  if (HOST[name]) return HOST[name](page);
  if (!DRIVERS[name]) return `driver:unknown '${name}'`;
  return page.evaluate(DRIVERS[name]);
}

/** Drop anything a host driver is still holding. Safe to call unconditionally. */
export async function releaseInput(page) {
  await page.mouse.up().catch(() => {});
  if (heldTouch) {
    const end = heldTouch;
    heldTouch = null;
    await end('touchEnd', []).catch(() => {});
  }
}
