// game.js — Card definitions, deck builder, and all game rules for Chudopoly GO

const COLORS = {
  brown:     { name:'Drone Ops',       bg:'#8B4513', fg:'#fff', size:2, rent:[1,2] },
  lightblue: { name:'Training',        bg:'#87CEEB', fg:'#000', size:3, rent:[1,2,3] },
  pink:      { name:'Space Force',     bg:'#FF69B4', fg:'#000', size:3, rent:[1,2,4] },
  orange:    { name:'Test & Eval',     bg:'#FF8C00', fg:'#000', size:3, rent:[1,3,5] },
  red:       { name:'Fighters',        bg:'#DC143C', fg:'#fff', size:3, rent:[2,3,6] },
  yellow:    { name:'Mobility',        bg:'#FFD700', fg:'#000', size:3, rent:[2,4,6] },
  green:     { name:'Elite Programs',  bg:'#228B22', fg:'#fff', size:3, rent:[2,4,7] },
  darkblue:  { name:'Command',         bg:'#00308F', fg:'#fff', size:2, rent:[3,8] },
  base:      { name:'Overseas Bases',  bg:'#2F4F4F', fg:'#fff', size:4, rent:[1,2,3,4] },
  intel:     { name:'Intelligence',    bg:'#708090', fg:'#fff', size:2, rent:[1,2] },
};

const HAND_LIMIT = 7;
const SETS_TO_WIN = 3;
const EVENT_TAIL = 120;          // broadcast tail size (ARCHITECTURE §4)
const EVENT_LOG_MAX = 400;       // retained in state; never grows unbounded

/* ── Card definitions ────────────────────────────────────────────────── */

function buildDeck() {
  let id = 0;
  const cards = [];
  const c = (props) => { cards.push({ id: id++, ...props }); };

  /* Property cards */
  const props = [
    ['brown','Creech AFB',1],['brown','Cannon AFB',1],
    ['lightblue','Lackland AFB (BMT)',1],['lightblue','Keesler AFB',1],['lightblue','Goodfellow AFB',1],
    ['pink','Peterson SFB',2],['pink','Schriever SFB',2],['pink','Buckley SFB',2],
    ['orange','Nellis AFB',2],['orange','Eglin AFB',2],['orange','Edwards AFB',2],
    ['red','F-22 Raptor',3],['red','F-35 Lightning II',3],['red','F-15 Eagle',3],
    ['yellow','KC-135 Stratotanker',3],['yellow','C-17 Globemaster III',3],['yellow','C-130 Hercules',3],
    ['green','Thunderbirds',4],['green','Weapons School',4],['green','Red Flag',4],
    ['darkblue','The Pentagon',4],['darkblue','Air Force One',4],
    ['base','Ramstein AB',2],['base','Kadena AB',2],['base','Osan AB',2],['base','Thule AB',2],
    ['intel','PAVE PAWS Radar',1],['intel','GPS Constellation',1],
  ];
  props.forEach(([color,name,value]) => c({ type:'property', color, name, value }));

  /* Wild property cards */
  c({ type:'wild_property', colors:['any'], name:'Wild Property', value:0 });
  c({ type:'wild_property', colors:['any'], name:'Wild Property', value:0 });
  c({ type:'wild_property', colors:['brown','lightblue'], name:'Wild: Drone/Training', value:1 });
  c({ type:'wild_property', colors:['pink','orange'], name:'Wild: Space/Test', value:2 });
  c({ type:'wild_property', colors:['red','yellow'], name:'Wild: Fighter/Mobility', value:3 });
  c({ type:'wild_property', colors:['green','darkblue'], name:'Wild: Elite/Command', value:4 });
  c({ type:'wild_property', colors:['base','intel'], name:'Wild: Bases/Intel', value:2 });
  c({ type:'wild_property', colors:['base','green'], name:'Wild: Bases/Elite', value:4 });
  c({ type:'wild_property', colors:['lightblue','brown'], name:'Wild: Training/Drone', value:1 });

  /* Money cards */
  for(let i=0;i<6;i++) c({ type:'money', name:'1M', value:1 });
  for(let i=0;i<5;i++) c({ type:'money', name:'2M', value:2 });
  for(let i=0;i<3;i++) c({ type:'money', name:'3M', value:3 });
  for(let i=0;i<3;i++) c({ type:'money', name:'4M', value:4 });
  for(let i=0;i<2;i++) c({ type:'money', name:'5M', value:5 });
  c({ type:'money', name:'10M', value:10 });

  /* Action cards */
  const actions = [
    ['inspector_general','Inspector General',5,'Steal a complete property set from any player. OPSEC can block it.',2],
    ['opsec','OPSEC',4,'Counter any action card played against you. Can itself be countered by another OPSEC.',3],
    ['midnight_requisition','Midnight Requisition',3,'Steal a single property from any player. Cannot touch a complete set.',3],
    ['tdy_orders','TDY Orders',3,'Swap one of your properties for one of another player\'s',3],
    ['finance_office','Finance Office',3,'Collect 5M from any one player',3],
    ['roll_call','Roll Call',2,'All other players pay you 2M each',3],
    ['pcs_orders','PCS Orders',1,'Draw 2 extra cards from the deck',10],
    ['upgrade','Upgrade (House)',3,'Add to a complete set: +3M rent',3],
    ['foc','Full Operational Capability (Hotel)',4,'Add to a complete set with Upgrade: +4M rent',2],
    ['surge_ops','Surge Operations',1,'Double the next charge you make this turn — rent or any demand',2],
  ];
  actions.forEach(([action,name,value,desc,qty]) => {
    for(let i=0;i<qty;i++) c({ type:'action', action, name, value, description:desc });
  });

  /* Rent cards */
  const rents = [
    [['brown','lightblue'],1,2],
    [['pink','orange'],1,2],
    [['red','yellow'],1,2],
    [['green','darkblue'],1,2],
    [['base','intel'],1,2],
    [['any'],3,3],
  ];
  rents.forEach(([colors,value,qty]) => {
    for(let i=0;i<qty;i++) c({ type:'rent', colors, name:'Rent: '+colors.join('/'), value });
  });

  /* THE CHUD CARD — 2 copies. The 2M tax rider is gone (§3.1); the steal is the whole card.
     Face value stays 4M: a 4000-game mixed matrix at value 5 moved no personality by more
     than 0.1 point (conservative 27.3% → 27.2%, all others identical), so §3.1's
     "raise the face value if it still dominates" has nothing to fix. */
  const CHUD_TEXT = 'Commandeer Hardware Under Directive — Steal ANY property from any player, even out of a complete set. OPSEC can block it.';
  c({ type:'action', action:'chud', name:'THE CHUD CARD', value:4, description:CHUD_TEXT });
  c({ type:'action', action:'chud', name:'THE CHUD CARD', value:4, description:CHUD_TEXT });

  return cards;
}

