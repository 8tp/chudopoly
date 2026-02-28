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
    ['inspector_general','Inspector General',5,'Steal a complete property set from any player',2],
    ['opsec','OPSEC',4,'Counter any action card played against you',3],
    ['midnight_requisition','Midnight Requisition',3,'Steal a single property from any player (not from a complete set)',3],
    ['tdy_orders','TDY Orders',3,'Swap one of your properties for one of another player\'s',3],
    ['finance_office','Finance Office',3,'Collect 5M from any one player',3],
    ['roll_call','Roll Call',2,'All other players pay you 2M each',3],
    ['pcs_orders','PCS Orders',1,'Draw 2 extra cards from the deck',10],
    ['upgrade','Upgrade (House)',3,'Add to a complete set: +3M rent',3],
    ['foc','Full Operational Capability (Hotel)',4,'Add to a complete set with Upgrade: +4M rent',2],
    ['surge_ops','Surge Operations',1,'Double the rent you charge this turn',2],
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

  /* THE CHUD CARD — 2 copies */
  c({ type:'action', action:'chud', name:'THE CHUD CARD', value:4,
      description:'Commandeer Hardware Under Directive — Steal ANY property from any player (even from complete sets) + collect 2M from them' });
  c({ type:'action', action:'chud', name:'THE CHUD CARD', value:4,
      description:'Commandeer Hardware Under Directive — Steal ANY property from any player (even from complete sets) + collect 2M from them' });

  return cards;
}

function shuffle(arr) {
  for (let i=arr.length-1; i>0; i--) {
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

/* ── Game state ──────────────────────────────────────────────────────── */

function createGame(players) {
  const deck = shuffle(buildDeck());
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
    log: ['Game started! ' + players.map(p=>p.name).join(', ') + ' are playing.'],
  };

  state.players.forEach(p => {
    for (let i=0; i<5; i++) {
      if (state.deck.length) p.hand.push(state.deck.pop());
    }
  });

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
    if (color === 'any') continue;
    const info = COLORS[color];
    if (info && cards.length >= info.size) count++;
  }
  return count;
}

function checkWin(state, playerId) {
  const p = getPlayer(state, playerId);
  if (completedSets(p) >= 3) {
    state.phase = 'finished';
    state.winner = playerId;
    state.log.push(p.name + ' wins with 3 complete sets!');
    return true;
  }
  return false;
}

function isSetComplete(player, color) {
  const info = COLORS[color];
  if (!info) return false;
  return (player.properties[color] || []).length >= info.size;
}

function calcRent(player, color) {
  const info = COLORS[color];
  if (!info) return 0;
  const count = (player.properties[color] || []).length;
  if (count === 0) return 0;
  let rent = info.rent[Math.min(count, info.rent.length) - 1];
  const upgrades = player.upgrades[color] || [];
  if (upgrades.includes('house')) rent += 3;
  if (upgrades.includes('hotel')) rent += 4;
  return rent;
}

function playerTotalValue(player) {
  let total = 0;
  player.bank.forEach(c => total += c.value);
  for (const cards of Object.values(player.properties))
    cards.forEach(c => total += c.value);
  return total;
}

/* ── Draw phase ──────────────────────────────────────────────────────── */

function drawCards(state) {
  const p = currentPlayer(state);

  // Auto-win check at turn start: if player already has 3+ complete sets
  // (e.g. gained from opponent's payment/swap on a previous turn), they win now
  if (checkWin(state, p.id)) return { ok: true, autoWin: true };

  const count = p.hand.length === 0 ? 5 : 2;

  if (state.deck.length < count && state.discardPile.length > 0) {
    state.deck = shuffle([...state.deck, ...state.discardPile]);
    state.discardPile = [];
    state.log.push('Deck reshuffled from discard pile.');
  }

  const drawn = [];
  for (let i = 0; i < count && state.deck.length > 0; i++) {
    const card = state.deck.pop();
    p.hand.push(card);
    drawn.push(card);
  }
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  state.log.push(p.name + ' drew ' + drawn.length + ' cards.');
  return drawn;
}

/* ── Play card actions ───────────────────────────────────────────────── */

function playAsMoney(state, playerId, cardIndex) {
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
  state.log.push(p.name + ' banked ' + card.name + ' (' + card.value + 'M)');
  return { ok: true, card };
}

