// state/selectors.js — questions the UI asks about the snapshot.
//
// Every legality rule here mirrors game.js. The server re-checks all of it
// (§0.1) — these exist so the client can grey out the illegal move instead of
// firing a message that comes back as a toast with no rebroadcast.

import { store, selfPlayer, playerById } from './store.js';
import {
  COLOR_KEYS, isComplete, zoneFull, requisitionable, legalColorsFor,
  upgradeKinds, ACTION_NEEDS,
} from '../core/cards.js';

export function snapshot() { return store.snapshot; }

export function myHand() {
  const me = selfPlayer();
  return Array.isArray(me?.hand) ? me.hand : [];
}

export function handIndexOf(cardId) {
  return myHand().findIndex(c => c.id === cardId);
}

export function handCard(cardId) {
  return myHand().find(c => c.id === cardId) || null;
}

export function hasOpsec() {
  return myHand().some(c => c.action === 'opsec');
}

/** Bank + properties: what the engine will accept as payment (upgrades never). */
export function payableCards(player = selfPlayer()) {
  const out = [];
  for (const card of player?.bank || []) out.push(card);
  for (const color of COLOR_KEYS) for (const card of player?.properties?.[color] || []) out.push(card);
  return out;
}

/** Any card the snapshot can see, wherever it is. Powers the details sheet. */
export function findCard(cardId) {
  const snap = store.snapshot;
  if (!snap) return null;
  for (const player of snap.players || []) {
    for (const card of player.hand || []) if (card.id === cardId) return card;
    for (const card of player.bank || []) if (card.id === cardId) return card;
    for (const color of COLOR_KEYS) {
      for (const card of player.properties?.[color] || []) if (card.id === cardId) return card;
      for (const card of player.upgrades?.[color] || []) if (card.id === cardId) return card;
    }
  }
  return (snap.discardPile || []).find(c => c.id === cardId) || null;
}

export function myPropertyCard(cardId) {
  const me = selfPlayer();
  for (const color of COLOR_KEYS) {
    const found = (me?.properties?.[color] || []).find(c => c.id === cardId);
    if (found) return { card: found, color };
  }
  return null;
}

export function opponents() {
  const snap = store.snapshot;
  return (snap?.players || []).filter(p => p.id !== store.self.id && !p.eliminated);
}

/** My pending-action entry, or null. `depth % 2 === 1` means I am the attacker
 *  answering an OPSEC — accepting there means the action is BLOCKED. */
export function myPendingEntry() {
  const pa = store.snapshot?.pendingAction;
  if (!pa?.targets) return null;
  return pa.targets.find(t => t.responderId === store.self.id) || null;
}

export function iMustRespond() {
  return (store.snapshot?.responders || []).includes(store.self.id);
}

/** True when accepting means "pay/suffer"; false when accepting means "blocked". */
export function acceptMeansSuffer(entry = myPendingEntry()) {
  return !!entry && entry.depth % 2 === 0;
}

export function owedAmount() {
  const pa = store.snapshot?.pendingAction;
  const entry = myPendingEntry();
  if (!pa || pa.type !== 'payment' || !entry || !acceptMeansSuffer(entry)) return 0;
  return pa.amount || 0;
}

export function canPlay() {
  const snap = store.snapshot;
  return !!snap && snap.phase === 'playing' && snap.turnPhase === 'play'
    && snap.currentPlayerId === store.self.id && snap.playsRemaining > 0;
}

/**
 * DEAD as of the automatic turn draw (game.js beginTurn, 65e36ef): the engine
 * draws for every seat inside the same synchronous call that starts the turn,
 * so `turnPhase` is never broadcast as 'draw' and this is never true. Kept as
 * the single place that would notice a server which still hands out a draw
 * phase, rather than deleted and re-guessed by three call sites.
 */
export function canDraw() {
  const snap = store.snapshot;
  return !!snap && snap.phase === 'playing' && snap.turnPhase === 'draw'
    && snap.currentPlayerId === store.self.id;
}

/** Colours a hand property/wild may legally be placed on right now. */
export function placementColors(card) {
  const me = selfPlayer();
  return legalColorsFor(card).filter(color => !zoneFull(me, color));
}

/** Colours a wild ALREADY on my board may be moved to (free rearrange, §3.8). */
export function moveColors(card, fromColor) {
  const me = selfPlayer();
  return legalColorsFor(card).filter(color => color !== fromColor && !zoneFull(me, color));
}

/** Colours a rent card can charge on: card-legal AND I own at least one. */
export function rentColors(card) {
  const me = selfPlayer();
  const legal = card.colors?.[0] === 'any' ? COLOR_KEYS : (card.colors || []);
  return legal.filter(color => (me?.properties?.[color] || []).length > 0);
}

