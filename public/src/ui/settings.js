// ui/settings.js — sound and the way back to the rules.
//
// The audio engine (P5) already persists its own preferences; this is only the
// control surface. Every control is a native form element so keyboard operation
// is the browser's job, not ours: Space toggles the switch, arrows move the
// slider (§0.9).
//
// SFX and MUSIC are two independent pairs, persisted separately by the engine,
// because "kill the music, keep the card sounds" is the setting people actually
// want (audio agent, P7: there is now a menu bed and an in-match drone).

import { el, setAttr, setText } from '../core/dom.js';
import * as audio from '../audio/engine.js';
import * as pointer from '../interact/pointer.js';
import { openSheet, closeSheet } from './screens.js';
import * as hints from './hints.js';

function pct(v) { return `${Math.round(v * 100)}%`; }

/* ══ UI SCALE ═══════════════════════════════════════════════════════════════
   A multiplier on --s (style/variables.css), and on --s ONLY. The bounds are
   measurements, not taste — swept on a 390×844 phone across the mid-game,
   five-player and big-hand fixtures with the GATE'S OWN audit
   (tools/lib/audit.mjs auditTapTargets), so these numbers are the same ones
   touchtest reports:

     scale   fatal sub-44px controls        offscreen controls
     0.70    1–4  (pile 40×68; hand card    0 / 3 / 0
                   exposed strip 43px)
     0.80    0    0    0                    0 / 3 / 0
     1.00    0    0    0                    0 / 0 / 0
     1.30    0    0    0                    0 / 0 / 1
     1.40    0    0    0                    13 / 4 / 2  ← section.board 370×432
                                                          leaves the viewport

   MIN 0.80 — the §0.9 floor is what fails first going down, and it fails at
   0.70, not at 0.80. table.css floors most hit areas on --tap rather than --s
   (`min-height: var(--tap)`, `max(var(--card-tap), calc(var(--s) * N))`,
   `minmax(var(--tap), 1fr)`), so shrinking --s slides each card down its max()
   until --tap takes over and the target stops shrinking. Two places leak
   because they have no --tap floor — `.opponents .zone-bank` (--card-w is a
   bare `calc(var(--s) * 2.2)`) and the deck/discard pile — and those are what
   go sub-44 at 0.70. 0.80 is the last step measured clean everywhere.

   MAX 1.30 — going up, targets never fail; LAYOUT does. 1.40 pushes whole
   boards out of the viewport (13 offscreen controls on mid-game). 1.30 costs
   exactly one offscreen node, a hand card in big-hand, and .zone-hand is
   `overflow-x: auto` so it is still reachable by scrolling the fan.

   DEFAULT 1 — arithmetically the pre-setting expression, so a player who never
   opens this sees the identical table and tools/screenshot.mjs hashes are
   unchanged. VERIFIED, not argued: mid-game/five-player/big-hand rendered at
   phone and desktop under `calc(clamp(…) * var(--ui-scale))` and under the bare
   `clamp(…)` produced byte-identical PNG hashes, --s resolving to 14.3438px and
   16.5469px in both. The gate also runs on pristine storage (harness.mjs
   pristineStorage), so it reads this default and never a stored value.

   iOS FOCUS-ZOOM is NOT reintroduced by scaling down, and this was measured
   rather than assumed, because it is the obvious way this setting could have
   broken the fix at base.css's `.field` rule. That rule is `font-size:
   max(16px, 1em)` — the 16px arm is an absolute length and does not take the
   multiplier, so it holds. Swept at 0.80: all six focusable text controls
   (name-input, code-input, chat-input and the three lobby selects) compute to
   exactly 16px, which is the safe side of the threshold — Mobile Safari zooms
   at 15px and below, and 16px does not zoom.

   Scaling DOWN is the direction that helps this table most, and that is also
   measured: the clipped-by-a-scrolling-ancestor count (touchtest's largest
   failure) falls with scale — mid-game 6 clipped at 1.00 → 0 at 0.80,
   five-player 24 → 15. The control is a real player-side mitigation for the
   clipped board, not just a type-size preference. */
const SCALE_KEY = 'chud.uiscale';
const SCALE_MIN = 0.8;
const SCALE_MAX = 1.3;
const SCALE_DEFAULT = 1;

