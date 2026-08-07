/**
 * tools/lib/audit.mjs — page-side measurement functions.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Every export here is a SELF-CONTAINED function meant to be handed to
 * `page.evaluate` — no module-scope closures, no imports at call time. They are
 * in one file so touchtest and screenshot measure the same things the same way
 * (P7 round 1: they did not, and the two gates disagreed silently).
 *
 * Each function documents the round-1 critic finding it exists to catch.
 */

/* ────────────────────────────── tap targets ────────────────────────────── */

/**
 * §0.9: tap targets ≥ 44px.
 *
 * ROUND-1 GAP: the old audit selected `button, [role=button], [data-action]`
 * only. That excluded `.propcol` — the PRIMARY on-table targeting surface,
 * measured at 20px wide by the mobile critic — plus every `[data-card-id]`
 * hand strip (39–44px), every `input`, and every `select`. Nine assertions
 * passed while the three surfaces a thumb actually lands on went unmeasured.
 *
 * Two extra refinements over a naive rect check:
 *   • Hand cards are FANNED, so a card's rect is not its touchable area. The
 *     exposed strip (distance to the next overlapping sibling) is what a thumb
 *     gets, and that is what is measured.
 *   • Card nodes on boards are zoom affordances, not required controls (§5 says
 *     tapping the ZONE zooms), so they are reported as advisory, not fatal.
 */
export function auditTapTargets() {
  const MIN = 44;
  /**
   * P8 round 2 GAP (mobile critic): this used to drop any element with
   * `opacity: 0`, and the 44×23 settings switches passed because of it. The
   * pattern is the standard one — a visually-hidden `<input>` laid over a styled
   * track — so the element with `opacity: 0` IS the hit target, and refusing to
   * measure it means refusing to measure the control.
   *
   * An element's OWN transparency is therefore allowed, as long as it still
   * takes pointer events. An ANCESTOR at opacity 0 is different: the whole
   * subtree is invisible, which is a closed/faded surface, not a control.
   */
  const vis = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (st.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    // Off-screen surfaces (a closed sheet translated away) are not on trial here.
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      if (Number(ps.opacity) === 0) return false;
      if (p.hasAttribute('hidden')) return false;
    }
    return true;
  };

  /**
   * The rect a finger can actually reach, after every scrolling/clipping
   * ancestor has had its say.
   *
   * P8 round 2 GAP: "every interactive element is on-screen" only compared the
   * element to the VIEWPORT, so a control scrolled out of an `overflow: auto`
   * panel measured as perfectly placed. That is why three of the four targetable
   * opponent boards in landscape — `visibleH 0`, clipped by their own scroller —
   * were invisible to this gate.
   */
  const clipRect = (el) => {
    const r = el.getBoundingClientRect();
    let l = r.left; let t = r.top; let rt = r.right; let b = r.bottom;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      const clips = (v) => v === 'hidden' || v === 'clip' || v === 'auto' || v === 'scroll';
      if (!clips(st.overflowX) && !clips(st.overflowY)) continue;
      const pr = p.getBoundingClientRect();
      if (clips(st.overflowX)) { l = Math.max(l, pr.left); rt = Math.min(rt, pr.right); }
      if (clips(st.overflowY)) { t = Math.max(t, pr.top); b = Math.min(b, pr.bottom); }
    }
    l = Math.max(l, 0); t = Math.max(t, 0);
    rt = Math.min(rt, innerWidth); b = Math.min(b, innerHeight);
    return { w: Math.max(0, rt - l), h: Math.max(0, b - t) };
  };
  const label = (el) => {
    const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean)[0] || '';
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`
      + (el.dataset?.action ? `[${el.dataset.action}]` : '');
  };

  const CONTROLS = 'button, [role="button"], [data-action], input, select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"])';
  // .propcol is the on-table TARGETING surface (interact/index.js marks it for
  // rent colours, wild moves and steals) — the mobile critic measured it at
  // 20px. Anything currently marked droppable or targetable is, by definition,
  // something the player is being asked to hit right now.
  const TARGETS = '.propcol, [data-droppable="1"], [data-targetable="1"], .is-targetable';
  // Plain layout containers. §5 says "tapping any zone zooms it", so these are
  // meant to be tappable too — but they are reported separately, because 40
  // undersized layout boxes drown the two or three controls a player is
  // actually stuck on, and a report nobody reads fixes nothing.
  const ZONES = '[data-zone]';

  const fatal = [];
  const zones = [];
  const advisory = [];
  const offscreen = [];
  const clipped = [];
  const seen = new Set();

  const consider = (el, kind) => {
    if (seen.has(el) || !vis(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2) {
      offscreen.push(`${label(el)} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    // Clipped by a scroller rather than by the viewport. Only interesting when
    // the element itself is big enough — a 20px control is already fatal above,
    // and reporting it twice buries the different defect.
    if (kind !== 'advisory') {
      const c = clipRect(el);
      if ((r.width >= MIN - 0.5 && c.w < MIN - 0.5) || (r.height >= MIN - 0.5 && c.h < MIN - 0.5)) {
        clipped.push(`${label(el)} is ${Math.round(r.width)}×${Math.round(r.height)} but only `
          + `${Math.round(c.w)}×${Math.round(c.h)} of it is reachable (clipped by a scrolling ancestor)`);
      }
    }
    let w = r.width;
    // Fanned hand: your thumb only gets the strip left uncovered by the next card.
    if (el.hasAttribute('data-card-id')) {
      const sib = el.nextElementSibling;
      if (sib && sib.hasAttribute('data-card-id')) {
        const sr = sib.getBoundingClientRect();
        if (sr.left > r.left && sr.left < r.right) w = sr.left - r.left;
      }
    }
    if (w >= MIN - 0.5 && r.height >= MIN - 0.5) return;
    const entry = `${label(el)} ${Math.round(w)}×${Math.round(r.height)}`
      + (w !== r.width ? ` (exposed strip of ${Math.round(r.width)}px card)` : '');
    ({ fatal, zones, advisory }[kind] || advisory).push(entry);
  };

  document.querySelectorAll(CONTROLS).forEach((el) => consider(el, 'fatal'));
  document.querySelectorAll(TARGETS).forEach((el) => consider(el, 'fatal'));
  document.querySelectorAll(ZONES).forEach((el) => consider(el, 'zones'));
  // Hand cards are controls: tapping one is how you play it.
  document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')
    .forEach((el) => consider(el, 'fatal'));
  // Board/mini cards: zoom affordances (§5), advisory only.
  document.querySelectorAll('[data-card-id]').forEach((el) => consider(el, 'advisory'));

  return {
    fatal, zones, advisory, offscreen, clipped,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    w: innerWidth, h: innerHeight,
  };
}

