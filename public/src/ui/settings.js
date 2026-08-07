// ui/settings.js — sound and the way back to the rules.
//
// The audio engine (P5) already persists its own preferences; this is only the
// control surface for setEnabled/isEnabled/setVolume/getVolume. Both controls
// are native form elements so keyboard operation is the browser's job, not
// ours: Space toggles the switch, arrows move the slider (§0.9).

import { el, setAttr, setText } from '../core/dom.js';
import * as audio from '../audio/engine.js';
import * as pointer from '../interact/pointer.js';
import { openSheet, closeSheet } from './screens.js';
import * as hints from './hints.js';

function pct(v) { return `${Math.round(v * 100)}%`; }

export function show() {
  const body = el('div', { class: 'settings' });

  /* sound on/off — a real checkbox behind a switch face */
  const toggle = el('input', {
    id: 'set-sound',
    class: 'switch-input',
    attrs: { type: 'checkbox' },
  });
  toggle.checked = audio.isEnabled();
  const slider = el('input', {
    id: 'set-volume',
    class: 'slider',
    attrs: {
      type: 'range', min: '0', max: '100', step: '5',
      'aria-label': 'Sound volume',
    },
  });
  slider.value = String(Math.round(audio.getVolume() * 100));
  const readout = el('span', { class: 'settings-readout', text: pct(audio.getVolume()) });

  const sync = () => {
    setAttr(slider, 'disabled', toggle.checked ? null : true);
    setText(readout, toggle.checked ? pct(audio.getVolume()) : 'muted');
  };

  toggle.addEventListener('change', () => {
    audio.setEnabled(toggle.checked);
    // A settings change is itself a user gesture, so the graph may be built here
    // (§7: never before one). init() is idempotent and a no-op under the harness.
    if (toggle.checked) { audio.init(); audio.play('ui_tick'); }
    sync();
  });
  slider.addEventListener('input', () => {
    audio.setVolume(Number(slider.value) / 100);
    setText(readout, pct(audio.getVolume()));
  });
  // Preview on release only — one tick per drag, not one per step.
  slider.addEventListener('change', () => { audio.init(); audio.play('ui_tick'); });

  body.appendChild(el('div', { class: 'settings-row' }, [
    el('label', { class: 'settings-label', text: 'Sound', attrs: { for: 'set-sound' } }),
    el('span', { class: 'switch' }, [toggle, el('span', { class: 'switch-face' })]),
  ]));
  body.appendChild(el('div', { class: 'settings-row' }, [
    el('label', { class: 'settings-label', text: 'Volume', attrs: { for: 'set-volume' } }),
    slider,
    readout,
  ]));
  sync();

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