/* ── Seeded RNG (ARCHITECTURE §0.7) ──────────────────────────────────── */

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function sfc32(a, b, c, d) {
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// makeRng(undefined) === Math.random, so the unseeded path is byte-identical to before.
function makeRng(seed) {
  if (seed === undefined || seed === null || seed === '') return Math.random;
  const h = xmur3(String(seed));
  const rand = sfc32(h(), h(), h(), h());
  for (let i = 0; i < 15; i++) rand();
  return rand;
}

function shuffle(arr, rand = Math.random) {
  for (let i=arr.length-1; i>0; i--) {
    const j=Math.floor(rand()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

function rngOf(state) {
  return typeof state?._rng === 'function' ? state._rng : Math.random;
}

/* ── Structured event channel (ARCHITECTURE §4) ──────────────────────── */

function publicCard(card) {
  if (!card) return null;
  const out = { id: card.id, type: card.type, name: card.name, value: card.value };
  if (card.color) out.color = card.color;
  if (card.colors) out.colors = card.colors;
  if (card.action) out.action = card.action;
  if (card.description) out.description = card.description;
  if (card.placedColor) out.placedColor = card.placedColor;
  if (card.upgradeType) out.upgradeType = card.upgradeType;
  return out;
}

function emit(state, t, payload) {
  if (!state.events) { state.events = []; state.eventSeq = state.eventSeq || 0; }
  const ev = { seq: ++state.eventSeq, t, ...payload };
  state.events.push(ev);
  if (state.events.length > EVENT_LOG_MAX) state.events.splice(0, state.events.length - EVENT_LOG_MAX);
  return ev;
}

// Events must leak nothing getPlayerView hides (§10). Only draw/deal carry hand cards.
function redactEvent(ev, playerId) {
  if ((ev.t === 'draw' || ev.t === 'deal') && ev.cards && ev.to !== playerId) {
    const { cards, ...rest } = ev;
    return rest;
  }
  return ev;
}

/* ── Game state ──────────────────────────────────────────────────────── */

function createGame(players, opts = {}) {
  const seed = opts && opts.seed !== undefined ? opts.seed : undefined;
  const rand = makeRng(seed);
  const deck = shuffle(buildDeck(), rand);
  const state = {
    phase: 'playing',
    turnPhase: 'draw',
    currentPlayerIndex: 0,
    playsRemaining: 3,
    deck,
    discardPile: [],
    players: players.map(p => ({
      id: p.id, name: p.name,
      hand: [], bank: [],
      properties: {},
      upgrades: {},
    })),
    pendingAction: null,
    winner: null,
    endReason: null,
    cardTotal: deck.length,
    seed: seed === undefined ? null : seed,
    events: [],
    eventSeq: 0,
    stats: {
      turns: 1,
      cardsPlayed: {},
      payments: { count: 0, total: 0, biggest: 0 },
      propertiesStolen: {},
    },
    log: ['Game started! ' + players.map(p=>p.name).join(', ') + ' are playing.'],
  };
  // Non-enumerable: the RNG must never end up in a broadcast or a JSON snapshot.
  Object.defineProperty(state, '_rng', { value: rand, enumerable: false, writable: true });

  emit(state, 'game_start', {
    order: state.players.map(p => p.id),
    names: Object.fromEntries(state.players.map(p => [p.id, p.name])),
  });

  state.players.forEach(p => {
    const dealt = [];
    for (let i=0; i<5; i++) {
      if (state.deck.length) { const card = state.deck.pop(); p.hand.push(card); dealt.push(card); }
    }
    emit(state, 'deal', { to: p.id, count: dealt.length, cards: dealt.map(publicCard) });
  });

  state._handSnapshot = totalHandCards(state);
  state._idleTurns = 0;
  emit(state, 'turn_start', { actor: currentPlayer(state).id, plays: state.playsRemaining });

  return state;
}

function currentPlayer(state) {
  return state.players[state.currentPlayerIndex];
}

function getPlayer(state, id) {
  return state.players.find(p => p.id === id);
}

function completedSets(player) {
  let count = 0;
  for (const [color, cards] of Object.entries(player.properties)) {
    const info = COLORS[color];
    if (info && cards.length >= info.size) count++;
  }
  return count;
}

function completedColors(player) {
  const set = new Set();
  for (const [color, cards] of Object.entries(player.properties)) {
    const info = COLORS[color];
    if (info && cards.length >= info.size) set.add(color);
  }
  return set;
}

function emitSetChanges(state, player, before) {
  const after = completedColors(player);
  for (const color of after) if (!before.has(color)) emit(state, 'set_completed', { actor: player.id, color });
}

function finishGame(state, winnerId, reason, logLine) {
  if (state.phase !== 'playing') return false;
  state.phase = 'finished';
  state.winner = winnerId;
  state.endReason = reason;
  state.turnPhase = 'finished';
  state.pendingAction = null;
  state.log.push(logLine);
  const winner = winnerId ? getPlayer(state, winnerId) : null;
  const sets = winner ? completedSets(winner) : 0;
  if (reason === 'stalemate') emit(state, 'stalemate', { winner: winnerId, sets, reason: 'deck_dry' });
  else emit(state, 'win', { actor: winnerId, sets, reason });
  return true;
}

function checkWin(state, playerId) {
  if (state.phase !== 'playing') return state.winner === playerId;
  const p = getPlayer(state, playerId);
  if (!p) return false;
  const sets = completedSets(p);
  if (sets >= SETS_TO_WIN) {
    return finishGame(state, playerId, 'sets', p.name + ' wins with ' + sets + ' complete sets!');
  }
  return false;
}

function isSetComplete(player, color) {
  const info = COLORS[color];
  if (!info) return false;
  return (player.properties[color] || []).length >= info.size;
}

// §3.5 — a color zone holds at most `set size` property cards.
function zoneCount(player, color) { return (player.properties[color] || []).length; }
function zoneFull(player, color) {
  const info = COLORS[color];
  return !info || zoneCount(player, color) >= info.size;
}

// Midnight Requisition may not touch a zone that is exactly a complete set.
// A zone that overflowed through a forced transfer (see receiveProperty) is fair game again.
function zoneRequisitionable(player, color) {
  const info = COLORS[color];
  if (!info) return false;
  const n = zoneCount(player, color);
  return n > 0 && n !== info.size;
}

function legalColorsFor(card) {
  if (card.type === 'property') return [card.color];
  if (!card.colors) return [];
  return card.colors[0] === 'any' ? Object.keys(COLORS) : card.colors;
}

// Involuntary transfer (payment / steal / swap). Honors the zone cap where it can;
// a plain property whose only zone is full has nowhere else to go and overflows, which
// zoneRequisitionable() then re-exposes to Midnight Requisition.
function receiveProperty(state, player, card, preferredColor) {
  const legal = legalColorsFor(card);
  const ordered = [];
  if (preferredColor && legal.includes(preferredColor)) ordered.push(preferredColor);
  for (const color of legal.slice().sort((a, b) => zoneCount(player, b) - zoneCount(player, a))) {
    if (!ordered.includes(color)) ordered.push(color);
  }
  let dest = ordered.find(color => !zoneFull(player, color));
  if (!dest) dest = ordered[0] || card.color;
  if (!COLORS[dest]) dest = card.color || Object.keys(COLORS)[0];
  if (!player.properties[dest]) player.properties[dest] = [];
  card.placedColor = dest;
  player.properties[dest].push(card);
  return dest;
}

function calcRent(player, color) {
  const info = COLORS[color];
  if (!info) return 0;
  const count = (player.properties[color] || []).length;
  if (count === 0) return 0;
  let rent = info.rent[Math.min(count, info.rent.length) - 1];
  const upgrades = upgradeKinds(player, color);
  if (upgrades.includes('house')) rent += 3;
  if (upgrades.includes('hotel')) rent += 4;
  return rent;
}

// Value a player can actually hand over. Upgrades are never payable (§3.7).
function playerTotalValue(player) {
  let total = 0;
  player.bank.forEach(c => total += c.value);
  for (const cards of Object.values(player.properties))
    cards.forEach(c => total += c.value);
  return total;
}

function playerUpgradeValue(player) {
  let total = 0;
  for (const upgrades of Object.values(player.upgrades || {}))
    for (const u of upgrades) total += (u && typeof u === 'object' ? u.value : 0) || 0;
  return total;
}

// §3.7 — upgrades are off-limits as payment but must be visible in net worth.
function playerNetWorth(player) {
  return playerTotalValue(player) + playerUpgradeValue(player);
}

function payableCards(player) {
  const out = [];
  player.bank.forEach(c => out.push(c));
  for (const cards of Object.values(player.properties)) cards.forEach(c => out.push(c));
  return out;
}

function totalHandCards(state) {
  return state.players.reduce((sum, p) => sum + p.hand.length, 0);
}

function ensurePlaying(state) {
  return state?.phase === 'playing' ? null : { error: 'Game is already finished' };
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function findProperty(player, cardId) {
  for (const [color, cards] of Object.entries(player.properties || {})) {
    const index = cards.findIndex(c => c.id === cardId);
    if (index >= 0) return { color, index, card: cards[index] };
  }
  return null;
}

function upgradeKinds(player, color) {
  return (player.upgrades[color] || []).map(upgrade =>
    typeof upgrade === 'string' ? upgrade : upgrade.upgradeType
  );
}

function discardUpgrades(state, player, color) {
  const upgrades = player.upgrades[color] || [];
  for (const upgrade of upgrades) {
    if (upgrade && typeof upgrade === 'object') state.discardPile.push(upgrade);
  }
  delete player.upgrades[color];
}

function recordCardPlay(state, playerId) {
  state.stats.cardsPlayed[playerId] = (state.stats.cardsPlayed[playerId] || 0) + 1;
}

function recordStolenProperties(state, playerId, count) {
  state.stats.propertiesStolen[playerId] = (state.stats.propertiesStolen[playerId] || 0) + count;
}

function validateState(state) {
  const ids = [];
  const addCards = cards => {
    for (const card of cards || []) {
      if (card && Number.isInteger(card.id)) ids.push(card.id);
    }
  };
  addCards(state.deck);
  addCards(state.discardPile);
  for (const player of state.players || []) {
    addCards(player.hand);
    addCards(player.bank);
    for (const cards of Object.values(player.properties || {})) addCards(cards);
    for (const upgrades of Object.values(player.upgrades || {})) addCards(upgrades);
  }
  if (hasDuplicates(ids)) return { error: 'Duplicate card IDs detected' };
  if (Number.isInteger(state.cardTotal) && ids.length !== state.cardTotal) {
    return { error: `Card conservation failed: expected ${state.cardTotal}, found ${ids.length}` };
  }
  if (state.pendingAction && state.turnPhase !== 'action_response') {
    return { error: 'Pending action requires action_response phase' };
  }
  return { ok: true };
}

/* ── Draw phase ──────────────────────────────────────────────────────── */

function reshuffleDiscard(state) {
  if (state.discardPile.length === 0) return false;
  state.deck = shuffle([...state.deck, ...state.discardPile], rngOf(state));
  state.discardPile = [];
  state.log.push('Deck reshuffled from discard pile.');
  emit(state, 'shuffle', { deckCount: state.deck.length });
  return true;
}

function drawCards(state) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = currentPlayer(state);

  // Auto-win check at turn start: if player already has 3+ complete sets
  // (e.g. gained from opponent's payment/swap on a previous turn), they win now
  if (checkWin(state, p.id)) return { ok: true, autoWin: true };

  const count = p.hand.length === 0 ? 5 : 2;

  if (state.deck.length < count) reshuffleDiscard(state);

  const drawn = [];
  for (let i = 0; i < count && state.deck.length > 0; i++) {
    const card = state.deck.pop();
    p.hand.push(card);
    drawn.push(card);
  }
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  state._handSnapshot = totalHandCards(state);
  state.log.push(p.name + ' drew ' + drawn.length + ' cards.');
  emit(state, 'draw', { to: p.id, count: drawn.length, cards: drawn.map(publicCard) });
  return drawn;
}

/* ── Play card actions ───────────────────────────────────────────────── */

function playAsMoney(state, playerId, cardIndex) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot play now' };
  if (state.playsRemaining <= 0) return { error: 'No plays remaining' };
  if (cardIndex < 0 || cardIndex >= p.hand.length) return { error: 'Invalid card' };
  const card = p.hand[cardIndex];
  if (card.type === 'property' || card.type === 'wild_property') return { error: 'Properties cannot be banked' };

  p.hand.splice(cardIndex, 1);
  p.bank.push(card);
  state.playsRemaining--;
  recordCardPlay(state, playerId);
  state.log.push(p.name + ' banked ' + card.name + ' (' + card.value + 'M)');
  emit(state, 'play_money', { actor: playerId, card: publicCard(card) });
  return { ok: true, card };
}

function playProperty(state, playerId, cardIndex, targetColor) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot play now' };
  if (state.playsRemaining <= 0) return { error: 'No plays remaining' };

  const card = p.hand[cardIndex];
  if (!card) return { error: 'Invalid card' };
  if (card.type !== 'property' && card.type !== 'wild_property') return { error: 'Not a property card' };

  let color;
  if (card.type === 'property') {
    color = card.color;
  } else {
    if (!targetColor) return { error: 'Choose a color for the wild property' };
    if (!COLORS[targetColor]) return { error: 'Invalid property color' };
    if (card.colors[0] !== 'any' && !card.colors.includes(targetColor))
      return { error: 'Wild cannot be placed on ' + targetColor };
    color = targetColor;
  }
  if (zoneFull(p, color))
    return { error: COLORS[color].name + ' already holds a full set (' + COLORS[color].size + ')' };

  const before = completedColors(p);
  p.hand.splice(cardIndex, 1);
  if (!p.properties[color]) p.properties[color] = [];
  const placed = { ...card, placedColor: color };
  p.properties[color].push(placed);
  state.playsRemaining--;
  recordCardPlay(state, playerId);
  state.log.push(p.name + ' played ' + card.name + ' on ' + COLORS[color].name);
  emit(state, 'play_property', { actor: playerId, card: publicCard(placed), color });
  emitSetChanges(state, p, before);

  checkWin(state, playerId);
  return { ok: true, card: placed };
}

function startPending(state, base, targetIds) {
  state.pendingAction = {
    ...base,
    targetId: targetIds.length === 1 ? targetIds[0] : undefined,
    targets: targetIds.map(id => ({ id, depth: 0, responderId: id })),
  };
  state.turnPhase = 'action_response';
  return state.pendingAction;
}

// §3.3 — Surge Ops doubles the NEXT charge of any kind this turn.
function chargeAmount(state, base) {
  if (state._surgeOps) { delete state._surgeOps; return { amount: base * 2, doubled: true }; }
  return { amount: base, doubled: false };
}

function playAction(state, playerId, cardIndex, opts) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot play now' };
  if (state.playsRemaining <= 0) return { error: 'No plays remaining' };

  const card = p.hand[cardIndex];
  if (!card) return { error: 'Invalid card' };
  if (card.type !== 'action' && card.type !== 'rent') return { error: 'Not an action/rent card' };

  const action = card.action || 'rent';
  const targetId = opts?.targetId;
  const targetColor = opts?.targetColor;
  const targetCardId = opts?.targetCardId;

  const spend = () => {
    p.hand.splice(cardIndex, 1);
    state.playsRemaining--;
    recordCardPlay(state, playerId);
    emit(state, 'play_action', { actor: playerId, card: publicCard(card), action });
  };
  const discardAndSpend = () => { spend(); state.discardPile.push(card); };

  switch (action) {
    case 'pcs_orders': {
      discardAndSpend();
      if (state.deck.length < 2) reshuffleDiscard(state);
      const drawn = [];
      for (let i=0; i<2 && state.deck.length > 0; i++) {
        const d = state.deck.pop(); p.hand.push(d); drawn.push(d);
      }
      state._handSnapshot = totalHandCards(state);
      state.log.push(p.name + ' played PCS Orders — drew ' + drawn.length + ' cards');
      emit(state, 'draw', { to: playerId, count: drawn.length, cards: drawn.map(publicCard) });
      return { ok: true, card, drawn };
    }

    case 'finance_office': {
      if (!targetId) return { error: 'Choose a player to collect from' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      discardAndSpend();
      const { amount, doubled } = chargeAmount(state, 5);
      startPending(state, {
        type: 'payment', action: 'finance_office',
        sourceId: p.id, amount, doubled,
      }, [target.id]);
      state.log.push(p.name + ' demands ' + amount + 'M from ' + target.name + ' (Finance Office)'
        + (doubled ? ' — DOUBLED' : ''));
      emit(state, 'demand', { actor: p.id, target: target.id, amount, reason: 'finance_office', doubled });
      return { ok: true, card, pending: true };
    }

    case 'roll_call': {
      discardAndSpend();
      const targets = state.players.filter(x => x.id !== p.id && !x.eliminated);
      const { amount, doubled } = chargeAmount(state, 2);
      startPending(state, {
        type: 'payment', action: 'roll_call',
        sourceId: p.id, amount, doubled,
      }, targets.map(t => t.id));
      state.log.push(p.name + ' calls Roll Call — everyone pays ' + amount + 'M!');
      for (const t of targets) {
        emit(state, 'demand', { actor: p.id, target: t.id, amount, reason: 'roll_call', doubled });
      }
      return { ok: true, card, pending: true };
    }

    case 'inspector_general': {
      if (!targetId || !targetColor) return { error: 'Choose a player and a complete set to seize' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      if (!isSetComplete(target, targetColor)) return { error: 'That set is not complete' };
      discardAndSpend();
      startPending(state, {
        type: 'steal_set', action: 'inspector_general',
        sourceId: p.id, color: targetColor,
      }, [target.id]);
      state.log.push(p.name + ' plays Inspector General on ' + target.name + '\'s ' + COLORS[targetColor].name + ' set!');
      return { ok: true, card, pending: true };
    }

    case 'midnight_requisition': {
      if (!targetId || targetCardId == null) return { error: 'Choose a player and a property to requisition' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      let foundColor = null;
      for (const [col, cards] of Object.entries(target.properties)) {
        if (!zoneRequisitionable(target, col)) continue;
        if (cards.some(c => c.id === targetCardId)) { foundColor = col; break; }
      }
      if (!foundColor) return { error: 'Cannot steal from a complete set or card not found' };
      const stolenCard = target.properties[foundColor].find(c => c.id === targetCardId);
      discardAndSpend();
      startPending(state, {
        type: 'steal_property', action: 'midnight_requisition',
        sourceId: p.id, targetCardId, targetColor: foundColor,
      }, [target.id]);
      state.log.push(p.name + ' plays Midnight Requisition on ' + target.name + '\'s ' + stolenCard.name);
      return { ok: true, card, pending: true };
    }

    case 'tdy_orders': {
      if (!targetId || targetCardId == null || opts?.myCardId == null)
        return { error: 'Choose your property and a target property to swap' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      const mine = findProperty(p, opts.myCardId);
      const theirs = findProperty(target, targetCardId);
      if (!mine || !theirs) return { error: 'Selected property is no longer available' };
      discardAndSpend();
      startPending(state, {
        type: 'swap', action: 'tdy_orders',
        sourceId: p.id, myCardId: opts.myCardId, targetCardId,
      }, [target.id]);
      state.log.push(p.name + ' plays TDY Orders on ' + target.name + ' — property swap!');
      return { ok: true, card, pending: true };
    }

    case 'upgrade': {
      if (!targetColor) return { error: 'Choose a complete set to upgrade' };
      if (!isSetComplete(p, targetColor)) return { error: 'Set must be complete to add Upgrade' };
      if (upgradeKinds(p, targetColor).includes('house'))
        return { error: 'Set already has an Upgrade' };
      spend();
      if (!p.upgrades[targetColor]) p.upgrades[targetColor] = [];
      const placed = { ...card, upgradeType: 'house' };
      p.upgrades[targetColor].push(placed);
      state.log.push(p.name + ' upgraded ' + COLORS[targetColor].name + ' (+3M rent)');
      emit(state, 'upgrade', { actor: playerId, color: targetColor, card: publicCard(placed) });
      return { ok: true, card };
    }

    case 'foc': {
      if (!targetColor) return { error: 'Choose a set for FOC' };
      if (!isSetComplete(p, targetColor)) return { error: 'Set must be complete' };
      if (!upgradeKinds(p, targetColor).includes('house'))
        return { error: 'Must have Upgrade before FOC' };
      if (upgradeKinds(p, targetColor).includes('hotel'))
        return { error: 'Already at FOC' };
      spend();
      const placed = { ...card, upgradeType: 'hotel' };
      p.upgrades[targetColor].push(placed);
      state.log.push(p.name + ' achieves FOC on ' + COLORS[targetColor].name + ' (+4M rent)');
      emit(state, 'upgrade', { actor: playerId, color: targetColor, card: publicCard(placed) });
      return { ok: true, card };
    }

    case 'surge_ops': {
      if (state._surgeOps) return { error: 'Surge Operations is already active' };
      discardAndSpend();
      state._surgeOps = true;
      state.log.push(p.name + ' activates Surge Operations — the next charge this turn is doubled!');
      return { ok: true, card };
    }

    case 'chud': {
      if (!targetId || targetCardId == null) return { error: 'Choose a player and ANY property to commandeer' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      let chudColor = null;
      for (const [col, cards] of Object.entries(target.properties)) {
        if (cards.some(c => c.id === targetCardId)) { chudColor = col; break; }
      }
      if (!chudColor) return { error: 'Property not found on target' };
      const stolenCard = target.properties[chudColor].find(c => c.id === targetCardId);
      discardAndSpend();
      startPending(state, {
        type: 'steal_property', action: 'chud',
        sourceId: p.id, targetCardId, targetColor: chudColor,
      }, [target.id]);
      state.log.push(p.name + ' plays THE CHUD CARD on ' + target.name + '\'s ' + stolenCard.name + '!');
      return { ok: true, card, pending: true };
    }

    case 'opsec':
      return { error: 'OPSEC can only be played in response to an action' };

    default: break;
  }

  // Rent card
  if (card.type === 'rent') {
    if (!targetColor) return { error: 'Choose a color to charge rent for' };
    if (!COLORS[targetColor]) return { error: 'Invalid property color' };
    const isWildRent = card.colors[0] === 'any';
    if (!isWildRent && !card.colors.includes(targetColor))
      return { error: 'This rent card cannot be used for ' + targetColor };
    const count = (p.properties[targetColor] || []).length;
    if (count === 0) return { error: 'You have no properties of that color' };

    // §3.2 — the wild ("any") rent hits ONE chosen player; colour rents hit the table.
    let targets;
    if (isWildRent) {
      if (!targetId) return { error: 'Choose a player to charge' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      targets = [target];
    } else {
      targets = state.players.filter(x => x.id !== p.id && !x.eliminated);
    }
    if (targets.length === 0) return { error: 'No one to charge' };

    discardAndSpend();
    const { amount, doubled } = chargeAmount(state, calcRent(p, targetColor));
    startPending(state, {
      type: 'payment', action: 'rent',
      sourceId: p.id, amount, color: targetColor, doubled, wild: isWildRent,
    }, targets.map(t => t.id));
    state.log.push(p.name + ' charges ' + amount + 'M rent on ' + COLORS[targetColor].name
      + (isWildRent ? ' from ' + targets[0].name : '') + (doubled ? ' — DOUBLED' : ''));
    emit(state, 'rent_charged', {
      actor: p.id, color: targetColor, amount,
      targets: targets.map(t => t.id), doubled,
    });
    return { ok: true, card, pending: true };
  }

  return { error: 'Unknown action' };
}

/* ── Respond to action (single OPSEC mechanism) ──────────────────────── */

// Every pending action carries `targets: [{ id, depth, responderId }]`.
// depth 0  → the target must answer; accepting suffers the action.
// depth odd→ the source must answer; accepting means OPSEC stood and the action is blocked.
// depth even>0 → the target answers again (counter-counter-OPSEC), accepting suffers.
function pendingResponders(state) {
  const pa = state?.pendingAction;
  if (!pa || !pa.targets) return [];
  return pa.targets.map(t => t.responderId).filter(Boolean);
}

function pendingEntryFor(state, playerId) {
  const pa = state?.pendingAction;
  if (!pa || !pa.targets) return null;
  return pa.targets.find(t => t.responderId === playerId) || null;
}

function finishEntry(state, pa, entry) {
  if (state.pendingAction !== pa) return { ok: true };  // game ended mid-resolution
  pa.targets = pa.targets.filter(t => t !== entry);
  if (pa.targets.length === 0) {
    state.pendingAction = null;
    if (state.phase === 'playing') state.turnPhase = 'play';
    return { ok: true };
  }
  return { ok: true, morePending: true };
}

function respondToAction(state, playerId, response, paymentCards) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const pa = state.pendingAction;
  if (!pa) return { error: 'No pending action' };
  const entry = pendingEntryFor(state, playerId);
  if (!entry) return { error: 'Not your turn to respond' };
  const responder = getPlayer(state, playerId);
  if (!responder) return { error: 'Player not found' };

  if (response === 'opsec') {
    const idx = responder.hand.findIndex(c => c.action === 'opsec');
    if (idx < 0) return { error: 'No OPSEC card in hand' };
    const opsecCard = responder.hand.splice(idx, 1)[0];
    state.discardPile.push(opsecCard);
    entry.depth++;
    const against = playerId === pa.sourceId ? entry.id : pa.sourceId;
    entry.responderId = against;
    state.log.push(responder.name + ' plays OPSEC! ' + (getPlayer(state, against)?.name || '?') + ' can counter...');
    emit(state, 'opsec', {
      actor: playerId, against, depth: entry.depth,
      target: entry.id, action: pa.action, card: publicCard(opsecCard),
    });
    return { ok: true, opsec: true, morePending: true };
  }

  if (response !== 'accept') return { error: 'Invalid response' };

  if (entry.depth % 2 === 1) {
    // The source conceded: the defender's OPSEC stands.
    const targetName = getPlayer(state, entry.id)?.name || '?';
    state.log.push('Action blocked by OPSEC — ' + targetName + ' is safe.');
    emit(state, 'action_blocked', {
      source: pa.sourceId, target: entry.id, action: pa.action, depth: entry.depth,
    });
    return finishEntry(state, pa, entry);
  }

  return executeEntry(state, pa, entry, paymentCards);
}

function executeEntry(state, pa, entry, paymentCards) {
  const source = getPlayer(state, pa.sourceId);
  const target = getPlayer(state, entry.id);
  if (!source || !target) return finishEntry(state, pa, entry);

  switch (pa.type) {
    case 'payment': {
      const result = processPayment(state, pa, target, source, paymentCards);
      if (result.needPayment) return result;
      return finishEntry(state, pa, entry);
    }

    case 'steal_set': {
      const col = pa.color;
      const beforeSource = completedColors(source);
      const stolen = (target.properties[col] || []).slice();
      target.properties[col] = [];
      if (!source.properties[col]) source.properties[col] = [];
      for (const card of stolen) { card.placedColor = col; source.properties[col].push(card); }
      if (target.upgrades[col]) {
        source.upgrades[col] = [...(source.upgrades[col] || []), ...target.upgrades[col]];
        delete target.upgrades[col];
      }
      state.log.push(source.name + ' seized ' + target.name + '\'s ' + COLORS[col].name + ' set!');
      emit(state, 'set_stolen', {
        actor: source.id, from: target.id, color: col, cards: stolen.map(publicCard),
      });
      recordStolenProperties(state, source.id, stolen.length);
      emitSetChanges(state, source, beforeSource);
      checkWin(state, source.id);
      return finishEntry(state, pa, entry);
    }

    case 'steal_property': {
      const col = pa.targetColor;
      const beforeSource = completedColors(source);
      const idx = (target.properties[col] || []).findIndex(c => c.id === pa.targetCardId);
      if (idx >= 0) {
        const card = target.properties[col].splice(idx, 1)[0];
        const destColor = receiveProperty(state, source, card, card.placedColor || card.color || col);
        state.log.push(source.name + (pa.action === 'chud' ? ' commandeered ' : ' requisitioned ')
          + card.name + ' from ' + target.name + (pa.action === 'chud' ? '!' : ''));
        emit(state, 'steal', {
          actor: source.id, from: target.id, card: publicCard(card),
          toColor: destColor, action: pa.action,
        });
        if (!isSetComplete(target, col)) discardUpgrades(state, target, col);
        recordStolenProperties(state, source.id, 1);
        emitSetChanges(state, source, beforeSource);
        checkWin(state, source.id);
      }
      return finishEntry(state, pa, entry);
    }

    case 'swap': {
      const beforeSource = completedColors(source);
      const beforeTarget = completedColors(target);
      let myCard=null, myColor=null, theirCard=null, theirColor=null;
      for (const [col, cards] of Object.entries(source.properties)) {
        const i = cards.findIndex(c => c.id === pa.myCardId);
        if (i >= 0) { myCard = cards.splice(i, 1)[0]; myColor = col; break; }
      }
      for (const [col, cards] of Object.entries(target.properties)) {
        const i = cards.findIndex(c => c.id === pa.targetCardId);
        if (i >= 0) { theirCard = cards.splice(i, 1)[0]; theirColor = col; break; }
      }
      if (myCard && theirCard) {
        const gotColor = receiveProperty(state, source, theirCard, theirCard.placedColor || theirColor);
        const gaveColor = receiveProperty(state, target, myCard, myCard.placedColor || myColor);
        state.log.push(source.name + ' swapped properties with ' + target.name);
        emit(state, 'swap', {
          actor: source.id, target: target.id,
          gave: publicCard(myCard), took: publicCard(theirCard),
          gaveColor, tookColor: gotColor,
        });
        if (!isSetComplete(source, myColor)) discardUpgrades(state, source, myColor);
        if (!isSetComplete(target, theirColor)) discardUpgrades(state, target, theirColor);
        emitSetChanges(state, source, beforeSource);
        emitSetChanges(state, target, beforeTarget);
        checkWin(state, source.id);
      } else {
        // Restore anything we pulled out before discovering the other side was gone.
        if (myCard) receiveProperty(state, source, myCard, myColor);
        if (theirCard) receiveProperty(state, target, theirCard, theirColor);
      }
      return finishEntry(state, pa, entry);
    }
  }
  return finishEntry(state, pa, entry);
}

function processPayment(state, pa, payer, payee, selectedCardIds) {
  const payable = payableCards(payer);

  if (!selectedCardIds || !Array.isArray(selectedCardIds) || selectedCardIds.length === 0) {
    // §3.4 — "nothing to pay with" means no cards at all, not merely no *value*.
    if (payable.length === 0) {
      state.log.push(payer.name + ' has nothing to pay!');
      emit(state, 'insolvent', { from: payer.id, to: payee.id, amount: pa.amount });
      return { ok: true };
    }
    return { error: 'Select cards to pay with', needPayment: true, amount: pa.amount };
  }
  if (hasDuplicates(selectedCardIds)) {
    return { error: 'Payment cards must be unique', needPayment: true, amount: pa.amount };
  }

  let totalValue = 0;
  const bankCards = [];
  const propCards = [];

  for (const cid of selectedCardIds) {
    let found = false;
    const bi = payer.bank.findIndex(c => c.id === cid);
    if (bi >= 0) { bankCards.push({ idx: bi, card: payer.bank[bi] }); totalValue += payer.bank[bi].value; found = true; }
    if (!found) {
      for (const [col, cards] of Object.entries(payer.properties)) {
        const pi = cards.findIndex(c => c.id === cid);
        if (pi >= 0) { propCards.push({ color: col, idx: pi, card: cards[pi] }); totalValue += cards[pi].value; found = true; break; }
      }
    }
  }
  if (bankCards.length + propCards.length !== selectedCardIds.length) {
    return { error: 'Payment selection contains an invalid card', needPayment: true, amount: pa.amount };
  }

  // Short payments are only legal when the payer surrenders every card they own —
  // zero-value wilds included (§3.4).
  if (totalValue < pa.amount && selectedCardIds.length < payable.length) {
    return {
      error: 'You must pay at least ' + pa.amount + 'M (or surrender every card you have)',
      needPayment: true, amount: pa.amount,
    };
  }

  const beforePayee = completedColors(payee);
  const beforePayer = completedColors(payer);
  const paid = [];

  bankCards.sort((a,b) => b.idx - a.idx);
  bankCards.forEach(({ idx, card }) => {
    payer.bank.splice(idx, 1);
    payee.bank.push(card);
    paid.push(card);
  });

  propCards.forEach(({ color, card }) => {
    const ci = payer.properties[color].findIndex(c => c.id === card.id);
    if (ci >= 0) {
      payer.properties[color].splice(ci, 1);
      receiveProperty(state, payee, card, card.placedColor || card.color || color);
      paid.push(card);
    }
    if (!isSetComplete(payer, color)) discardUpgrades(state, payer, color);
  });

  state.log.push(payer.name + ' paid ' + totalValue + 'M to ' + payee.name);
  emit(state, 'payment', {
    from: payer.id, to: payee.id, total: totalValue,
    cards: paid.map(publicCard), reason: pa.action,
  });
  state.stats.payments.count++;
  state.stats.payments.total += totalValue;
  state.stats.payments.biggest = Math.max(state.stats.payments.biggest, totalValue);
  emitSetChanges(state, payee, beforePayee);
  emitSetChanges(state, payer, beforePayer);
  checkWin(state, payee.id);
  return { ok: true };
}

/* ── Move property (free rearrange) ─────────────────────────────────── */

function moveProperty(state, playerId, cardId, toColor) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot rearrange now' };
  if (!COLORS[toColor]) return { error: 'Invalid color' };

  // Find the card in player's properties
  let card = null, fromColor = null, fromIdx = -1;
  for (const [col, cards] of Object.entries(p.properties)) {
    const idx = cards.findIndex(c => c.id === cardId);
    if (idx >= 0) { card = cards[idx]; fromColor = col; fromIdx = idx; break; }
  }
  if (!card) return { error: 'Card not found in your properties' };
  if (fromColor === toColor) return { error: 'Already in that set' };

  // Only wild_property cards can be moved
  if (card.type !== 'wild_property') return { error: 'Only wild properties can be moved between sets' };

  // Validate the target color is valid for this wild
  if (card.colors[0] !== 'any' && !card.colors.includes(toColor))
    return { error: 'This wild cannot go on ' + COLORS[toColor].name };
  if (zoneFull(p, toColor))
    return { error: COLORS[toColor].name + ' already holds a full set (' + COLORS[toColor].size + ')' };

  const before = completedColors(p);
  p.properties[fromColor].splice(fromIdx, 1);
  if (!p.properties[toColor]) p.properties[toColor] = [];
  card.placedColor = toColor;
  p.properties[toColor].push(card);

  // Clean up upgrades if the source set is no longer complete
  if (!isSetComplete(p, fromColor)) discardUpgrades(state, p, fromColor);

  state.log.push(p.name + ' moved ' + card.name + ' to ' + COLORS[toColor].name);
  emit(state, 'move_property', { actor: playerId, card: publicCard(card), from: fromColor, to: toColor });
  emitSetChanges(state, p, before);
  checkWin(state, playerId);
  return { ok: true };
}

/* ── Scoop (forfeit) ─────────────────────────────────────────────────── */

function scoop(state, playerId) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p) return { error: 'Player not found' };
  if (p.eliminated) return { error: 'Already eliminated' };

  while (p.hand.length > 0) state.discardPile.push(p.hand.pop());
  while (p.bank.length > 0) state.discardPile.push(p.bank.pop());
  for (const [color, cards] of Object.entries(p.properties)) {
    while (cards.length > 0) state.discardPile.push(cards.pop());
    discardUpgrades(state, p, color);
  }
  p.properties = {};
  p.upgrades = {};
  p.eliminated = true;

  state.log.push(p.name + ' scooped! All cards discarded.');
  emit(state, 'scoop', { actor: playerId });
  state._handSnapshot = totalHandCards(state);

  // Unwind any pending action this player is part of.
  const pa = state.pendingAction;
  if (pa) {
    if (pa.sourceId === playerId) {
      state.pendingAction = null;
      state.turnPhase = 'play';
    } else {
      pa.targets = pa.targets.filter(t => t.id !== playerId);
      if (pa.targets.length === 0) {
        state.pendingAction = null;
        state.turnPhase = 'play';
      }
    }
  }

  const wasMyTurn = currentPlayer(state).id === playerId;
  if (wasMyTurn) {
    delete state._surgeOps;
    state.pendingAction = null;
    state.turnPhase = 'draw';
    state.playsRemaining = 3;
  }

  const activePlayers = state.players.filter(x => !x.eliminated);
  if (activePlayers.length <= 1) {
    if (activePlayers.length === 1) {
      finishGame(state, activePlayers[0].id, 'last_standing',
        activePlayers[0].name + ' wins — all other players scooped!');
    }
    return { ok: true };
  }

  if (wasMyTurn) {
    advanceToNextActive(state);
    emit(state, 'turn_end', { actor: playerId });
    emit(state, 'turn_start', { actor: currentPlayer(state).id, plays: state.playsRemaining });
    state.log.push(currentPlayer(state).name + '\'s turn');
  }

  return { ok: true };
}

function advanceToNextActive(state) {
  const n = state.players.length;
  for (let i = 0; i < n; i++) {
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % n;
    if (!state.players[state.currentPlayerIndex].eliminated) return;
  }
}

/* ── End turn ────────────────────────────────────────────────────────── */

// §3.6 — the table is dead when deck and discard are empty and a full round passes
// with no card leaving any hand. Most sets wins; net worth breaks the tie.
function endInStalemate(state) {
  const active = state.players.filter(p => !p.eliminated);
  const ranked = active.slice().sort((a, b) => {
    const sets = completedSets(b) - completedSets(a);
    if (sets !== 0) return sets;
    return playerNetWorth(b) - playerNetWorth(a);
  });
  const winner = ranked[0] || null;
  finishGame(state, winner ? winner.id : null, 'stalemate',
    'Deck and discard are empty and nobody can move — ' +
    (winner ? winner.name + ' wins on completed sets and net worth.' : 'the game is a draw.'));
}

function endTurn(state, playerId, discardIds) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase === 'action_response') return { error: 'Resolve pending action first' };

  if (p.hand.length > HAND_LIMIT) {
    const excess = p.hand.length - HAND_LIMIT;
    if (!discardIds || !Array.isArray(discardIds))
      return { error: 'Must discard to ' + HAND_LIMIT + ' cards', needDiscard: true, excess };
    if (discardIds.length !== excess)
      return { error: 'Discard exactly ' + excess + ' cards' };
    if (hasDuplicates(discardIds)) return { error: 'Discarded cards must be unique' };
    const toDiscard = discardIds.map(id => p.hand.findIndex(c => c.id === id));
    if (toDiscard.some(i => i < 0)) return { error: 'Discard selection contains an invalid card' };
    toDiscard.sort((a,b) => b-a);
    const discarded = [];
    toDiscard.forEach(idx => {
      const card = p.hand.splice(idx, 1)[0];
      state.discardPile.push(card);
      discarded.push(card);
    });
    emit(state, 'discard', { actor: playerId, cards: discarded.map(publicCard) });
  }

  delete state._surgeOps;

  const handsNow = totalHandCards(state);
  const dry = state.deck.length === 0 && state.discardPile.length === 0;
  if (dry && handsNow === state._handSnapshot) state._idleTurns = (state._idleTurns || 0) + 1;
  else state._idleTurns = 0;
  state._handSnapshot = handsNow;

  emit(state, 'turn_end', { actor: playerId });

  const activeCount = state.players.filter(x => !x.eliminated).length;
  if ((state._idleTurns || 0) >= activeCount) {
    endInStalemate(state);
    return { ok: true, stalemate: true };
  }

  advanceToNextActive(state);
  state.turnPhase = 'draw';
  state.playsRemaining = 3;
  state.stats.turns++;
  state.log.push(currentPlayer(state).name + '\'s turn');
  emit(state, 'turn_start', { actor: currentPlayer(state).id, plays: state.playsRemaining });
  return { ok: true };
}

/* ── Player view (hides other hands) ─────────────────────────────────── */

function getPlayerView(state, playerId) {
  const tail = (state.events || []).slice(-EVENT_TAIL).map(ev => redactEvent(ev, playerId));
  return {
    phase: state.phase,
    turnPhase: state.turnPhase,
    currentPlayerId: currentPlayer(state).id,
    playsRemaining: state.playsRemaining,
    deckCount: state.deck.length,
    discardTop: state.discardPile.length > 0 ? state.discardPile[state.discardPile.length-1] : null,
    discardPile: [...state.discardPile].reverse(),
    pendingAction: state.pendingAction,
    responders: pendingResponders(state),
    winner: state.winner,
    endReason: state.endReason || null,
    surgeOps: !!state._surgeOps,
    handLimit: HAND_LIMIT,
    setsToWin: SETS_TO_WIN,
    stats: state.stats,
    log: state.log.slice(-20),
    events: tail,
    eventSeq: state.eventSeq || 0,
    players: state.players.map(p => ({
      id: p.id, name: p.name,
      handCount: p.hand.length,
      hand: p.id === playerId ? p.hand : undefined,
      bank: p.bank,
      properties: p.properties,
      upgrades: p.upgrades,
      completedSets: completedSets(p),
      eliminated: !!p.eliminated,
      bankValue: p.bank.reduce((s, c) => s + c.value, 0),
      propertyValue: Object.values(p.properties).reduce(
        (s, cards) => s + cards.reduce((t, c) => t + c.value, 0), 0),
      upgradeValue: playerUpgradeValue(p),
      payableValue: playerTotalValue(p),
      netWorth: playerNetWorth(p),
    })),
  };
}

module.exports = {
  COLORS, HAND_LIMIT, SETS_TO_WIN, EVENT_TAIL,
  buildDeck, shuffle, makeRng, createGame, currentPlayer, getPlayer,
  completedSets, checkWin, isSetComplete, calcRent, playerTotalValue, playerNetWorth,
  playerUpgradeValue, payableCards, zoneFull, zoneCount, zoneRequisitionable, legalColorsFor,
  drawCards, playAsMoney, playProperty, playAction, respondToAction,
  moveProperty, scoop, endTurn, getPlayerView, validateState, upgradeKinds,
  pendingResponders, pendingEntryFor, publicCard,
};