/* ─────────────────────────── z-order hit testing ───────────────────────── */

/**
 * ONE implementation of "what is actually painted on top of this element", used
 * by every gate that needs it (`auditTextContrast`'s buried-run filter,
 * `auditOccludedText`'s shot gate, `grayscale.mjs`'s hero picker). A second
 * copy would drift from this one's two calibration traps, which cost a day each:
 *
 * TRAP 1 — `elementFromPoint` skips `pointer-events: none`, and
 * `.propcol-head, .zone-tag, .pile-label, .board-head` are all
 * pointer-events:none by design (table.css:221). Left alone, every one of them
 * reports as "covered" and the gates go blind to the chrome labels that are
 * their real signal. So the rule is neutralised for the duration of the
 * measurement and restored immediately — the frame has already been captured by
 * the time this runs, and nothing visual changes.
 *
 * TRAP 2 — but NOT neutralised everywhere. Measured: a blanket
 * `*{pointer-events:auto}` handed every hit test in the game to `#emotes`, a
 * full-bleed decorative layer that is pointer-events:none precisely so it cannot
 * eat anything — 1689 of 2163 text runs came back "covered", every one of them
 * by that one div. So the full-bleed pass-through layers are identified FIRST
 * (already pointer-events:none, and covering ≥50% of the viewport) and keep
 * their transparency; only the small suppressed labels get their hits back. The
 * 50% test is a measurement, not a list: it catches `#emotes`, `#toast`,
 * `.hints` and any fx layer added later without anyone naming it here.
 *
 * TRAP 3 — a hit on the element's OWN ancestor is not occlusion.
 * `elementFromPoint` reports a pseudo-element as its originating element, and
 * every card face in this client carries a `::after` stock sheen over its own
 * text. Treating that as occlusion took the contrast sample count from 2163 to
 * 435 and the violation count to a meaningless zero.
 *
 * Everything else in this file is shipped to the page one function at a time by
 * `page.evaluate`, which serialises the function and NOT its module scope — so a
 * helper shared between two of them cannot simply be imported. This one is
 * installed into the page as `window.__chudHitTesting` by `installPageHelpers`
 * (an `addInitScript`, so it survives every `goto`), and its consumers look it
 * up and throw loudly if it is absent. Copy-pasting it into a caller instead is
 * how the three traps above get lost.
 *
 * Usage (always in a try/finally, or the page keeps the injected style):
 *   const hit = window.__chudHitTesting();
 *   try { hit.coverage(el, el.getBoundingClientRect()); } finally { hit.close(); }
 */
