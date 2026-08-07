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
  blockableByOpsec, isPropertyCard, upgradeKinds,
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

/** calcRent() in game.js: rent[min(count,len)-1], +3 house, +4 hotel. cards.js
 *  rentFor() mirrors it, so these numbers are the ones the engine will charge. */
function rentContext(card) {
  const me = selfPlayer();
  const colors = sel.rentColors(card);
  const out = [];
  const wild = card.colors?.[0] === 'any';
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
    out.push(row(`${colorName(color)} (${held}/${setSize(color)})`,
      `${rentFor(me, color)}M${extra}`, 'good'));
  }
  if (store.snapshot?.surgeOps) out.push(row('Surge Operations', 'this charge is DOUBLED', 'hot'));
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
  for (const c of colors) {
    const held = me?.properties?.[c]?.length || 0;
    if (!color && !held) continue;                       // don't list ten empty columns
    const size = setSize(c);
    const done = held >= size;
    out.push(row(`${colorName(c)}`,
      done ? `${held}/${size} — COMPLETE · rent ${rentFor(me, c)}M`
        : `${held}/${size} · rent ${rentFor(me, c) || 0}M`,
      done ? 'good' : ''));
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
      const mine = COLOR_KEYS.reduce((n, c) => n + (me?.properties?.[c]?.length || 0), 0);
      out.push(row('You can offer', `${mine} propert${mine === 1 ? 'y' : 'ies'}`,
        mine ? '' : 'bad'));
      break;
    }
    case 'finance_office':
    case 'roll_call': {
      const n = sel.opponents().length;
      const each = card.action === 'roll_call' ? 2 : 5;
      const doubled = store.snapshot?.surgeOps;
      out.push(row('Collects', card.action === 'roll_call'
        ? `${doubled ? each * 2 : each}M from each of ${n}`
        : `${doubled ? each * 2 : each}M from one player`, doubled ? 'hot' : 'good'));
      break;
    }
    case 'surge_ops':
      out.push(store.snapshot?.surgeOps
        ? row('Right now', 'already active — the next charge is doubled', 'hot')
        : row('Effect', 'the next charge you make this turn is doubled'));
      break;
    case 'opsec': {
      const n = sel.myHand().filter(c => c.action === 'opsec').length;
      out.push(row('In your hand', `${n} OPSEC`, n ? 'good' : ''));
      break;
    }
    default: break;
  }
  return out;
}

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

export function show(card) {
  if (!card) return;
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
  if (blockableByOpsec(card)) {
    tags.appendChild(el('span', { class: 'dt-tag is-block', text: 'OPSEC can cancel it' }));
  } else if (card.type === 'action' && card.action !== 'opsec') {
    tags.appendChild(el('span', { class: 'dt-tag', text: 'OPSEC cannot touch it' }));
  }
  if (card.placedColor && COLORS[card.placedColor]) {
    tags.appendChild(el('span', { class: 'dt-tag', text: `On ${colorName(card.placedColor)}` }));
  }
  // playerTotalValue()/payableCards() exclude upgrades — say so where it matters.
  if (card.upgradeType) {
    tags.appendChild(el('span', { class: 'dt-tag', text: 'Never payable · counts in net worth' }));
  }
  if (tags.children.length) body.appendChild(tags);

  const why = sel.handCard(card.id) ? sel.blockedReason(card) : '';
  if (why) body.appendChild(el('p', { class: 'dt-why', text: why }));

  openSheet(cardName(card), body);
}
