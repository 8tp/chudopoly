// ui/screens.js — screen switching, toasts, and the one bottom sheet.
//
// Sheets are used for exactly what §5 allows: card details, help, settings,
// discard pick. Everything else (targeting, payment, the action strip) happens
// on the table or in the prompt bar.

import { $, clear, setHidden, setText, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as pointer from '../interact/pointer.js';

const SCREENS = ['home', 'lobby', 'game'];
let toastTimer = 0;
let sheetReturnFocus = null;

export function showScreen(name) {
  for (const screen of SCREENS) setHidden($(`screen-${screen}`), screen !== name);
}

export function toast(message) {
  const el = $('toast');
  if (!el || !message) return;
  setText(el, message);
  setClass(el, 'is-on', true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setClass(el, 'is-on', false), 2600);
}

export function openSheet(title, body, { onClose } = {}) {
  const sheet = $('sheet');
  if (!sheet) return;
  setText($('sheet-title'), title);
  const host = $('sheet-body');
  clear(host);
  if (body) host.appendChild(body);
  sheet.__onClose = onClose || null;
  sheetReturnFocus = document.activeElement;
  setHidden(sheet, false);
  const focusable = sheet.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  focusable?.focus();
}

export function closeSheet() {
  const sheet = $('sheet');
  if (!sheet || sheet.hidden) return;
  setHidden(sheet, true);
  clear($('sheet-body'));
  const cb = sheet.__onClose;
  sheet.__onClose = null;
  if (typeof cb === 'function') cb();
  if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}

export function sheetOpen() { return !$('sheet')?.hidden; }

export function mount() {
  pointer.registerActions({
    'close-sheet': () => closeSheet(),
  });

  bus.on(EVENTS.TOAST, (message) => toast(message));
  bus.on(EVENTS.STATE_SCREEN, (name) => showScreen(name));

  // Focus trap (§0.9): Tab cycles inside an open sheet, Escape closes it.
  document.addEventListener('keydown', (e) => {
    const sheet = $('sheet');
    if (!sheet || sheet.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Scrim tap closes the sheet without swallowing taps inside the panel.
  $('sheet')?.addEventListener('click', (e) => {
    if (e.target === $('sheet')) closeSheet();
  });
}