export function openHitTesting() {
  const style = document.createElement('style');
  const passthru = [];
  for (const e of document.querySelectorAll('body *')) {
    if (getComputedStyle(e).pointerEvents !== 'none') continue;
    const b = e.getBoundingClientRect();
    if (b.width * b.height < innerWidth * innerHeight * 0.5) continue;
    e.setAttribute('data-chud-passthru', '');
    passthru.push(e);
  }
  style.textContent = '*{pointer-events:auto !important}'
    + '[data-chud-passthru]{pointer-events:none !important}';
  document.head.appendChild(style);

  /**
   * Coverage of `el` over a grid of points inside `r`.
   *
   * `covered` keeps the original 3-point centre/left/right verdict byte for byte
   * so `auditTextContrast`'s calibrated counts do not move; `pct` is the finer
   * grid the shot gate needs to say "half-buried" with a number. `by` names the
   * topmost foreign element at the first covered point.
   */
  const coverage = (el, r) => {
    const inside = (hit) => !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    const at = (x, y) => (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight
      ? undefined : document.elementFromPoint(x, y));

    // The historical verdict: centre, then a point in from each side.
    const spine = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + Math.min(6, r.width / 4), r.top + r.height / 2],
      [r.right - Math.min(6, r.width / 4), r.top + r.height / 2],
    ];
    let spineTested = 0;
    let spineClear = false;
    for (const [x, y] of spine) {
      const h = at(x, y);
      if (h === undefined) continue;
      spineTested++;
      if (inside(h)) { spineClear = true; break; }
    }

    // The area grid: 5 across × 3 down, inset so a 1px border is not the answer.
    let tested = 0;
    let hits = 0;
    let by = null;
    for (let iy = 0; iy < 3; iy++) {
      for (let ix = 0; ix < 5; ix++) {
        const x = r.left + (r.width * (ix + 0.5)) / 5;
        const y = r.top + (r.height * (iy + 0.5)) / 3;
        const h = at(x, y);
        if (h === undefined) continue;
        tested++;
        if (h && !inside(h)) { hits++; if (!by) by = h; }
      }
    }
    return {
      covered: spineTested > 0 && !spineClear,
      pct: tested ? hits / tested : 0,
      tested,
      by,
    };
  };

  return {
    coverage,
    close() {
      style.remove();
      for (const e of passthru) e.removeAttribute('data-chud-passthru');
    },
  };
}

/**
 * NODE SIDE. Install `openHitTesting` above into a browser context as
 * `window.__chudHitTesting`, for every document it will ever load.
 *
 * `addInitScript` rather than `addScriptTag` because every gate in tools/ does a
 * full `page.goto` per take (screenshot.mjs: "state bleeds between shots"), and
 * a script tag added to one document is gone from the next one. Call it once,
 * right after `openPage`, next to `pristineStorage`.
 */
export async function installPageHelpers(context) {
  await context.addInitScript(`window.__chudHitTesting = ${openHitTesting.toString()};`);
}

/* ─────────────────────────────── occlusion ─────────────────────────────── */

/**
 * ROUND-1 GAP: occlusion was checked with `document.elementsFromPoint`, which
 * SKIPS anything with `pointer-events: none`. Every hint/coach/toast/fx layer in
 * this client is pointer-events:none by design — so a coach bubble covering 83%
 * of the CONFIRM PAYMENT button was, to the gate, not there at all. It does not
 * eat the tap; it eats the *button*, which is worse, because the player cannot
 * see what they are being asked to confirm.
 *
 * This is a pure rectangle-overlap test against the decorative layers, run
 * against the primary calls to action.
 */