// `Number('')` is 0, not NaN, so a blank key would clamp to the FLOOR and a
// player whose storage got half-written would silently boot at 80%. Measured:
// before this guard, localStorage['chud.uiscale'] = '' rendered --s at 11.47px
// instead of 14.34px. Blank is missing, and missing is the default.
function clampScale(v) {
  // Number('') and Number(null) are both 0 — finite, so they would survive the
  // guard below and clamp to the FLOOR. Blank and absent are neither a size
  // nor an error; they are the default.
  if (v == null || (typeof v === 'string' && v.trim() === '')) return SCALE_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return SCALE_DEFAULT;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

export function getScale() {
  try {
    const raw = localStorage.getItem(SCALE_KEY);
    return raw == null ? SCALE_DEFAULT : clampScale(raw);
  } catch { return SCALE_DEFAULT; }        // private mode
}

export function setScale(v) {
  const n = clampScale(v);
  applyScale(n);
  try { localStorage.setItem(SCALE_KEY, String(n)); } catch { /* private mode */ }
}

/** The only writer of --ui-scale. Left unset at the default so the cascade
 *  keeps variables.css's own `--ui-scale: 1` and the computed style of a
 *  default session is byte-identical to one from before this setting existed. */
function applyScale(n) {
  const root = document.documentElement;
  if (n === SCALE_DEFAULT) root.style.removeProperty('--ui-scale');
  else root.style.setProperty('--ui-scale', String(n));
}

// Applied at module evaluation, not at mount(): mount() runs inside boot()
// after table.mount() has already built the table, and re-scaling it there is
// a visible jump on every load for anyone not at 100%. The import graph
// resolves before boot() runs, so this lands before first paint.
applyScale(getScale());

/**
 * One switch + slider bound to one pair of engine getters/setters.
 * @param {{id:string, label:string, isOn:Function, setOn:Function,
 *          getVol:Function, setVol:Function, preview?:boolean}} spec
 */
function channel(body, spec) {
  const toggle = el('input', {
    id: `set-${spec.id}`, class: 'switch-input', attrs: { type: 'checkbox' },
  });
  toggle.checked = !!spec.isOn();

  const slider = el('input', {
    id: `set-${spec.id}-vol`, class: 'slider',
    attrs: {
      type: 'range', min: '0', max: '100', step: '5',
      'aria-label': `${spec.label} volume`,
    },
  });
  slider.value = String(Math.round(spec.getVol() * 100));
  const readout = el('span', { class: 'settings-readout', text: pct(spec.getVol()) });

  const sync = () => {
    setAttr(slider, 'disabled', toggle.checked ? null : true);
    setText(readout, toggle.checked ? pct(spec.getVol()) : 'muted');
  };

  toggle.addEventListener('change', () => {
    spec.setOn(toggle.checked);
    // A settings change is itself a user gesture, so the graph may be built here
    // (§7: never before one). init() is idempotent and a no-op under the harness.
    if (toggle.checked) { audio.init(); if (spec.preview !== false) audio.play('ui_tick'); }
    sync();
  });
  slider.addEventListener('input', () => {
    spec.setVol(Number(slider.value) / 100);
    setText(readout, pct(spec.getVol()));
  });
  // Preview on release only — one tick per drag, not one per step. Music needs
  // no preview: changing its volume is audible in the bed already playing.
  slider.addEventListener('change', () => {
    audio.init();
    if (spec.preview !== false) audio.play('ui_tick');
  });

  body.appendChild(el('div', { class: 'settings-row' }, [
    el('label', { class: 'settings-label', text: spec.label, attrs: { for: toggle.id } }),
    el('span', { class: 'switch' }, [toggle, el('span', { class: 'switch-face' })]),
  ]));
  body.appendChild(el('div', { class: 'settings-row' }, [
    el('label', { class: 'settings-label', text: 'Volume', attrs: { for: slider.id } }),
    slider,
    readout,
  ]));
  sync();
}

/**
 * The UI scale row. A native range input for the same reason every other
 * control here is native: arrows move it without us writing a key handler
 * (§0.9). Percent, not a multiplier, because "90%" is the unit players already
 * read on the two volume rows above it.
 */
function scaleRow(body) {
  const slider = el('input', {
    id: 'set-uiscale', class: 'slider',
    attrs: {
      type: 'range',
      min: String(Math.round(SCALE_MIN * 100)),
      max: String(Math.round(SCALE_MAX * 100)),
      step: '5',
      'aria-label': 'Interface scale',
    },
  });
  slider.value = String(Math.round(getScale() * 100));
  const readout = el('span', { class: 'settings-readout', text: pct(getScale()) });

  // `input`, not `change`: the whole point is that the table behind the sheet
  // resizes under the thumb, so the player picks a size by seeing it.
  slider.addEventListener('input', () => {
    setScale(Number(slider.value) / 100);
    setText(readout, pct(getScale()));
  });

  body.appendChild(el('div', { class: 'settings-row' }, [
    el('label', { class: 'settings-label', text: 'Interface scale', attrs: { for: slider.id } }),
    slider,
    readout,
  ]));
}

export function show() {
  const body = el('div', { class: 'settings' });

  channel(body, {
    id: 'sound', label: 'Sound',
    isOn: audio.isEnabled, setOn: audio.setEnabled,
    getVol: audio.getVolume, setVol: audio.setVolume,
  });
  channel(body, {
    id: 'music', label: 'Music',
    isOn: audio.isMusicEnabled, setOn: audio.setMusicEnabled,
    getVol: audio.getMusicVolume, setVol: audio.setMusicVolume,
    preview: false,
  });

  scaleRow(body);

  body.appendChild(el('p', {
    class: 'hint',
    text: 'Interface scale resizes the cards and text. Buttons and card targets keep their '
      + 'full tap size at every setting, so a smaller table is still a hittable one.',
  }));

  body.appendChild(el('p', {
    class: 'hint',
    text: 'Reduced motion is followed automatically from your system setting — cards fade '
      + 'instead of flying, and the sound stays.',
  }));

  body.appendChild(el('button', {
    class: 'btn btn-primary', text: 'How to play',
    attrs: { type: 'button' }, dataset: { action: 'help' },
  }));
  body.appendChild(el('button', {
    class: 'btn btn-ghost', text: 'Show first-game hints again',
    attrs: { type: 'button' }, dataset: { action: 'reset-hints' },
  }));

  openSheet('Settings', body);
}

export function mount() {
  pointer.registerActions({
    settings: () => show(),
    'reset-hints': () => { hints.reset(); closeSheet(); },
  });
  // The "How to play" button carries data-action="help", which ui/overlays.js
  // registers — one handler, one paged brief, no second entry point to drift.
}
