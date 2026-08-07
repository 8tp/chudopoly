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
  const vis = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    if (st.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    // Off-screen surfaces (a closed sheet translated away) are not on trial here.
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      if (p.hasAttribute('hidden')) return false;
    }
    return true;
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
  const seen = new Set();

  const consider = (el, kind) => {
    if (seen.has(el) || !vis(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2) {
      offscreen.push(`${label(el)} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`);
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
    fatal, zones, advisory, offscreen,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    w: innerWidth, h: innerHeight,
  };
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
  const CTA = '#prompt button, #hand-dock button, #win-overlay button, .btn-primary, '
    + '[data-action="confirm-payment"], [data-action="confirm-discard"], '
    + '[data-action="respond-accept"], [data-action="respond-opsec"], '
    + '[data-action="draw"], [data-action="end-turn"], [data-action="begin-payment"]';
  const VEIL = '.hints, .hint-card, #toast, #emotes, .floaters, .floater, .burst, '
    + '.fx, .fx-layer, .overlay, .scrim, .coach, .tip, .tooltip';

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