export function auditOcclusion() {
  const MAX_COVER = 0.25;                       // >25% of a CTA hidden is a defect
  /**
   * P8 round 2 GAP (mobile critic): this was a hand-maintained list of button
   * ids, so every control added since it was written was exempt — including
   * `.pile[data-action="open-discard"]`, a primary on-table control. A list of
   * the CTAs someone remembered is not a measurement.
   *
   * Now it is the rule instead: anything the player is being asked to act on —
   * every enabled `[data-action]`, every button in a decision surface, and every
   * live drop/target marker. `.propcol` and card nodes are deliberately absent:
   * they are covered by other cards constantly and by design, and that noise is
   * what buried the real finding last time.
   */
  /* `[data-seat-toggle]` added P9: table/layout.js builds the collapse/expand
   * control on every opponent seat with its OWN attribute rather than
   * `data-action`, so the rule below — which was written as "every enabled
   * [data-action]" precisely to stop being a list of remembered ids — had
   * silently gone back to being a list that missed one. It is the control a
   * phone player uses most (three of four seats ship collapsed at 390×844),
   * and it is the one the `.announce` banner lands on. */
  const CTA = '[data-action]:not([disabled]), [data-seat-toggle], #prompt button, #hand-dock button, '
    + '#win-overlay button, #sheet button, .btn-primary, '
    + '[data-droppable="1"], [data-targetable="1"], .is-targetable';
  /* `.announce` added P9. ui/journal.js lays a full-width banner over the
   * table for 2600ms on final_approach / set_stolen, and it was found sitting
   * on collapsed opponent seats at 51% and 42% in portrait and 70% in
   * landscape — by an agent, by hand, because no gate had ever raised it. It
   * is `pointer-events` transparent and therefore invisible to every hit test,
   * which is exactly the class of occluder this rectangle-overlap audit exists
   * for (see §D in touchtest.mjs). */
  const VEIL = '.hints, .hint-card, #toast, #emotes, .floaters, .floater, .burst, '
    + '.fx, .fx-layer, .overlay, .scrim, .coach, .tip, .tooltip, .announce';

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  };
  const shown = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
    if (el.hasAttribute('hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const veils = [...document.querySelectorAll(VEIL)].filter((el) => {
    if (!shown(el)) return false;
    // A container that only positions children and paints nothing itself is not
    // an occluder — measure the painted children instead.
    const st = getComputedStyle(el);
    const paints = st.backgroundColor !== 'rgba(0, 0, 0, 0)'
      || st.backgroundImage !== 'none'
      || (el.textContent || '').trim().length > 0;
    return paints;
  });

  const hits = [];
  document.querySelectorAll(CTA).forEach((cta) => {
    if (!shown(cta) || cta.disabled) return;
    const c = box(cta);
    if (!c.w || !c.h) return;
    for (const v of veils) {
      if (v.contains(cta) || cta.contains(v)) continue;
      const b = box(v);
      const ow = Math.max(0, Math.min(c.r, b.r) - Math.max(c.l, b.l));
      const oh = Math.max(0, Math.min(c.b, b.b) - Math.max(c.t, b.t));
      const pct = (ow * oh) / (c.w * c.h);
      if (pct > MAX_COVER) {
        hits.push({
          cta: (cta.textContent || cta.dataset.action || cta.id || 'button').trim().slice(0, 30),
          by: `${v.tagName.toLowerCase()}${v.id ? '#' + v.id : '.' + String(v.className).trim().split(/\s+/)[0]}`,
          pct: Math.round(pct * 100),
        });
      }
    }
  });
  return hits;
}

/* ────────────────────────────── duplicate CTAs ─────────────────────────── */

/**
 * ROUND-1 GAP: nothing looked. The mobile critic found TWO enabled DRAW buttons
 * 57px apart — one in the prompt bar, one in the hand dock. Which one is live?
 * Both. Which one does the player learn? Neither.
 */
