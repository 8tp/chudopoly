// anim/choreographer.js — engine events become table motion, in order.
//
// Contract with the rest of the client (§5, §10):
//   1. events are consumed SERIALLY, oldest first, ≤600ms each;
//   2. every event declares which card ids it expects to move ("claims");
//   3. after the last event, table.reconcile(snapshot) corrects everything and
//      counts every correction that no claim predicted as DRIFT.
//
// So the claim table below is not decoration: a missing claim is a nonzero
// driftCount in tools/playtest.mjs, which is exactly the signal that the
// animation told the player something the server did not say.
//
// P3 scope: each event maps to move/spawn primitives plus an sfx name on the
// bus. The motion agent (P4) replaces the durations and adds arcs/flips; the
// claim table should survive that unchanged.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { wait } from '../core/clock.js';
import { prefersReducedMotion } from '../core/dom.js';
import * as table from '../table/index.js';
import { getNode } from '../table/cardnode.js';
import { isPropertyCard } from '../core/cards.js';

const MAX_STEP = 600;                    // §10 — nothing uninterruptible over 600ms
const STEP_MS = {
  deal: 90, draw: 140, play_money: 220, play_property: 240, play_action: 220,
  payment: 280, steal: 300, set_stolen: 320, swap: 300, upgrade: 220,
  move_property: 200, discard: 180, shuffle: 240, opsec: 260,
  rent_charged: 200, demand: 160, action_blocked: 200, insolvent: 160,
  set_completed: 240, win: 320, stalemate: 320, scoop: 300,
  turn_start: 120, turn_end: 80, game_start: 120,
};

const queue = [];
let running = false;
let instant = false;
let selfId = null;

export function setSelf(id) { selfId = id; }
export function setInstant(on) { instant = !!on; }
export function isInstant() { return instant; }
export function pending() { return queue.length; }

export function clear() { queue.length = 0; }

/**
 * @param {object} snapshot
 * @param {Array} events   only events unseen by the store
 * @param {{snap?:boolean}} opts  snap = reconnect / fixture load → no animation
 */
export function enqueue(snapshot, events, opts = {}) {
  if (!snapshot) return;
  if (opts.snap) {
    queue.length = 0;
    table.reconcile(snapshot, { count: false, animate: false });
    bus.emit(EVENTS.CHOREO_IDLE, null);
    return;
  }
  if (!events || events.length === 0) {
    if (running) { queue.push({ snapshot, events: [] }); return; }
    table.reconcile(snapshot, { count: true, animate: false });
    return;
  }
  if (instant) { runJob({ snapshot, events }); return; }

  queue.push({ snapshot, events });
  // Backpressure: multiplayer cannot wait on cinematics. Three jobs deep the
  // table is already a second behind the server, so collapse to the newest.
  if (queue.length > 3) {
    const newest = queue[queue.length - 1];
    queue.length = 0;
    queue.push(newest);
  }
  if (!running) drain();
}

async function drain() {
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await runJobAsync(job);
    }
  } catch (err) {
    bus.reportError(err);
  } finally {
    running = false;
    bus.emit(EVENTS.CHOREO_IDLE, null);
  }
}

async function runJobAsync(job) {
  const expected = new Set();
  const animate = !prefersReducedMotion();
  for (const ev of job.events) {
    applyEvent(ev, job.snapshot, expected, animate);
    bus.emit(EVENTS.CHOREO_EVENT, ev);
    const step = Math.min(MAX_STEP, STEP_MS[ev.t] ?? 120);
    if (step > 0) await wait(step);
  }
  table.reconcile(job.snapshot, { expected, count: true, animate });
}

function runJob(job) {
  const expected = new Set();
  for (const ev of job.events) {
    applyEvent(ev, job.snapshot, expected, false);
    bus.emit(EVENTS.CHOREO_EVENT, ev);
  }
  table.reconcile(job.snapshot, { expected, count: true, animate: false });
}

/* ── primitives ────────────────────────────────────────────────────────── */

function claim(expected, id) { if (id != null) expected.add(id); }

function move(card, zoneKey, expected, animate, originKey) {
  if (!card || card.id == null || !zoneKey) return;
  claim(expected, card.id);
  if (!getNode(card.id) && originKey) table.spawnCard(card, originKey);
  else if (!getNode(card.id)) table.spawnCard(card, zoneKey);
  table.moveCard(card.id, zoneKey, { animate });
}