function playProperty(state, playerId, cardIndex, targetColor) {
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
    if (card.colors[0] !== 'any' && !card.colors.includes(targetColor))
      return { error: 'Wild cannot be placed on ' + targetColor };
    color = targetColor;
  }

  p.hand.splice(cardIndex, 1);
  if (!p.properties[color]) p.properties[color] = [];
  const placed = { ...card, placedColor: color };
  p.properties[color].push(placed);
  state.playsRemaining--;
  state.log.push(p.name + ' played ' + card.name + ' on ' + COLORS[color].name);

  checkWin(state, playerId);
  return { ok: true, card: placed };
}

function playAction(state, playerId, cardIndex, opts) {
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

  switch (action) {
    case 'pcs_orders': {
      p.hand.splice(cardIndex, 1);
      state.discardPile.push(card);
      state.playsRemaining--;
      if (state.deck.length < 2 && state.discardPile.length > 1) {
        state.deck = shuffle([...state.deck, ...state.discardPile]);
        state.discardPile = [];
      }
      const drawn = [];
      for (let i=0; i<2 && state.deck.length > 0; i++) {
        const d = state.deck.pop(); p.hand.push(d); drawn.push(d);
      }
      state.log.push(p.name + ' played PCS Orders — drew 2 cards');
      return { ok: true, card, drawn };
    }

    case 'finance_office': {
      if (!targetId) return { error: 'Choose a player to collect from' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      p.hand.splice(cardIndex, 1);
      state.discardPile.push(card);
      state.playsRemaining--;
      state.pendingAction = {
        type: 'payment', action: 'finance_office',
        sourceId: p.id, targetId: target.id,
        amount: 5, responderId: target.id,
      };
      state.turnPhase = 'action_response';
      state.log.push(p.name + ' demands 5M from ' + target.name + ' (Finance Office)');
      return { ok: true, card, pending: true };
    }

    case 'roll_call': {
      p.hand.splice(cardIndex, 1);
      state.discardPile.push(card);
      state.playsRemaining--;
      const targets = state.players.filter(x => x.id !== p.id && !x.eliminated);
      state.pendingAction = {
        type: 'payment_all', action: 'roll_call',
        sourceId: p.id, amount: 2,
        pending: targets.map(t => t.id),
        opsecChains: {},
      };
      state.turnPhase = 'action_response';
      state.log.push(p.name + ' calls Roll Call — everyone pays 2M!');
      return { ok: true, card, pending: true };
    }

    case 'inspector_general': {
      if (!targetId || !targetColor) return { error: 'Choose a player and a complete set to seize' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      if (!isSetComplete(target, targetColor)) return { error: 'That set is not complete' };
      p.hand.splice(cardIndex, 1);
      state.discardPile.push(card);
      state.playsRemaining--;
      state.pendingAction = {
        type: 'steal_set', action: 'inspector_general',
        sourceId: p.id, targetId: target.id,
        color: targetColor, responderId: target.id,
      };
      state.turnPhase = 'action_response';
      state.log.push(p.name + ' plays Inspector General on ' + target.name + '\'s ' + COLORS[targetColor].name + ' set!');
      return { ok: true, card, pending: true };
    }

    case 'midnight_requisition': {
      if (!targetId || targetCardId == null) return { error: 'Choose a player and a property to requisition' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      let foundColor = null, foundIdx = -1;
      for (const [col, cards] of Object.entries(target.properties)) {
        if (isSetComplete(target, col)) continue;
        const idx = cards.findIndex(c => c.id === targetCardId);
        if (idx >= 0) { foundColor = col; foundIdx = idx; break; }
      }
      if (!foundColor) return { error: 'Cannot steal from a complete set or card not found' };
      p.hand.splice(cardIndex, 1);
      state.discardPile.push(card);
      state.playsRemaining--;
      state.pendingAction = {
        type: 'steal_property', action: 'midnight_requisition',
        sourceId: p.id, targetId: target.id,
        targetCardId, targetColor: foundColor, responderId: target.id,
      };
      const stolenCard = target.properties[foundColor][foundIdx];
      state.log.push(p.name + ' plays Midnight Requisition on ' + target.name + '\'s ' + stolenCard.name);
      return { ok: true, card, pending: true };
    }

    case 'tdy_orders': {
      if (!targetId || targetCardId == null || opts?.myCardId == null)
        return { error: 'Choose your property and a target property to swap' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      p.hand.splice(cardIndex, 1);
      state.discardPile.push(card);
      state.playsRemaining--;
      state.pendingAction = {
        type: 'swap', action: 'tdy_orders',
        sourceId: p.id, targetId: target.id,
        myCardId: opts.myCardId, targetCardId,
        responderId: target.id,
      };
      state.turnPhase = 'action_response';
      state.log.push(p.name + ' plays TDY Orders on ' + target.name + ' — property swap!');
      return { ok: true, card, pending: true };
    }

    case 'upgrade': {
      if (!targetColor) return { error: 'Choose a complete set to upgrade' };
      if (!isSetComplete(p, targetColor)) return { error: 'Set must be complete to add Upgrade' };
      if ((p.upgrades[targetColor] || []).includes('house'))
        return { error: 'Set already has an Upgrade' };
      p.hand.splice(cardIndex, 1);
      if (!p.upgrades[targetColor]) p.upgrades[targetColor] = [];
      p.upgrades[targetColor].push('house');
      state.playsRemaining--;
      state.log.push(p.name + ' upgraded ' + COLORS[targetColor].name + ' (+3M rent)');
      return { ok: true, card };
    }

    case 'foc': {
      if (!targetColor) return { error: 'Choose a set for FOC' };
      if (!isSetComplete(p, targetColor)) return { error: 'Set must be complete' };
      if (!(p.upgrades[targetColor] || []).includes('house'))
        return { error: 'Must have Upgrade before FOC' };
      if ((p.upgrades[targetColor] || []).includes('hotel'))
        return { error: 'Already at FOC' };
      p.hand.splice(cardIndex, 1);
      p.upgrades[targetColor].push('hotel');
      state.playsRemaining--;
      state.log.push(p.name + ' achieves FOC on ' + COLORS[targetColor].name + ' (+4M rent)');
      return { ok: true, card };
    }

    case 'surge_ops': {
      p.hand.splice(cardIndex, 1);
      state.discardPile.push(card);
      state.playsRemaining--;
      state._surgeOps = true;
      state.log.push(p.name + ' activates Surge Operations — next rent is doubled!');
      return { ok: true, card };
    }

    case 'chud': {
      if (!targetId || targetCardId == null) return { error: 'Choose a player and ANY property to commandeer' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      let chudColor = null;
      for (const [col, cards] of Object.entries(target.properties)) {
        const idx = cards.findIndex(c => c.id === targetCardId);
        if (idx >= 0) { chudColor = col; break; }
      }
      if (!chudColor) return { error: 'Property not found on target' };
      p.hand.splice(cardIndex, 1);
      state.discardPile.push(card);
      state.playsRemaining--;
      state.pendingAction = {
        type: 'chud', action: 'chud',
        sourceId: p.id, targetId: target.id,
        targetCardId, targetColor: chudColor, amount: 2,
        responderId: target.id,
      };
      state.turnPhase = 'action_response';
      let cname = '?';
      for (const cards of Object.values(target.properties)) {
        const fc = cards.find(c => c.id === targetCardId);
        if (fc) { cname = fc.name; break; }
      }
      state.log.push(p.name + ' plays THE CHUD CARD on ' + target.name + '\'s ' + cname + '!');
      return { ok: true, card, pending: true };
    }

    case 'opsec':
      return { error: 'OPSEC can only be played in response to an action' };

    default: break;
  }

  // Rent card
  if (card.type === 'rent') {
    if (!targetColor) return { error: 'Choose a color to charge rent for' };
    if (card.colors[0] !== 'any' && !card.colors.includes(targetColor))
      return { error: 'This rent card cannot be used for ' + targetColor };
    const count = (p.properties[targetColor] || []).length;
    if (count === 0) return { error: 'You have no properties of that color' };

    let rent = calcRent(p, targetColor);
    if (state._surgeOps) { rent *= 2; delete state._surgeOps; }

    p.hand.splice(cardIndex, 1);
    state.discardPile.push(card);
    state.playsRemaining--;

    const targets = state.players.filter(x => x.id !== p.id && !x.eliminated);
    state.pendingAction = {
      type: 'payment_all', action: 'rent',
      sourceId: p.id, amount: rent, color: targetColor,
      pending: targets.map(t => t.id),
      opsecChains: {},
    };
    state.turnPhase = 'action_response';
    state.log.push(p.name + ' charges ' + rent + 'M rent on ' + COLORS[targetColor].name);
    return { ok: true, card, pending: true };
  }

  return { error: 'Unknown action' };
}

/* ── Respond to action (OPSEC / accept) ─────────────────────────────── */

function respondToAction(state, playerId, response, paymentCards) {
  const pa = state.pendingAction;
  if (!pa) return { error: 'No pending action' };

  // Simultaneous payment_all handling
  if (pa.type === 'payment_all') {
    return respondToPaymentAll(state, pa, playerId, response, paymentCards);
  }

  // Original single-responder logic for non-payment_all
  if (pa.responderId !== playerId) return { error: 'Not your turn to respond' };
  const responder = getPlayer(state, playerId);

  if (response === 'opsec') {
    const idx = responder.hand.findIndex(c => c.action === 'opsec');
    if (idx < 0) return { error: 'No OPSEC card in hand' };
    const opsecCard = responder.hand.splice(idx, 1)[0];
    state.discardPile.push(opsecCard);
    pa.responderId = pa.responderId === pa.sourceId ? (pa.targetId || playerId) : pa.sourceId;
    state.log.push(responder.name + ' plays OPSEC! ' + getPlayer(state, pa.responderId).name + ' can counter...');
    pa._opsecChain = (pa._opsecChain || 0) + 1;
    return { ok: true, opsec: true };
  }

  if (response === 'accept') {
    return executeAction(state, pa, playerId, paymentCards);
  }

  return { error: 'Invalid response' };
}

function respondToPaymentAll(state, pa, playerId, response, paymentCards) {
  const responder = getPlayer(state, playerId);
  const source = getPlayer(state, pa.sourceId);
  if (!pa.opsecChains) pa.opsecChains = {};

  // Check if source is responding to an OPSEC chain
  if (playerId === pa.sourceId) {
    // Find which opsec chain the source needs to respond to
    const chainPlayerIds = Object.keys(pa.opsecChains).filter(pid => pa.opsecChains[pid].responderId === pa.sourceId);
    if (chainPlayerIds.length === 0) return { error: 'Not your turn to respond' };
    const chainPid = chainPlayerIds[0]; // handle one at a time
    const chain = pa.opsecChains[chainPid];

    if (response === 'accept') {
      // Source accepts the block — this player doesn't pay
      const blockedPlayer = getPlayer(state, chainPid);
      state.log.push('Action blocked by OPSEC for ' + (blockedPlayer?.name || '?') + '!');
      delete pa.opsecChains[chainPid];
      return checkPaymentAllDone(state, pa);
    } else if (response === 'opsec') {
      const idx = responder.hand.findIndex(c => c.action === 'opsec');
      if (idx < 0) return { error: 'No OPSEC card in hand' };
      const opsecCard = responder.hand.splice(idx, 1)[0];
      state.discardPile.push(opsecCard);
      chain.chain++;
      chain.responderId = chainPid;
      state.log.push(responder.name + ' counters OPSEC! ' + getPlayer(state, chainPid).name + ' can respond...');
      return { ok: true, opsec: true };
    }
    return { error: 'Invalid response' };
  }

  // Check if this player is in an OPSEC chain (being asked to respond after source countered)
  if (pa.opsecChains[playerId] && pa.opsecChains[playerId].responderId === playerId) {
    const chain = pa.opsecChains[playerId];
    if (response === 'accept') {
      // Player accepts — action goes through, they must pay
      delete pa.opsecChains[playerId];
      pa.pending.push(playerId); // put back in pending so they pay
      state.log.push(responder.name + ' accepts — must pay.');
      return { ok: true };
    } else if (response === 'opsec') {
      const idx = responder.hand.findIndex(c => c.action === 'opsec');
      if (idx < 0) return { error: 'No OPSEC card in hand' };
      const opsecCard = responder.hand.splice(idx, 1)[0];
      state.discardPile.push(opsecCard);
      chain.chain++;
      chain.responderId = pa.sourceId;
      state.log.push(responder.name + ' plays OPSEC again! ' + source.name + ' can counter...');
      return { ok: true, opsec: true };
    }
    return { error: 'Invalid response' };
  }

  // Regular pending player responding
  if (!pa.pending?.includes(playerId)) return { error: 'Not your turn to respond' };

  if (response === 'opsec') {
    const idx = responder.hand.findIndex(c => c.action === 'opsec');
    if (idx < 0) return { error: 'No OPSEC card in hand' };
    const opsecCard = responder.hand.splice(idx, 1)[0];
    state.discardPile.push(opsecCard);
    // Remove from pending, create opsec chain
    pa.pending = pa.pending.filter(id => id !== playerId);
    pa.opsecChains[playerId] = { chain: 1, responderId: pa.sourceId };
    state.log.push(responder.name + ' plays OPSEC! ' + source.name + ' can counter...');
    return { ok: true, opsec: true };
  }

  if (response === 'accept') {
    // Process payment directly — set _lastPayer so advancePending removes them
    pa._lastPayer = playerId;
    const result = processPayment(state, pa, responder, source, paymentCards);
    if (result.needPayment) { delete pa._lastPayer; return result; }
    return checkPaymentAllDone(state, pa);
  }

  return { error: 'Invalid response' };
}

function checkPaymentAllDone(state, pa) {
  if (pa.pending.length === 0 && Object.keys(pa.opsecChains || {}).length === 0) {
    state.pendingAction = null;
    state.turnPhase = 'play';
    return { ok: true };
  }
  return { ok: true, morePending: true };
}

function executeAction(state, pa, accepterId, paymentCards) {
  const source = getPlayer(state, pa.sourceId);
  const wasBlocked = (pa._opsecChain || 0) % 2 === 1 && accepterId === pa.sourceId;

  if (wasBlocked) {
    state.log.push('Action blocked by OPSEC!');
    return advancePending(state);
  }

  switch (pa.type) {
    case 'payment':
    case 'payment_all': {
      const payer = getPlayer(state, pa.responderId);
      return processPayment(state, pa, payer, source, paymentCards);
    }

    case 'steal_set': {
      const target = getPlayer(state, pa.targetId);
      const col = pa.color;
      const stolen = target.properties[col] || [];
      if (!source.properties[col]) source.properties[col] = [];
      source.properties[col].push(...stolen);
      target.properties[col] = [];
      if (target.upgrades[col]) {
        source.upgrades[col] = target.upgrades[col];
        delete target.upgrades[col];
      }
      state.log.push(source.name + ' seized ' + target.name + '\'s ' + COLORS[col].name + ' set!');
      checkWin(state, source.id);
      return advancePending(state);
    }

    case 'steal_property': {
      const target = getPlayer(state, pa.targetId);
      const col = pa.targetColor;
      const idx = (target.properties[col] || []).findIndex(c => c.id === pa.targetCardId);
      if (idx >= 0) {
        const card = target.properties[col].splice(idx, 1)[0];
        const destColor = card.placedColor || card.color || col;
        if (!source.properties[destColor]) source.properties[destColor] = [];
        source.properties[destColor].push(card);
        state.log.push(source.name + ' requisitioned ' + card.name + ' from ' + target.name);
        if (!isSetComplete(target, col)) delete target.upgrades[col];
        checkWin(state, source.id);
      }
      return advancePending(state);
    }

    case 'swap': {
      const target = getPlayer(state, pa.targetId);
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
        if (!source.properties[theirColor]) source.properties[theirColor] = [];
        if (!target.properties[myColor]) target.properties[myColor] = [];
        source.properties[theirColor].push(theirCard);
        target.properties[myColor].push(myCard);
        state.log.push(source.name + ' swapped properties with ' + target.name);
        checkWin(state, source.id);
      }
      return advancePending(state);
    }

    case 'chud': {
      const target = getPlayer(state, pa.targetId);
      const col = pa.targetColor;
      const idx = (target.properties[col] || []).findIndex(c => c.id === pa.targetCardId);
      if (idx >= 0) {
        const card = target.properties[col].splice(idx, 1)[0];
        const destColor = card.placedColor || card.color || col;
        if (!source.properties[destColor]) source.properties[destColor] = [];
        source.properties[destColor].push(card);
        state.log.push(source.name + ' commandeered ' + card.name + ' from ' + target.name + '!');
        if (!isSetComplete(target, col)) delete target.upgrades[col];
        checkWin(state, source.id);
      }
      // CHUD also charges 2M
      state.pendingAction = {
        type: 'payment', action: 'chud_payment',
        sourceId: pa.sourceId, targetId: pa.targetId,
        amount: 2, responderId: pa.targetId,
      };
      state.log.push(target.name + ' must also pay ' + source.name + ' 2M (CHUD tax)');
      return { ok: true, morePending: true };
    }
  }
  return advancePending(state);
}

function processPayment(state, pa, payer, payee, selectedCardIds) {
  if (!selectedCardIds || !Array.isArray(selectedCardIds) || selectedCardIds.length === 0) {
    const payerTotal = playerTotalValue(payer);
    if (payerTotal === 0) {
      state.log.push(payer.name + ' has nothing to pay!');
      return advancePending(state);
    }
    return { error: 'Select cards to pay with', needPayment: true, amount: pa.amount };
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

  const payerTotal = playerTotalValue(payer);
  if (totalValue < pa.amount && totalValue < payerTotal)
    return { error: 'You must pay at least ' + pa.amount + 'M (or everything you have)', needPayment: true };

  bankCards.sort((a,b) => b.idx - a.idx);
  bankCards.forEach(({ idx, card }) => {
    payer.bank.splice(idx, 1);
    payee.bank.push(card);
  });

  propCards.forEach(({ color, card }) => {
    const ci = payer.properties[color].findIndex(c => c.id === card.id);
    if (ci >= 0) {
      payer.properties[color].splice(ci, 1);
      const destColor = card.placedColor || card.color || color;
      if (!payee.properties[destColor]) payee.properties[destColor] = [];
      payee.properties[destColor].push(card);
    }
    if (!isSetComplete(payer, color)) delete payer.upgrades[color];
  });

  state.log.push(payer.name + ' paid ' + totalValue + 'M to ' + payee.name);
  checkWin(state, payee.id);
  return advancePending(state);
}

function advancePending(state) {
  const pa = state.pendingAction;
  if (!pa) { state.turnPhase = 'play'; return { ok: true }; }

  if (pa.type === 'payment_all') {
    // For simultaneous payment_all, the payer ID is in pa._lastPayer (set by processPayment caller)
    // Remove the payer from pending
    if (pa._lastPayer) {
      pa.pending = pa.pending.filter(id => id !== pa._lastPayer);
      delete pa._lastPayer;
    }
    // Check if all done
    if (pa.pending.length === 0 && Object.keys(pa.opsecChains || {}).length === 0) {
      state.pendingAction = null;
      state.turnPhase = 'play';
      return { ok: true };
    }
    return { ok: true, morePending: true };
  }

  state.pendingAction = null;
  state.turnPhase = 'play';
  return { ok: true };
}

/* ── Move property (free rearrange) ─────────────────────────────────── */

function moveProperty(state, playerId, cardId, toColor) {
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

  // Move the card
  p.properties[fromColor].splice(fromIdx, 1);
  if (!p.properties[toColor]) p.properties[toColor] = [];
  card.placedColor = toColor;
  p.properties[toColor].push(card);

  // Clean up upgrades if the source set is no longer complete
  if (!isSetComplete(p, fromColor)) delete p.upgrades[fromColor];

  state.log.push(p.name + ' moved ' + card.name + ' to ' + COLORS[toColor].name);
  checkWin(state, playerId);
  return { ok: true };
}

/* ── Scoop (forfeit) ─────────────────────────────────────────────────── */

function scoop(state, playerId) {
  const p = getPlayer(state, playerId);
  if (!p) return { error: 'Player not found' };
  if (p.eliminated) return { error: 'Already eliminated' };

  // Discard all hand cards
  while (p.hand.length > 0) state.discardPile.push(p.hand.pop());
  // Discard all bank cards
  while (p.bank.length > 0) state.discardPile.push(p.bank.pop());
  // Discard all property cards
  for (const [color, cards] of Object.entries(p.properties)) {
    while (cards.length > 0) state.discardPile.push(cards.pop());
    delete p.upgrades[color];
  }
  p.properties = {};
  p.upgrades = {};
  p.eliminated = true;

  state.log.push(p.name + ' scooped! All cards discarded.');

  // Handle pending actions involving this player
  const pa = state.pendingAction;
  if (pa) {
    if (pa.sourceId === playerId) {
      // Scooper was the one who played the action — cancel it
      state.pendingAction = null;
      state.turnPhase = 'play';
    } else if (pa.type === 'payment_all') {
      // Remove scooper from pending
      if (pa.pending) pa.pending = pa.pending.filter(id => id !== playerId);
      // Remove from opsec chains
      if (pa.opsecChains && pa.opsecChains[playerId]) delete pa.opsecChains[playerId];
      // Also resolve any chain where scooper is the responderId
      if (pa.opsecChains) {
        for (const [pid, chain] of Object.entries(pa.opsecChains)) {
          if (chain.responderId === playerId) {
            // Scooper was supposed to respond — treat as blocked
            delete pa.opsecChains[pid];
          }
        }
      }
      checkPaymentAllDone(state, pa);
    } else if (pa.responderId === playerId) {
      // Scooper was the single responder — auto-accept
      state.pendingAction = null;
      state.turnPhase = 'play';
    }
  }

  // If it was the scooper's turn, advance
  const wasMyTurn = currentPlayer(state).id === playerId;
  if (wasMyTurn) {
    delete state._surgeOps;
    state.pendingAction = null;
    state.turnPhase = 'draw';
    state.playsRemaining = 3;
  }

  // Advance past eliminated players
  const activePlayers = state.players.filter(x => !x.eliminated);
  if (activePlayers.length <= 1) {
    // Last player standing wins
    if (activePlayers.length === 1) {
      state.phase = 'finished';
      state.winner = activePlayers[0].id;
      state.log.push(activePlayers[0].name + ' wins — all other players scooped!');
    }
    return { ok: true };
  }

  if (wasMyTurn) {
    // Find next non-eliminated player
    advanceToNextActive(state);
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

function endTurn(state, playerId, discardIds) {
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase === 'action_response') return { error: 'Resolve pending action first' };

  if (p.hand.length > 7) {
    if (!discardIds || !Array.isArray(discardIds))
      return { error: 'Must discard to 7 cards', needDiscard: true, excess: p.hand.length - 7 };
    if (discardIds.length !== p.hand.length - 7)
      return { error: 'Discard exactly ' + (p.hand.length - 7) + ' cards' };
    const toDiscard = discardIds.map(id => {
      const idx = p.hand.findIndex(c => c.id === id);
      return idx >= 0 ? idx : -1;
    }).filter(i => i >= 0).sort((a,b) => b-a);
    toDiscard.forEach(idx => state.discardPile.push(p.hand.splice(idx, 1)[0]));
  }

  delete state._surgeOps;
  advanceToNextActive(state);
  state.turnPhase = 'draw';
  state.playsRemaining = 3;
  state.log.push(currentPlayer(state).name + '\'s turn');
  return { ok: true };
}

/* ── Player view (hides other hands) ─────────────────────────────────── */

function getPlayerView(state, playerId) {
  return {
    phase: state.phase,
    turnPhase: state.turnPhase,
    currentPlayerId: currentPlayer(state).id,
    playsRemaining: state.playsRemaining,
    deckCount: state.deck.length,
    discardTop: state.discardPile.length > 0 ? state.discardPile[state.discardPile.length-1] : null,
    discardPile: [...state.discardPile].reverse(),
    pendingAction: state.pendingAction,
    winner: state.winner,
    surgeOps: !!state._surgeOps,
    log: state.log.slice(-20),
    players: state.players.map(p => ({
      id: p.id, name: p.name,
      handCount: p.hand.length,
      hand: p.id === playerId ? p.hand : undefined,
      bank: p.bank,
      properties: p.properties,
      upgrades: p.upgrades,
      completedSets: completedSets(p),
      eliminated: !!p.eliminated,
    })),
  };
}

module.exports = {
  COLORS, buildDeck, shuffle, createGame, currentPlayer, getPlayer,
  completedSets, checkWin, isSetComplete, calcRent, playerTotalValue,
  drawCards, playAsMoney, playProperty, playAction, respondToAction,
  moveProperty, scoop, endTurn, getPlayerView,
};
