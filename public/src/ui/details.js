// ui/details.js — the card details sheet.
//
// §5: tapping (or long-pressing) a card must never hide data behind a hover the
// phone cannot do. So the sheet carries the full rule AND what that rule is
// worth right now — a rent card shows the rent you would actually charge with
// the board as it stands, computed from the snapshot through the same selectors
// the interaction machine uses. No game logic lives here.

import { el } from '../core/dom.js';
import { store, selfPlayer } from '../state/store.js';
import * as sel from '../state/selectors.js';
import {
  COLORS, COLOR_KEYS, cardName, cardText, colorName, rentFor, setSize,
  opsecFlag, isPropertyCard, upgradeKinds, isComplete,
} from '../core/cards.js';
import { openSheet } from './screens.js';

const row = (label, value, kind = '') =>
  el('div', { class: `dt-row${kind ? ` is-${kind}` : ''}` }, [
    el('span', { class: 'dt-label', text: label }),
    el('span', { class: 'dt-value', text: value }),
  ]);

function kindText(card) {
  const type = String(card.type || '').replace(/_/g, ' ');
  return `${type} · ${card.value ?? 0}M face value`;
}

/* ── live context per card kind ──────────────────────────────────────────── */

/**
 * The live Surge Operations multiplier, straight off the snapshot.
 *
 * §3.1c — `state._surgeOps` is a COUNTER, not a boolean, and getPlayerView
 * ships both `surgeOps` (the count) and `surgeMultiplier` (2**count,
 * game.js:1809-1810). Two stacked copies are x4, not x2. Reading `surgeOps` as
 * a boolean and writing "DOUBLED" printed the wrong number for every stack
 * above one — and `surgeMultiplier` was shipped and never read.
 */
function surgeMultiplier() {
  const snap = store.snapshot;
  const m = Number(snap?.surgeMultiplier);
  if (Number.isFinite(m) && m >= 1) return Math.round(m);
  return 2 ** (Number(snap?.surgeOps) || 0);       // older broadcast shape
}

/** calcRent() in game.js: rent[min(count,len)-1], +3 house, +4 hotel. cards.js
 *  rentFor() mirrors it. chargeAmount() (game.js:994-1000) then multiplies the
 *  RENT branch — and only the rent branch — by the Surge stack, so these are
 *  the numbers the engine will actually charge. */
function rentContext(card) {
  const me = selfPlayer();
  const colors = sel.rentColors(card);
  const out = [];
  const wild = card.colors?.[0] === 'any';
  const mult = surgeMultiplier();
  out.push(row('Bills', wild ? 'one player you name' : 'every other player'));
  if (!colors.length) {
    out.push(row('Right now', 'you own none of these colours — unplayable', 'bad'));
    return out;
  }
  for (const color of colors) {
    const held = me?.properties?.[color]?.length || 0;
    const kinds = upgradeKinds(me, color);
    const extra = kinds.includes('hotel') ? ' incl. FOC'
      : kinds.includes('house') ? ' incl. Upgrade' : '';
    const base = rentFor(me, color);
    out.push(row(`${colorName(color)} (${held}/${setSize(color)})`,
      mult > 1 ? `${base * mult}M — ${base}M x${mult}${extra}` : `${base}M${extra}`,
      mult > 1 ? 'hot' : 'good'));
  }
  if (mult > 1) {
    const n = Number(store.snapshot?.surgeOps) || 0;
    out.push(row('Surge Operations',
      `${n} stacked — this rent is x${mult}`, 'hot'));
  }
  return out;
}