export function auditDuplicateCTAs() {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const shown = (el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
    if (st.pointerEvents === 'none') return false;
    for (let p = el; p; p = p.parentElement) if (p.hasAttribute && p.hasAttribute('hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  };
  const byKey = new Map();
  document.querySelectorAll('button, [role="button"], [data-action]').forEach((el) => {
    if (!shown(el)) return;
    const key = norm(el.dataset?.action || '') + '|'
      + norm(el.textContent || el.getAttribute('aria-label') || '');
    if (!key.replace(/\|/g, '')) return;
    if (!byKey.has(key)) byKey.set(key, []);
    const r = el.getBoundingClientRect();
    byKey.get(key).push({
      id: el.id || '', cls: String(el.className || '').trim().split(/\s+/)[0] || '',
      x: Math.round(r.left), y: Math.round(r.top),
    });
  });
  const dupes = [];
  for (const [key, els] of byKey) {
    if (els.length < 2) continue;
    // Repeated members of a deliberate set (chat scope tabs, emote grid, bot
    // rows) share an action but differ in payload — those carry data-scope /
    // data-text and are not the defect. The key includes label text, so those
    // only collide when the LABEL is also identical, which is the real defect.
    const gap = Math.round(Math.hypot(els[1].x - els[0].x, els[1].y - els[0].y));
    dupes.push({ key, count: els.length, gap, where: els.map((e) => `${e.id || e.cls}@${e.x},${e.y}`) });
  }
  return dupes;
}

/* ────────────────────────────── clipped text ───────────────────────────── */

/**
 * ROUND-1 GAP: no gate looked at text fit. The look critic found truncated
 * strings in EVERY in-game shot — 'Midnigh Requisi', 'ACTIO', 'YOU…'. Card and
 * HUD text that does not fit its box is a rendering lie: the player cannot read
 * what the card does.
 *
 * Heuristic: an element whose own computed overflow clips, whose scroll extent
 * exceeds its client extent by more than a pixel, and which holds text. Elements
 * with `overflow: visible` are excluded — they overflow without clipping, which
 * is ugly but not a truncation.
 */
export function auditClippedText() {
  const SCOPES = ['[data-card-id]', '#hud', '#prompt', '.propcol', '#win-overlay',
    '#hand-dock', '#sheet', '#lobby-players', '#side'];
  const clips = (v) => v === 'hidden' || v === 'clip' || v === 'auto' || v === 'scroll';
  const out = [];
  const seen = new Set();
  const roots = [];
  for (const s of SCOPES) document.querySelectorAll(s).forEach((e) => roots.push(e));

  for (const root of roots) {
    const st0 = getComputedStyle(root);
    if (st0.display === 'none' || st0.visibility === 'hidden') continue;
    const nodes = [root, ...root.querySelectorAll('*')];
    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      // Only leaf-ish text holders: a container's scrollWidth is its layout, not
      // a truncation of its own string.
      if ([...el.children].some((c) => (c.textContent || '').trim())) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const wClipped = clips(st.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const hClipped = clips(st.overflowY) && el.scrollHeight > el.clientHeight + 1
        && st.webkitLineClamp === 'none';
      // A scrollable region is meant to scroll; truncation only counts where the
      // player cannot reach the rest (hidden/clip, or an ellipsis is painted).
      const reachable = (st.overflowX === 'auto' || st.overflowX === 'scroll');
      if ((wClipped && (!reachable || st.textOverflow === 'ellipsis')) || hClipped) {
        out.push({
          el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className || '').trim().split(/\s+/)[0] || '?'}`,
          text: txt.slice(0, 40),
          need: Math.round(wClipped ? el.scrollWidth : el.scrollHeight),
          have: Math.round(wClipped ? el.clientWidth : el.clientHeight),
          axis: wClipped ? 'x' : 'y',
        });
      }
      // NOT flagged: a literal '…' in the DOM text. Tried it — it fires on
      // 'RECONNECTING…', where the ellipsis is a deliberate progress marker,
      // and it adds nothing the measured overflow above does not already
      // catch (that same label overflows 116px into 89px and IS reported).
    }
  }
  return out;
}

/* ──────────────────────── text buried under a layer ────────────────────── */

/**
 * P8 round 2 GAP: `five-player@phone.png` shipped with "DRONE" and "FIGH…"
 * half-buried under the deck/discard layer, and the shot gate passed, because
 * `auditClippedText` measures text OVERFLOW — does the string fit its own box —
 * and says nothing about whether that box is on top. Two different failures with
 * the same symptom (a word you cannot finish reading), and only one was gated.
 *
 * This is the z-order half, on the same hit test the contrast gate uses
 * (`openHitTesting`) so the two cannot drift apart.
 *
 * The whole difficulty is that this client STACKS ON PURPOSE. The hand fan, the
 * bank stacks and the property columns all overlap by design — table.css derives
 * the overlap from the tap floor — so "a card's name is covered" is the normal
 * case, not a defect. What is a defect is a label covered by a DIFFERENT layer:
 * a property-column card buried under `#table-center`'s piles has no stacking
 * relationship with its occluder, nobody chose that, and it reads as a bug in
 * the screenshot because it is one.
 *
 * So the rule is cross-LAYER coverage, where a layer is the nearest zone/panel
 * ancestor. Same layer (a sibling card in the same fan) → silent. Different
 * layer → measured, with the occluder named.
 */
export function auditOccludedText() {
  const SCOPES = ['[data-card-id]', '#hud', '#prompt', '.propcol', '#win-overlay',
    '#hand-dock', '#sheet', '#lobby-players', '#side'];
  const LAYER = '.cardzone, .propcol, .pile, .board, .hints, #hud, #prompt, #hand-dock, '
    + '#side, #sheet, #toast, #emotes, #win-overlay, #table-center, #lobby-players';
  /**
   * 34%, not 50%. "Half-buried" is how the critic described DRONE/FIGH, but a
   * label with a third of it under another layer is already a word you cannot
   * read, and the grid below is 15 points — 5/15 is the first count that cannot
   * be a rounding artefact of the inset.
   */
  const MAX_BURIED = 0.34;

  const shown = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.5) return false;
    if (el.hasAttribute('hidden')) return false;
    return el.getBoundingClientRect().width > 0;
  };
  /**
   * When something is UP, only the thing that is up is on trial — the same
   * scoping rule as auditTextContrast, and the same reason: nobody is reading
   * the table behind an open panel, so 36 mat labels under it are not 36
   * defects.
   *
   * `aria-modal` alone was not enough. Measured on the first run of this gate:
   * `side-log@phone` reported 66 buried runs and `peek-hold@phone` 56, every
   * one of them the table sitting behind `#side` (z 60, 74% of the viewport) or
   * `.peek` (z 92, 41%) — two panels that are open on purpose and are not
   * marked `aria-modal`. So an open panel is MEASURED rather than listed:
   * positioned, an explicit z-index ≥ 10, opaque, and covering ≥15% of the
   * viewport. Every in-flow surface in this client (`#table`, `#hand-dock`, the
   * boards) is `z-index: auto` or 1, and `#emotes` is z 80 but paints nothing,
   * so the test separates them without naming any of them.
   */
  const PANEL_Z = 10;
  const PANEL_AREA = 0.15;
  const opaque = (el) => {
    const st = getComputedStyle(el);
    if (st.backgroundImage !== 'none') return true;
    const m = String(st.backgroundColor).match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return (p.length > 3 ? p[3] : 1) >= 0.5;
  };
  const fronts = [...document.querySelectorAll('body *')].filter((el) => {
    const st = getComputedStyle(el);
    if (st.position !== 'fixed' && st.position !== 'absolute') return false;
    const z = Number(st.zIndex);
    if (!Number.isFinite(z) || z < PANEL_Z) return false;
    if (!shown(el) || !opaque(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height >= innerWidth * innerHeight * PANEL_AREA;
  });
  const modals = [...document.querySelectorAll('[aria-modal="true"], dialog[open]')].filter(shown);
  const modal = [...modals, ...fronts].pop();

  const layerOf = (el) => (el && el.closest ? el.closest(LAYER) : null);
  // getAttribute, not `.className`: on an SVG element className is an
  // SVGAnimatedString and stringifies to '[object SVGAnimatedString]'.
  const name = (el) => {
    if (!el) return '?';
    const cls = (el.getAttribute?.('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
  };
  const chain = (el) => {
    const out = [];
    for (let p = el; p && out.length < 4; p = p.parentElement) out.push(name(p));
    return out.join(' < ');
  };
  /**
   * The decorative layers. A coach bubble over a mat label is a real occlusion
   * and it is REPORTED, but it is not the same defect as the layout putting the
   * deck on top of an opponent's property head: it is transient, it is aimed at
   * the player on purpose, and `auditOcclusion` already gates the case that
   * matters (a veil over a CTA) at 25%. Gating text on it too would make every
   * phone shot red for the coach layer doing its job and bury the structural
   * finding underneath — which is how the structural finding got missed in the
   * first place. So: veil → warn, layout → fail, and the split is printed.
   */
  const VEIL = '.hints, .hint-card, #toast, #emotes, .floaters, .floater, .burst, '
    + '.fx, .fx-layer, .coach, .tip, .tooltip, .announce';

  const roots = [];
  for (const s of SCOPES) {
    (modal || document).querySelectorAll(s).forEach((e) => roots.push(e));
  }
  if (modal) roots.push(modal);

  const out = [];
  const seen = new Set();
  if (typeof window.__chudHitTesting !== 'function') {
    throw new Error('audit.installPageHelpers(context) was never called — no hit testing in this page');
  }
  const hit = window.__chudHitTesting();
  try {
    for (const root of roots) {
      const st0 = getComputedStyle(root);
      if (st0.display === 'none' || st0.visibility === 'hidden') continue;
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (modal && !modal.contains(el)) continue;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        // Leaf-ish only: a container "covered" is its children's story to tell.
        if ([...el.children].some((c) => (c.textContent || '').trim())) continue;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        let faded = false;
        for (let p = el; p; p = p.parentElement) {
          if (p.hasAttribute?.('hidden') || Number(getComputedStyle(p).opacity) < 0.05) { faded = true; break; }
        }
        if (faded) continue;
        const r = el.getBoundingClientRect();
        // Off-screen is auditDeadSpace/auditTapTargets' subject, not this one.
        if (r.width < 8 || r.height < 6) continue;
        if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;

        const mine = layerOf(el);
        const c = hit.coverage(el, r);
        if (!c.tested || c.pct <= MAX_BURIED) continue;
        const theirs = layerOf(c.by);
        // Same stack → by design. Also skip when the occluder's layer contains
        // this run's layer (a panel painting over its own contents is that
        // panel's own composition, e.g. a zone tag over its cardzone).
        if (theirs && mine && (theirs === mine || theirs.contains(mine) || mine.contains(theirs))) continue;
        if (!theirs && !mine) continue;
        // CARD OVER CARD is the documented by-design case wherever it happens,
        // not only inside one zone. The hand fan, the bank stacks, the property
        // columns and a card held mid-drag over the table are all one card lying
        // on another, and `drag-mid@phone` reported 17 of them. The rule that
        // matters is the one the critic found: a label buried under something
        // that is NOT a card and has no stacking relationship with it.
        const myCard = el.closest('[data-card-id], .card');
        const theirCard = c.by?.closest?.('[data-card-id], .card');
        if (myCard && theirCard && myCard !== theirCard) continue;
        out.push({
          el: name(el),
          text: txt.slice(0, 40),
          pct: Math.round(c.pct * 100),
          by: name(c.by),
          byLayer: name(theirs),
          layer: name(mine),
          byChain: chain(c.by),
          veil: !!(c.by && c.by.closest && c.by.closest(VEIL)),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        });
      }
    }
  } finally {
    hit.close();
  }
  return out;
}

/* ───────────────────────────── chrome / dead space ─────────────────────── */

/**
 * ROUND-1 GAP: ~68px of dead space at the top of the phone layout, because the
 * safe-area inset is applied twice (an ancestor pads for it AND the child does).
 * Emulated Chromium reports zero insets, so ANY unexplained band above the first
 * painted pixel is either a double-count or a hardcoded notch guess — both are
 * bugs, and both are invisible to a screenshot review that expects a notch.
 */
export function auditDeadSpace() {
  const root = document.getElementById('app') || document.body;
  let top = Infinity;
  let bottom = -Infinity;
  const paints = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
    if (st.backgroundColor !== 'rgba(0, 0, 0, 0)') return true;
    if (st.backgroundImage !== 'none') return true;
    if (st.borderTopWidth !== '0px' || st.borderBottomWidth !== '0px') return true;
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  };
  for (const el of root.querySelectorAll('*')) {
    // The app shell itself and full-bleed backdrops describe the viewport, not
    // the content — they would always report zero dead space.
    const r = el.getBoundingClientRect();
    if (r.height >= innerHeight - 1 || !r.width || !r.height) continue;
    if (r.bottom <= 0 || r.top >= innerHeight) continue;
    if (!paints(el)) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  const insets = getComputedStyle(document.documentElement);
  return {
    top: Number.isFinite(top) ? Math.round(Math.max(0, top)) : -1,
    bottom: Number.isFinite(bottom) ? Math.round(Math.max(0, innerHeight - bottom)) : -1,
    h: innerHeight,
    // Emulated Chromium has no notch — these should all be 0px.
    envTop: insets.getPropertyValue('--safe-top') || '',
  };
}

/* ─────────────────────────── soft keyboard (§2) ────────────────────────── */

/**
 * ROUND-1 GAP: no gate touched the software keyboard. The chat composer sat
 * 327px UNDER it — you cannot see what you are typing. §2 explicitly keeps
 * "visualViewport keyboard handling" from the old client, so this is a
 * regression against the constitution, not a nice-to-have.
 *
 * There is no CDP soft-keyboard emulation, so this shrinks `visualViewport`
 * the way iOS does (height/offsetTop change, LAYOUT viewport untouched) and
 * fires the resize event. A client that listens adapts; one that does not,
 * does not — which is exactly the distinction under test.
 */
export function shrinkViewportForKeyboard(kb) {
  const vv = window.visualViewport;
  if (!vv) return false;
  const real = vv.height;
  if (!window.__CHUD_KB_PATCHED) {
    Object.defineProperty(vv, 'height', { configurable: true, get: () => window.__CHUD_KB_H });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    window.__CHUD_KB_PATCHED = true;
    window.__CHUD_KB_REAL = real;
  }
  window.__CHUD_KB_H = window.__CHUD_KB_REAL - kb;
  vv.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('resize'));
  return true;
}

/* ─────────────────────── text contrast (§0.9, ART §10) ─────────────────── */

/**
 * §0.9 / ART-DIRECTION §10: "Both themes ≥4.5:1 on every text token."
 *
 * P8 GAP: nothing measured contrast. ART §2 publishes pre-verified ratios for
 * the token VALUES, but a token's published ratio is a claim about a pair
 * (`--fg` on `--ground`); it says nothing about the pair a given string is
 * ACTUALLY painted in. A dual-theme system multiplies the pairs by two and a
 * screenshot review cannot read a ratio off a picture — the failure mode this
 * catches is `--fg-mute` landing on `--ground-deep` in exactly one theme,
 * which looks fine in the dark shot and is 3.1:1 in the light one.
 *
 * Method (WCAG 2.x, the same relative-luminance formula as ART §2):
 *   • effective text colour  = own `color`, composited over the background
 *     stack if the colour itself is translucent,
 *   • effective background   = the ancestor `background-color` stack composited
 *     down to the first opaque layer,
 *   • threshold              = 3:1 for large text (≥24px, or ≥18.66px at ≥700),
 *     4.5:1 otherwise — WCAG 1.4.3 as §0.9 cites it.
 *
 * `approx: true` marks a sample whose background stack included a
 * `background-image` (the apron gradient, card art, hazard stripes, the
 * metallic-gradient buttons ART §3.4 wants killed). For those the CSS stack
 * bottoms out at whatever colour sits UNDER the image, which is routinely the
 * page — measured on `home@desktop`, `#btn-quick-play` reads "1.22:1" against
 * the body while the eye sees dark ink on a bright brass gradient. So this
 * returns EVERY sample with its rect, and `checkContrast.mjs` re-derives the
 * background of an `approx` sample from the rendered pixels. CSS supplies the
 * ink; the frame supplies the paper.
 *
 * Fully transparent text is skipped, not failed: `color: transparent` on a
 * buried card's band (table.css:654) is a deliberate *hiding*, and 39 of them
 * would otherwise drown every real violation at a nominal 0:1.
 */
export function auditTextContrast() {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };

  /** Composite every ancestor background-color down to the first opaque one. */
  const backdrop = (el) => {
    const stack = [];
    let img = false;
    for (let p = el; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (st.backgroundImage !== 'none') img = true;
      const c = parse(st.backgroundColor);
      if (!c || c.a === 0) continue;
      stack.push(c);
      if (c.a >= 0.999) break;
    }
    // Canvas under everything. `html`'s own colour already entered the stack if
    // it had one; this is the paper the last translucent layer sits on.
    let out = { r: 255, g: 255, b: 255, a: 1 };
    const html = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (html && html.a >= 0.999) out = html;
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return { col: out, img };
  };

  const vis = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (Number(st.opacity) < 0.15) return false;          // faded-out layers are not text
    if (el.getAttribute('aria-hidden') === 'true') return false;
    for (let p = el; p; p = p.parentElement) {
      if (p.hasAttribute?.('hidden')) return false;
      if (Number(getComputedStyle(p).opacity) < 0.15) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };

  /**
   * When a dialog is open, only the dialog is on trial.
   *
   * P8, measured: with the discard browser open, `win@light` reported 38
   * violations, 36 of them property-mat labels UNDER the scrim — the CSS says
   * ink on a light mat, the frame says ink on a dimmed mat, and neither is a
   * defect because nobody is reading the table while a modal is up. Scoping to
   * the topmost `aria-modal` subtree is also what the accessibility tree does,
   * so the gate and the screen reader agree on what "the content" is.
   */
  const modal = [...document.querySelectorAll('[aria-modal="true"], dialog[open]')]
    .filter((d) => !d.hasAttribute('hidden') && getComputedStyle(d).display !== 'none'
      && d.getBoundingClientRect().width > 0)
    .pop();
  const scope = modal || document.body;

  /**
   * Cards are STACKED — the hand fan, bank stacks, property columns and the
   * upgrade badges all overlap by design (table.css derives the overlap from
   * the tap floor). A buried card's name and value band are still in the DOM
   * with their computed colours, and sampling them measures ink against
   * whatever shows through, which is a picture of nothing.
   *
   * Reported by the card-art agent (commit ac44aa4) after it hit-tested the
   * 24 card-side violations remaining from its own fix: ALL 24 were covered.
   * The entire card-side signal was noise.
   *
   * The hit test and its two calibration traps live in `openHitTesting` — read
   * that comment before changing anything here.
   */
  if (typeof window.__chudHitTesting !== 'function') {
    throw new Error('audit.installPageHelpers(context) was never called — no hit testing in this page');
  }
  const hit = window.__chudHitTesting();
  const covered = (el, r) => hit.coverage(el, r).covered;

  const out = [];
  let hidden = 0;
  const seen = new Set();
  for (const el of scope.querySelectorAll('*')) {
    if (seen.has(el)) continue;
    seen.add(el);
    // Own text only: a container's `color` is not what its children paint in.
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!own) continue;
    if (!vis(el)) continue;
    const st = getComputedStyle(el);
    const raw = parse(st.color);
    if (!raw) continue;
    // Painted-invisible text (see the header note) is hidden, not unreadable.
    const fill = parse(st.webkitTextFillColor || st.color);
    if (raw.a < 0.05 || (fill && fill.a < 0.05)) continue;
    const { col: bg, img } = backdrop(el);
    const fg = raw.a >= 0.999 ? raw : over(raw, bg);
    const px = parseFloat(st.fontSize) || 16;
    const wt = Number(st.fontWeight) || 400;
    // WCAG 1.4.3 large text, which is the standard §0.9 names.
    const large = px >= 24 || (px >= 18.66 && wt >= 700);
    const r = el.getBoundingClientRect();
    if (covered(el, r)) { hidden++; continue; }
    out.push({
      el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`
        + `.${String(el.className || '').trim().split(/\s+/)[0] || '?'}`,
      text: own.slice(0, 34),
      need: large ? 3 : 4.5,
      px: Math.round(px),
      fg: [Math.round(fg.r), Math.round(fg.g), Math.round(fg.b)],
      bgCss: [Math.round(bg.r), Math.round(bg.g), Math.round(bg.b)],
      ratioCss: Math.round(ratio(fg, bg) * 100) / 100,
      approx: img,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      scope: modal ? (modal.id || 'modal') : 'page',
    });
  }
  hit.close();
  return { samples: out, hidden, scope: modal ? (modal.id || 'modal') : 'page' };
}

/** Is the focused composer reachable above the keyboard line? */
export function measureComposer(kb) {
  const line = innerHeight - kb;
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), top: Math.round(r.top), h: Math.round(r.height) };
  };
  return {
    line: Math.round(line),
    input: pick('#chat-input'),
    send: pick('[data-action="send-chat"]'),
    vvHeight: Math.round(window.visualViewport?.height ?? -1),
  };
}
