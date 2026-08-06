// core/cards.js — card + colour metadata for the CLIENT.
//
// Mirror of the COLORS table in game.js. It is duplicated rather than imported
// because game.js is CommonJS running on the server and §0.2 forbids a build
// step that could share it. game.js is the source of truth: if a set size or
// rent ladder disagrees, game.js wins and this file is the bug.
//
// The client needs it for three things the broadcast does not carry:
//   • set completeness per colour (game.completedSets is a COUNT, not a list)
//   • rent ladders shown on card faces and set columns
//   • which colours a wild may legally occupy

export const COLORS = Object.freeze({
  brown:     { name: 'Drone Ops',      short: 'DRONE',   size: 2, rent: [1, 2],       hue: '#8B4513', ink: '#fff' },
  lightblue: { name: 'Training',       short: 'TRAIN',   size: 3, rent: [1, 2, 3],    hue: '#87CEEB', ink: '#000' },
  pink:      { name: 'Space Force',    short: 'SPACE',   size: 3, rent: [1, 2, 4],    hue: '#FF69B4', ink: '#000' },
  orange:    { name: 'Test & Eval',    short: 'T&E',     size: 3, rent: [1, 3, 5],    hue: '#FF8C00', ink: '#000' },
  red:       { name: 'Fighters',       short: 'FIGHT',   size: 3, rent: [2, 3, 6],    hue: '#DC143C', ink: '#fff' },
  yellow:    { name: 'Mobility',       short: 'MOBIL',   size: 3, rent: [2, 4, 6],    hue: '#FFD700', ink: '#000' },
  green:     { name: 'Elite Programs', short: 'ELITE',   size: 3, rent: [2, 4, 7],    hue: '#228B22', ink: '#fff' },
  darkblue:  { name: 'Command',        short: 'CMD',     size: 2, rent: [3, 8],       hue: '#00308F', ink: '#fff' },
  base:      { name: 'Overseas Bases', short: 'BASES',   size: 4, rent: [1, 2, 3, 4], hue: '#2F4F4F', ink: '#fff' },
  intel:     { name: 'Intelligence',   short: 'INTEL',   size: 2, rent: [1, 2],       hue: '#708090', ink: '#fff' },
});

export const COLOR_KEYS = Object.freeze(Object.keys(COLORS));

export const HAND_LIMIT = 7;
export const SETS_TO_WIN = 3;

/** Which actions need what before play_action is legal (mirrors game.js playAction). */
export const ACTION_NEEDS = Object.freeze({
  pcs_orders:            [],
  surge_ops:             [],
  roll_call:             [],
  finance_office:        ['player'],
  inspector_general:     ['player', 'theirSet'],
  midnight_requisition:  ['player', 'theirCard'],
  chud:                  ['player', 'theirCard'],
  tdy_orders:            ['myCard', 'player', 'theirCard'],
  upgrade:               ['mySet'],
  foc:                   ['mySet'],
  opsec:                 null,          // response-only; never played from the strip
});

export function colorName(color) { return COLORS[color]?.name || color || '—'; }
export function setSize(color) { return COLORS[color]?.size || 0; }

export function isComplete(player, color) {
  const size = setSize(color);
  return size > 0 && (player?.properties?.[color]?.length || 0) >= size;
}

export function completeColors(player) {
  const out = [];
  for (const color of COLOR_KEYS) if (isComplete(player, color)) out.push(color);
  return out;
}

/** A zone holds at most `size` property cards (§3.5). */
export function zoneFull(player, color) {
  const size = setSize(color);
  return size === 0 || (player?.properties?.[color]?.length || 0) >= size;
}

/** Midnight Requisition may not touch a zone that is exactly a complete set. */
export function requisitionable(player, color) {
  const size = setSize(color);
  const n = player?.properties?.[color]?.length || 0;
  return n > 0 && n !== size;
}

export function legalColorsFor(card) {
  if (!card) return [];
  if (card.type === 'property') return [card.color];
  if (!card.colors) return [];
  return card.colors[0] === 'any' ? COLOR_KEYS.slice() : card.colors.slice();
}

export function rentFor(player, color) {
  const info = COLORS[color];
  if (!info) return 0;
  const count = player?.properties?.[color]?.length || 0;
  if (count === 0) return 0;
  let rent = info.rent[Math.min(count, info.rent.length) - 1];
  const kinds = upgradeKinds(player, color);
  if (kinds.includes('house')) rent += 3;
  if (kinds.includes('hotel')) rent += 4;
  return rent;
}

export function upgradeKinds(player, color) {
  return (player?.upgrades?.[color] || []).map(u => (typeof u === 'string' ? u : u?.upgradeType));
}

export function isPropertyCard(card) {
  return card?.type === 'property' || card?.type === 'wild_property';
}

/** Short label for the card's kind, used on the type band of the face. */
export function kindLabel(card) {
  if (!card) return '';
  switch (card.type) {
    case 'money': return 'BANK';
    case 'property': return COLORS[card.color]?.short || 'PROPERTY';
    case 'wild_property': return card.colors?.[0] === 'any' ? 'WILD · ANY' : 'WILD';
    case 'rent': return card.colors?.[0] === 'any' ? 'RENT · ANY' : 'RENT';
    case 'action': return card.action === 'chud' ? 'CHUD' : 'ACTION';
    default: return String(card.type || '').toUpperCase();
  }
}

/** Human sentence for what a card does — the help/details text (§3.9). */
export function cardText(card) {
  if (!card) return '';
  if (card.description) return card.description;
  if (card.type === 'money') return `Bank it for ${card.value}M of paying power.`;
  if (card.type === 'property') {
    const info = COLORS[card.color];
    return info
      ? `${info.name} — ${info.size} to complete. Rent ladder ${info.rent.join(' / ')}M.`
      : 'Property.';
  }
  if (card.type === 'wild_property') {
    return card.colors?.[0] === 'any'
      ? 'Counts as any colour. Worth 0M as payment — that is its cost.'
      : `Counts as ${card.colors.map(colorName).join(' or ')}.`;
  }
  if (card.type === 'rent') {
    return card.colors?.[0] === 'any'
      ? 'Charge rent on any one of your colours, from ONE player you choose.'
      : `Charge every player rent on your ${card.colors.map(colorName).join(' or ')}.`;
  }
  return '';
}