function propertyContext(card) {
  const me = selfPlayer();
  const color = card.placedColor || card.color
    || (card.colors?.[0] === 'any' ? null : card.colors?.[0]);
  const out = [];
  if (card.type === 'wild_property') {
    out.push(row('Counts as', card.colors?.[0] === 'any'
      ? 'any colour' : card.colors.map(colorName).join(' or ')));
  }
  const colors = color ? [color] : (card.colors?.[0] === 'any' ? COLOR_KEYS : card.colors || []);
  // COMPLETE is the SET question, and `held >= size` is not it. game.js zoneIsSet()
  // (351-356) takes at least one real property when `pureSetRequired` is on (the MD
  // Faithful preset), so a full zone of nothing but wilds is a full zone and NOT a
  // set. Measured: two "any" wilds in Command printed "Command 2/2 — COMPLETE ·
  // rent 8M" while the engine's completedSets for that seat was 0.
  const rules = sel.activeRuleFlags();
  for (const c of colors) {
    const held = me?.properties?.[c]?.length || 0;
    if (!color && !held) continue;                       // don't list ten empty columns
    const size = setSize(c);
    const done = isComplete(me, c, rules);
    const full = held >= size;
    out.push(row(`${colorName(c)}`,
      done ? `${held}/${size} — COMPLETE · rent ${rentFor(me, c)}M`
        : full
          // The state that has no name on the board: nothing more fits, and it is
          // still not a set. Say WHY, because the rule is a lobby toggle and the
          // player may not know it is on.
          ? `${held}/${size} — FULL, not a set: needs one real property · rent ${rentFor(me, c)}M`
          : `${held}/${size} · rent ${rentFor(me, c) || 0}M`,
      done ? 'good' : (full ? 'bad' : '')));
  }
  return out;
}

function actionContext(card) {
  const me = selfPlayer();
  const out = [];
  switch (card.action) {
    case 'upgrade': {
      const ok = sel.myCompleteSets({ needsNoHouse: true });
      out.push(ok.length
        ? row('Can go on', ok.map(colorName).join(', '), 'good')
        : row('Right now', 'no complete set is waiting for an Upgrade', 'bad'));
      break;
    }
    case 'foc': {
      const ok = sel.myCompleteSets({ needsHouse: true });
      out.push(ok.length
        ? row('Can go on', ok.map(colorName).join(', '), 'good')
        : row('Right now', 'needs a complete set that already has an Upgrade', 'bad'));
      break;
    }
    case 'inspector_general': {
      const hits = sel.opponents().filter(p => sel.completeSetsOf(p.id).length);
      out.push(hits.length
        ? row('Complete sets on the table', hits.map(p =>
          `${p.name} (${sel.completeSetsOf(p.id).map(colorName).join(', ')})`).join(' · '), 'good')
        : row('Right now', 'nobody has a complete set to seize', 'bad'));
      break;
    }
    case 'midnight_requisition':
    case 'chud': {
      const hits = sel.opponents()
        .map(p => ({ p, n: sel.stealableCards(p.id, card.action).length }))
        .filter(x => x.n);
      out.push(hits.length
        ? row('Reachable properties', hits.map(x => `${x.p.name} ${x.n}`).join(' · '), 'good')
        : row('Right now', 'nothing it can take', 'bad'));
      break;
    }
    case 'tdy_orders': {
      // Both sides are guarded (game.js:1123-1126) — a card sitting in one of
      // my complete sets is not something I can offer.
      const mine = sel.tradeableProps(me).length;
      out.push(row('You can offer', `${mine} propert${mine === 1 ? 'y' : 'ies'} outside a set`,
        mine ? '' : 'bad'));
      const reach = sel.opponents()
        .map(p => ({ p, n: sel.stealableCards(p.id, 'tdy_orders').length })).filter(x => x.n);
      out.push(reach.length
        ? row('You can take', reach.map(x => `${x.p.name} ${x.n}`).join(' · '), 'good')
        : row('Right now', 'no opponent has a property outside a complete set', 'bad'));
      break;
    }
    case 'finance_office':
    case 'roll_call': {
      // chargeAmount() (game.js:994-1000) passes surgeable:true from the RENT
      // branch ONLY. These two are flat at every Surge stack depth — verified
      // against the engine at 0, 1 and 2 stacked copies.
      const n = sel.opponents().length;
      const each = card.action === 'roll_call' ? 2 : 5;
      out.push(row('Collects', card.action === 'roll_call'
        ? `${each}M from each of ${n}`
        : `${each}M from one player`, 'good'));
      if (surgeMultiplier() > 1) {
        out.push(row('Surge Operations', 'does not apply — rent only', ''));
      }
      break;
    }
    case 'surge_ops': {
      // §3.1c: it stacks, and playAction never refuses a second copy. The Effect row
      // used to be hard-coded "x2" and sat two lines above "makes it x8" — so the
      // sheet contradicted itself on the one card whose whole point is that it
      // stacks. It states what playing THIS copy would actually do, from the live
      // stack: chargeAmount() (game.js:994-1000) multiplies by 2**stack.
      const n = Number(store.snapshot?.surgeOps) || 0;
      const next = 2 ** (n + 1);
      out.push(row('Effect', `play it and your next RENT this turn is x${next} — rent only, `
        + 'not Finance Office or Roll Call', n ? 'hot' : ''));
      if (n) {
        out.push(row('Already running', `${n} stacked (x${surgeMultiplier()}) — `
          + `playing this one makes it x${next}`, 'hot'));
      }
      break;
    }
    case 'opsec': {
      const n = sel.myHand().filter(c => c.action === 'opsec').length;
      out.push(row('In your hand', `${n} OPSEC`, n ? 'good' : ''));
      break;
    }
    default: break;
  }
  return out;
}