/** Every upgrade card a player currently holds — a broken set silently discards
 *  them and the engine emits no event for it (game.js discardUpgrades). */
function claimUpgradesOf(playerId, expected) {
  if (!playerId) return;
  const board = table.boardEl(playerId);
  if (!board) return;
  for (const zone of board.querySelectorAll('.zone-ups')) {
    for (const node of zone.children) {
      const id = Number(node.getAttribute('data-card-id'));
      if (Number.isInteger(id)) expected.add(id);
    }
  }
}

function claimAllOf(playerId, expected) {
  const board = table.boardEl(playerId);
  if (!board) return;
  for (const node of board.querySelectorAll('[data-card-id]')) {
    const id = Number(node.getAttribute('data-card-id'));
    if (Number.isInteger(id)) expected.add(id);
  }
}

function claimDiscard(expected) {
  const zone = table.zoneFor('discard');
  if (!zone) return;
  for (const node of zone.children) {
    const id = Number(node.getAttribute('data-card-id'));
    if (Number.isInteger(id)) expected.add(id);
  }
}

const Z = table.zoneKeyFor;

function applyEvent(ev, snapshot, expected, animate) {
  const sfx = ev.t;
  switch (ev.t) {
    case 'deal':
    case 'draw': {
      if (!Array.isArray(ev.cards)) break;                 // opponents: backs only
      for (const card of ev.cards) move(card, Z('hand', ev.to), expected, animate, 'deck');
      break;
    }

    case 'play_money':
      move(ev.card, Z('bank', ev.actor), expected, animate, Z('hand', ev.actor));
      break;

    case 'play_property':
      move(ev.card, Z('properties', ev.actor, ev.color), expected, animate, Z('hand', ev.actor));
      break;

    case 'play_action':
      // upgrade/foc are placed by the `upgrade` event that follows; every other
      // action card is discarded by discardAndSpend() before the response window.
      if (ev.action === 'upgrade' || ev.action === 'foc') claim(expected, ev.card?.id);
      else move(ev.card, 'discard', expected, animate, Z('hand', ev.actor));
      break;

    case 'opsec':
      move(ev.card, 'discard', expected, animate, Z('hand', ev.actor));
      break;

    case 'upgrade':
      move(ev.card, Z('upgrades', ev.actor, ev.color), expected, animate, Z('hand', ev.actor));
      break;

    case 'payment': {
      claimUpgradesOf(ev.from, expected);
      for (const card of ev.cards || []) {
        const zone = isPropertyCard(card)
          ? Z('properties', ev.to, card.placedColor || card.color)
          : Z('bank', ev.to);
        move(card, zone, expected, animate, Z('bank', ev.from));
      }
      break;
    }

    case 'steal':
      claimUpgradesOf(ev.from, expected);
      claimUpgradesOf(ev.actor, expected);
      move(ev.card, Z('properties', ev.actor, ev.toColor), expected, animate, Z('bank', ev.from));
      break;

    case 'set_stolen':
      claimUpgradesOf(ev.from, expected);
      claimUpgradesOf(ev.actor, expected);
      for (const card of ev.cards || []) {
        move(card, Z('properties', ev.actor, ev.color), expected, animate, Z('properties', ev.from, ev.color));
      }
      break;

    case 'swap':
      claimUpgradesOf(ev.actor, expected);
      claimUpgradesOf(ev.target, expected);
      move(ev.took, Z('properties', ev.actor, ev.tookColor), expected, animate);
      move(ev.gave, Z('properties', ev.target, ev.gaveColor), expected, animate);
      break;

    case 'move_property':
      claimUpgradesOf(ev.actor, expected);
      move(ev.card, Z('properties', ev.actor, ev.to), expected, animate);
      break;

    case 'discard':
      for (const card of ev.cards || []) move(card, 'discard', expected, animate, Z('hand', ev.actor));
      break;

    case 'shuffle':
      claimDiscard(expected);                              // discard folds back into the deck
      break;

    case 'scoop':
      claimAllOf(ev.actor, expected);
      claimUpgradesOf(ev.actor, expected);
      break;

    default:
      break;                                               // pure signal events
  }

  bus.emit(EVENTS.CHOREO_SFX, { name: sfx, ev, mine: ev.actor === selfId });
}
