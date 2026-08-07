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
