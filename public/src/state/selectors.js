// state/selectors.js — questions the UI asks about the snapshot.
//
// Every legality rule here mirrors game.js. The server re-checks all of it
// (§0.1) — these exist so the client can grey out the illegal move instead of
// firing a message that comes back as a toast with no rebroadcast.

import { store, selfPlayer, playerById } from './store.js';
import {
  COLOR_KEYS, isComplete, zoneFull, requisitionable, legalColorsFor,
  upgradeKinds, upgradeCards, ACTION_NEEDS,
} from '../core/cards.js';

export function snapshot() { return store.snapshot; }

/**
 * The resolved ruleset for THIS game, for the core/cards.js predicates that
 * need it. core/ is dependency-free by design, so the flags are passed in
 * rather than read from the store down there.
 *
 * game.js getPlayerView ships the whole resolved ruleset as `rules`; the flat
 * `setsToWin`/`winRule` aliases are the older shape. With no game on screen
 * there is no ruleset, and the engine's own defaults (RULE_PRESETS.chudopoly)
 * are what a new table gets.
 */
export function activeRuleFlags() {
  const r = store.snapshot?.rules;
  return { pureSetRequired: !!(r && r.pureSetRequired) };
}

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

/**
 * Everything the engine will accept as payment: bank, properties AND upgrades.
 *
 * MUST equal game.js payableCards() (game.js:710-717) card for card. It drives
 * every payment path in interact/index.js, and processPayment() (game.js:1449)
 * only allows a SHORT payment when `selected.length === payable.length` — so a
 * client set that is smaller than the engine's is not a cosmetic difference,
 * it is a softlock: "surrender everything" hands over fewer cards than the
 * engine counts, the short-payment branch refuses, and the pendingAction never
 * clears. Reproduced on a complete zero-value-wild set carrying Upgrade + FOC:
 * netWorth 7, owed 5, every accept refused forever.
 *
 * §3.1b reversed the old rule: upgrades ARE payable, they leave as ordinary
 * cards with `upgradeType`/`placedColor` stripped (game.js:1467-1479), and
 * playerNetWorth() === playerTotalValue() (game.js:706-708) as a result.
 */
export function payableCards(player = selfPlayer()) {
  const out = [];
  for (const card of player?.bank || []) out.push(card);
  for (const color of COLOR_KEYS) for (const card of player?.properties?.[color] || []) out.push(card);
  for (const card of upgradeCards(player)) out.push(card);
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
  const rules = activeRuleFlags();
  return COLOR_KEYS.filter(color => {
    if (!isComplete(me, color, rules)) return false;
    const kinds = upgradeKinds(me, color);
    if (needsHouse && !kinds.includes('house')) return false;
    if (needsNoHouse && kinds.includes('house')) return false;
    if (needsHouse && kinds.includes('hotel')) return false;
    return true;
  });
}

export function completeSetsOf(playerId) {
  const player = playerById(playerId);
  const rules = activeRuleFlags();
  return COLOR_KEYS.filter(color => isComplete(player, color, rules));
}

/**
 * Colours on my board an Upgrade/FOC currently sitting on `fromColor` may be
 * moved to. §3.1b, game.js moveUpgrade() (1517-1541), reached through
 * moveProperty() — it costs NO play, exactly like the wild rearrange, and the
 * engine refuses anything that would leave an FOC without its Upgrade.
 */
export function upgradeMoveColors(cardId) {
  const me = selfPlayer();
  const hit = myUpgradeCard(cardId);
  if (!hit) return [];
  const rules = activeRuleFlags();
  return COLOR_KEYS.filter((color) => {
    if (color === hit.color) return false;                     // 'Already on that set'
    if (!isComplete(me, color, rules)) return false;            // 'is not a complete set'
    const there = upgradeKinds(me, color);
    if (there.includes(hit.kind)) return false;                 // 'already has an Upgrade/FOC'
    // An FOC needs an Upgrade waiting for it; an Upgrade cannot leave its FOC stranded.
    if (hit.kind === 'hotel' && !there.includes('house')) return false;
    if (hit.kind === 'house' && upgradeKinds(me, hit.color).includes('hotel')) return false;
    return true;
  });
}