export function myCompleteSets({ needsHouse = false, needsNoHouse = false } = {}) {
  const me = selfPlayer();
  return COLOR_KEYS.filter(color => {
    if (!isComplete(me, color)) return false;
    const kinds = upgradeKinds(me, color);
    if (needsHouse && !kinds.includes('house')) return false;
    if (needsNoHouse && kinds.includes('house')) return false;
    if (needsHouse && kinds.includes('hotel')) return false;
    return true;
  });
}

export function completeSetsOf(playerId) {
  const player = playerById(playerId);
  return COLOR_KEYS.filter(color => isComplete(player, color));
}

/** Cards on `playerId`'s board that `action` may take. */
export function stealableCards(playerId, action) {
  const player = playerById(playerId);
  const out = [];
  for (const color of COLOR_KEYS) {
    if (action === 'midnight_requisition' && !requisitionable(player, color)) continue;
    for (const card of player?.properties?.[color] || []) out.push({ card, color });
  }
  return out;
}

/**
 * What the client must collect before play_action is legal.
 * Returns null when the card cannot be played from the strip at all.
 */
export function requirementsFor(card) {
  if (!card) return null;
  if (card.type === 'rent') {
    const needs = ['myColor'];
    if (card.colors?.[0] === 'any') needs.push('player');
    return needs;
  }
  if (card.type !== 'action') return null;
  const needs = ACTION_NEEDS[card.action];
  if (needs == null) return null;
  return needs.slice();
}

/**
 * Why `canPlay()` is false, in the engine's own words. playAction/playProperty/
 * playAsMoney all reject in this order, so the sentence a player is shown is the
 * error they would have got: "Not your turn" / "Cannot play now" (turnPhase) /
 * "Resolve pending action first" / "No plays remaining".
 * One flat "Not your turn to play" for all four was measured as the client's
 * entire refusal vocabulary (§P7.3) — it is wrong three times out of four.
 */
export function cannotPlayReason() {
  const snap = store.snapshot;
  if (!snap || snap.phase !== 'playing') return 'The game is not running';
  if (snap.currentPlayerId !== store.self.id) {
    return `It is ${playerById(snap.currentPlayerId)?.name || 'someone else'}'s turn`;
  }
  if (snap.pendingAction) return 'Resolve the card on the table first';
  if (snap.turnPhase !== 'play') return 'You cannot play right now';
  if (snap.playsRemaining <= 0) return 'No plays left this turn — end your turn';
  return 'You cannot play right now';
}

/** Would this play be refused by the engine right now? Returns a reason or ''. */
export function blockedReason(card) {
  const me = selfPlayer();
  if (!canPlay()) return cannotPlayReason();
  switch (card.type) {
    case 'money':
      // playAsMoney is the ONLY legal move for these; an enabled Play button
      // here is a dead end the player can hammer forever.
      return 'Money cards are banked, not played';
    case 'property':
    case 'wild_property':
      return placementColors(card).length ? '' : 'Every legal set is already full';
    case 'rent':
      return rentColors(card).length ? '' : 'You own no property of that colour';
    case 'action':
      switch (card.action) {
        case 'opsec': return 'OPSEC is played in response, not on your turn';
        case 'upgrade': return myCompleteSets({ needsNoHouse: true }).length ? '' : 'Needs a complete set without an Upgrade';
        case 'foc': return myCompleteSets({ needsHouse: true }).length ? '' : 'Needs a complete set that already has an Upgrade';
        case 'surge_ops': return store.snapshot?.surgeOps ? 'Surge Operations is already active' : '';
        case 'inspector_general':
          return opponents().some(p => completeSetsOf(p.id).length) ? '' : 'Nobody has a complete set to seize';
        case 'midnight_requisition':
          return opponents().some(p => stealableCards(p.id, 'midnight_requisition').length) ? '' : 'No loose property to requisition';
        case 'chud':
          return opponents().some(p => stealableCards(p.id, 'chud').length) ? '' : 'Nobody has a property to commandeer';
        case 'tdy_orders':
          return payableProps(me).length && opponents().some(p => stealableCards(p.id, 'chud').length)
            ? '' : 'You and a target both need a property';
        case 'roll_call':
        case 'finance_office':
          return opponents().length ? '' : 'No one to charge';
        default: return '';
      }
    default: return '';
  }
}

function payableProps(player) {
  const out = [];
  for (const color of COLOR_KEYS) for (const card of player?.properties?.[color] || []) out.push(card);
  return out;
}
