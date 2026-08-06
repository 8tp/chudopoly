// interact/pointer.js — the ONE delegated listener (§2: no inline handlers).
//
// Everything clickable in the client is either [data-action="name"] (a control)
// or [data-card-id] / [data-targetable] (the table). Both routes are keyboard
// operable: Enter/Space activate, Escape cancels (§0.9).

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';

const handlers = new Map();

export function registerAction(name, fn) { handlers.set(name, fn); }
export function registerActions(map) { for (const k in map) handlers.set(k, map[k]); }

let cardTap = () => {};
let targetTap = () => {};
let escape = () => {};

export function onCardTap(fn) { cardTap = fn; }
export function onTargetTap(fn) { targetTap = fn; }
export function onEscape(fn) { escape = fn; }

export function mount() {
  document.addEventListener('click', (e) => route(e));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { escape(); return; }
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const el = e.target;
    if (!el || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON') return;
    if (el.closest('[data-action], [data-card-id], [data-targetable]')) {
      e.preventDefault();
      route(e);
    }
  });
}

function route(e) {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;

  const targetable = el.closest('[data-targetable="1"]');
  if (targetable) {
    e.preventDefault();
    targetTap(targetable, e);
    return;
  }

  const actionEl = el.closest('[data-action]');
  if (actionEl) {
    const name = actionEl.dataset.action;
    const fn = handlers.get(name);
    bus.emit(EVENTS.ACTION, { name, el: actionEl });
    if (fn) { e.preventDefault(); fn(actionEl, e); }
    return;
  }

  const card = el.closest('[data-card-id]');
  if (card) {
    cardTap(Number(card.getAttribute('data-card-id')), card, e);
  }
}