/** The live "what is this worth right now" rows. ui/peek.js renders the same
 *  ones, so the hover/hold peek and the full sheet can never disagree. */
export function contextRows(card) { return card ? context(card) : []; }

function context(card) {
  if (!store.snapshot || !selfPlayer()) return [];
  if (card.type === 'rent') return rentContext(card);
  if (isPropertyCard(card)) return propertyContext(card);
  if (card.type === 'action') return actionContext(card);
  if (card.type === 'money') {
    const me = selfPlayer();
    return [row('Your bank', `${me?.bankValue ?? 0}M`)];
  }
  return [];
}

/* ── the sheet ───────────────────────────────────────────────────────────── */

/**
 * The details CONTENT, without the sheet around it. Exported because the
 * discard browser (ui/discard.js) has to read a card INSIDE an open sheet —
 * openSheet() would replace the browser the player is standing in. Same body,
 * same live context, so the inline reader and the sheet can never disagree.
 */
export function detailBody(card) {
  if (!card) return null;
  const body = el('div', { class: 'details' });
  body.appendChild(el('p', { class: 'details-kind', text: kindText(card) }));
  body.appendChild(el('p', { class: 'details-rule', text: cardText(card) }));

  const live = context(card);
  if (live.length) {
    body.appendChild(el('h5', { class: 'brief-sub', text: 'On the table right now' }));
    const box = el('div', { class: 'dt-rows' });
    for (const node of live) box.appendChild(node);
    body.appendChild(box);
  }

  const tags = el('div', { class: 'dt-tags' });
  // §P7.15 — one source for this sentence, so the OPSEC card can no longer be
  // flagged "OPSEC cannot touch it" directly under its own counter-OPSEC rule.
  if (card.type === 'action' || card.type === 'rent') {
    const flag = opsecFlag(card);
    tags.appendChild(el('span', { class: `dt-tag is-${flag.kind}`, text: flag.text }));
  }
  if (card.placedColor && COLORS[card.placedColor]) {
    tags.appendChild(el('span', { class: 'dt-tag', text: `On ${colorName(card.placedColor)}` }));
  }
  // §3.1b — payableCards() (game.js:710-717) INCLUDES upgrades and
  // playerNetWorth() === playerTotalValue() (game.js:706-708), so there is no
  // net-worth-but-not-payable split left to warn about. What is worth saying is
  // the two rules that did change: it banks on a break (bankUpgradeCard(),
  // game.js:783) and it relocates free (moveUpgrade(), game.js:1517-1541).
  if (card.upgradeType) {
    tags.appendChild(el('span', { class: 'dt-tag', text: 'Payable · banks if the set breaks' }));
    const moves = sel.upgradeMoveColors(card.id);
    if (moves.length) {
      tags.appendChild(el('span', {
        class: 'dt-tag',
        text: `Moves free to ${moves.map(colorName).join(', ')}`,
      }));
    }
  }
  if (tags.children.length) body.appendChild(tags);

  const why = sel.handCard(card.id) ? sel.blockedReason(card) : '';
  if (why) body.appendChild(el('p', { class: 'dt-why', text: why }));
  return body;
}

export function show(card) {
  const body = detailBody(card);
  if (!body) return;
  openSheet(cardName(card), body);
}