/**
 * The one question the free-rearrange path asks: "this card is already on my
 * board — where may it go, for no play?" Both answers route through the same
 * `move_property` command (game.js moveProperty():1543-1548 checks findUpgrade()
 * first), so the client has one route too.
 * @returns {{card:object, from:string, colors:string[], isUpgrade:boolean}|null}
 */
export function boardMoveTarget(cardId) {
  const up = myUpgradeCard(cardId);
  if (up) {
    return { card: up.card, from: up.color, colors: upgradeMoveColors(cardId), isUpgrade: true };
  }
  const mine = myPropertyCard(cardId);
  if (mine && mine.card.type === 'wild_property') {
    return { card: mine.card, from: mine.color, colors: moveColors(mine.card, mine.color), isUpgrade: false };
  }
  return null;
}

/** An Upgrade/FOC of mine, by card id — game.js findUpgrade(). */
export function myUpgradeCard(cardId) {
  const me = selfPlayer();
  for (const color of COLOR_KEYS) {
    for (const card of me?.upgrades?.[color] || []) {
      if (card && card.id === cardId) return { card, color, kind: card.upgradeType };
    }
  }
  return null;
}

/**
 * Cards on `playerId`'s board that `action` may take.
 *
 * §3.1 reversed 2026-08-06: TDY Orders is now guarded on BOTH sides, exactly
 * like Midnight Requisition — playAction case 'tdy_orders' (game.js:1123-1126)
 * runs zoneRequisitionable() over the target's zone AND over mine. Only CHUD
 * (game.js:1173-1190) can still reach into a complete set. Leaving TDY out of
 * this guard made complete-set cards glow as legal targets and then fail with
 * "TDY Orders cannot touch a complete set".
 */
const SET_SAFE = new Set(['midnight_requisition', 'tdy_orders']);

export function stealableCards(playerId, action) {
  const player = playerById(playerId);
  const rules = activeRuleFlags();
  const out = [];
  for (const color of COLOR_KEYS) {
    if (SET_SAFE.has(action) && !requisitionable(player, color, rules)) continue;
    for (const card of player?.properties?.[color] || []) out.push({ card, color });
  }
  return out;
}

/** My own properties TDY Orders may offer: the same zoneRequisitionable() guard,
 *  applied to my side of the trade (game.js:1123). */
export function tradeableProps(player = selfPlayer()) {
  const rules = activeRuleFlags();
  const out = [];
  for (const color of COLOR_KEYS) {
    if (!requisitionable(player, color, rules)) continue;
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
        // §3.1c — Surge Operations STACKS. playAction case 'surge_ops'
        // (game.js:1165-1171) increments a counter unconditionally and never
        // refuses; chargeAmount() (game.js:994-1000) multiplies by 2**stack.
        // The old guard blocked a legal, deliberate ×4 play.
        case 'surge_ops': return '';
        case 'inspector_general':
          return opponents().some(p => completeSetsOf(p.id).length) ? '' : 'Nobody has a complete set to seize';
        case 'midnight_requisition':
          return opponents().some(p => stealableCards(p.id, 'midnight_requisition').length) ? '' : 'No loose property to requisition';
        case 'chud':
          return opponents().some(p => stealableCards(p.id, 'chud').length) ? '' : 'Nobody has a property to commandeer';
        case 'tdy_orders':
          // Both sides are guarded now (game.js:1123-1126), so "a property"
          // is not enough on either board — it has to be one that is not in a
          // complete set.
          return tradeableProps(me).length
            && opponents().some(p => stealableCards(p.id, 'tdy_orders').length)
            ? '' : 'You and a target each need a property outside a complete set';
        case 'roll_call':
        case 'finance_office':
          return opponents().length ? '' : 'No one to charge';
        default: return '';
      }
    default: return '';
  }
}
