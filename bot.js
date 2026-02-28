// bot.js — Bot AI engine for Chudopoly GO with 5 personality modes
const G = require('./game');

/* ── Timing ─────────────────────────────────────────────────────────── */

const DELAYS = {
  random:       { draw:[600,1500], play:[600,1800], respond:[400,1200] },
  conservative: { draw:[800,2000], play:[1000,2800], respond:[600,1600] },
  neutral:      { draw:[600,1500], play:[800,2500], respond:[500,1500] },
  aggressive:   { draw:[500,1200], play:[600,2000], respond:[400,1200] },
  chud:         { draw:[300,800],  play:[300,800],  respond:[200,600]  },
};

function getDelay(mode, action) {
  const d = DELAYS[mode] || DELAYS.neutral;
  const range = d[action] || d.play;
  return range[0] + Math.random() * (range[1] - range[0]);
}

/* ── Scheduling ─────────────────────────────────────────────────────── */

function scheduleBotAction(room, callbacks) {
  if (!room?.state || room.state.phase !== 'playing') return;
  if (room._botTimeout) return; // already scheduled

  const state = room.state;

  // Check if a bot needs to respond to a pending action
  if (state.pendingAction) {
    const botId = findRespondingBot(room, state);
    if (botId) {
      const mode = getBotMode(room, botId);
      room._botTimeout = setTimeout(() => {
        delete room._botTimeout;
        if (!room.state || room.state.phase !== 'playing') return;
        // Verify the bot still needs to respond (state may have changed)
        const stillNeeds = findRespondingBot(room, room.state);
        if (stillNeeds === botId) {
          botRespond(room, botId, callbacks);
        } else {
          scheduleBotAction(room, callbacks);
        }
      }, getDelay(mode, 'respond'));
      return;
    }
    return; // pending action waiting for human
  }

  // Check if it's a bot's turn
  const cp = G.currentPlayer(state);
  const botPlayer = room.players.find(p => p.id === cp.id);
  if (!botPlayer?.isBot || cp.eliminated) return;

  const mode = botPlayer.botMode || 'neutral';
  const action = state.turnPhase === 'draw' ? 'draw' : 'play';
  room._botTimeout = setTimeout(() => {
    delete room._botTimeout;
    if (!room.state || room.state.phase !== 'playing') return;
    const currentCp = G.currentPlayer(room.state);
    if (currentCp.id !== cp.id) return; // turn changed
    const bp = room.players.find(p => p.id === cp.id);
    if (!bp?.isBot) return; // human reclaimed
    botTakeTurn(room, cp.id, callbacks);
  }, getDelay(mode, action));
}

function cancelBotTimeout(room) {
  if (room._botTimeout) {
    clearTimeout(room._botTimeout);
    delete room._botTimeout;
  }
}

function getBotMode(room, botId) {
  const p = room.players.find(x => x.id === botId);
  return p?.botMode || 'neutral';
}

/* ── Find which bot needs to respond ────────────────────────────────── */

function findRespondingBot(room, state) {
  const pa = state.pendingAction;
  if (!pa) return null;

  if (pa.type === 'payment_all') {
    for (const pid of (pa.pending || [])) {
      if (room.players.find(p => p.id === pid)?.isBot) return pid;
    }
    // Check opsec chains — find bots that are the current responderId
    for (const [pid, chain] of Object.entries(pa.opsecChains || {})) {
      const resp = room.players.find(p => p.id === chain.responderId);
      if (resp?.isBot) return chain.responderId;
    }
  } else {
    if (pa.responderId) {
      const resp = room.players.find(p => p.id === pa.responderId);
      if (resp?.isBot) return pa.responderId;
    }
  }
  return null;
}

/* ── Bot turn execution ─────────────────────────────────────────────── */

function botTakeTurn(room, botId, callbacks) {
  if (!room?.state || room.state.phase !== 'playing') return;
  const state = room.state;
  const cp = G.currentPlayer(state);
  if (cp.id !== botId || cp.eliminated) return;
  const mode = getBotMode(room, botId);

  // DRAW PHASE
  if (state.turnPhase === 'draw') {
    const result = G.drawCards(state);
    if (result.autoWin) callbacks.clearTimer(room);
    callbacks.broadcast(room);
    if (state.phase === 'finished') return;
    scheduleBotAction(room, callbacks);
    return;
  }

  // PLAY PHASE
  if (state.turnPhase === 'play') {
    // Chud mode: random chance to end turn early
    if (mode === 'chud' && state.playsRemaining > 0 && Math.random() < 0.4) {
      botEndTurn(state, room, botId, mode, callbacks);
      return;
    }

    const action = decideBotPlay(state, botId, mode);
    if (action) {
      executeBotPlay(state, room, botId, action, callbacks);
      callbacks.broadcast(room);
      if (state.phase === 'finished') return;
      scheduleBotAction(room, callbacks);
      return;
    }
    // No good play: end turn
    botEndTurn(state, room, botId, mode, callbacks);
    return;
  }
}

/* ── Bot response to pending actions ────────────────────────────────── */

function botRespond(room, botId, callbacks) {
  if (!room?.state || room.state.phase !== 'playing') return;
  const state = room.state;
  const pa = state.pendingAction;
  if (!pa) return;

  const bot = G.getPlayer(state, botId);
  if (!bot) return;
  const mode = getBotMode(room, botId);
  const hasOpsec = bot.hand.some(c => c.action === 'opsec');

  const shouldOpsec = hasOpsec && shouldPlayOpsec(pa, mode, botId);

  if (shouldOpsec) {
    const result = G.respondToAction(state, botId, 'opsec');
    if (result.error) {
      // Fallback: accept
      acceptAction(state, bot, botId, pa, mode);
    }
    callbacks.broadcast(room);
    if (state.phase === 'finished') return;
    scheduleBotAction(room, callbacks);
    return;
  }

  // Accept
  acceptAction(state, bot, botId, pa, mode);
  callbacks.broadcast(room);
  if (state.phase === 'finished') return;
  scheduleBotAction(room, callbacks);
}

function acceptAction(state, bot, botId, pa, mode) {
  // Check if this is a payment situation
  const needsPayment = pa.type === 'payment' || pa.type === 'payment_all' ||
    pa.type === 'chud' || pa.action === 'chud_payment' ||
    pa.action === 'finance_office' || pa.action === 'roll_call' || pa.action === 'rent';

  if (needsPayment && pa.amount > 0) {
    const payCards = selectPaymentCards(bot, pa.amount, mode);
    const result = G.respondToAction(state, botId, 'accept', payCards.length > 0 ? payCards : undefined);
    if (result?.needPayment) {
      // Not enough — pay everything
      const allCards = getAllPayableCardIds(bot);
      G.respondToAction(state, botId, 'accept', allCards.length > 0 ? allCards : undefined);
    }
  } else {
    G.respondToAction(state, botId, 'accept');
  }
}

/* ── OPSEC decision per mode ────────────────────────────────────────── */

function shouldPlayOpsec(pa, mode, botId) {
  // In OPSEC chain, check if we're the responderId
  const isChainResponse = pa._opsecChain > 0 ||
    (pa.opsecChains && Object.values(pa.opsecChains).some(c => c.responderId === botId));

  switch (mode) {
    case 'random':
      return Math.random() > 0.5;

    case 'conservative':
      // Always play OPSEC — hoard defense
      return true;

    case 'neutral':
      // Play against high-value actions
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return true;
      if (pa.action === 'finance_office') return true;
      if (pa.action === 'rent' && pa.amount >= 5) return true;
      if (pa.action === 'chud_payment') return false; // only 2M, save it
      if (isChainResponse) return true; // always counter in chains
      return false;

    case 'aggressive':
      // Only protect against the biggest threats
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return true;
      if (isChainResponse) return true;
      return false;

    case 'chud':
      // Play OPSEC against trivial stuff, accept devastating stuff
      if (pa.action === 'roll_call') return true; // block 2M, lol
      if (pa.action === 'rent' && pa.amount <= 2) return true;
      if (pa.action === 'inspector_general') return false; // accept set theft!
      if (pa.action === 'chud') return false; // accept CHUD!
      if (pa.action === 'finance_office') return false;
      return Math.random() > 0.7; // random for everything else

    default:
      return false;
  }
}

/* ── Core decision engine ───────────────────────────────────────────── */

function decideBotPlay(state, botId, mode) {
  const bot = G.getPlayer(state, botId);
  if (!bot || state.playsRemaining <= 0) return null;
  if (bot.hand.length === 0) return null;

  switch (mode) {
    case 'random':     return decideRandom(state, bot, botId);
    case 'conservative': return decideConservative(state, bot, botId);
    case 'neutral':    return decideNeutral(state, bot, botId);
    case 'aggressive': return decideAggressive(state, bot, botId);
    case 'chud':       return decideChud(state, bot, botId);
    default:           return decideNeutral(state, bot, botId);
  }
}

/* ── RANDOM MODE ────────────────────────────────────────────────────── */

function decideRandom(state, bot, botId) {
  // Random chance to end early
  if (Math.random() < 0.3) return null;

  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // Shuffle indices
  const indices = hand.map((_, i) => i);
  shuffle(indices);

  for (const i of indices) {
    const c = hand[i];

    if (c.type === 'property') {
      return { type: 'play_property', cardIndex: i };
    }
    if (c.type === 'wild_property') {
      const validColors = c.colors[0] === 'any' ? Object.keys(G.COLORS) : c.colors;
      const color = validColors[Math.floor(Math.random() * validColors.length)];
      return { type: 'play_property', cardIndex: i, targetColor: color };
    }
    if (c.type === 'money') {
      return { type: 'play_money', cardIndex: i };
    }
    if (c.type === 'rent') {
      const color = randomRentColor(bot, c);
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (c.type === 'action') {
      const action = tryRandomAction(state, bot, botId, c, i, opponents);
      if (action) return action;
    }
  }
  return null;
}

function tryRandomAction(state, bot, botId, card, idx, opponents) {
  switch (card.action) {
    case 'pcs_orders':
      return { type: 'play_action', cardIndex: idx };
    case 'roll_call':
      return { type: 'play_action', cardIndex: idx };
    case 'surge_ops':
      return { type: 'play_action', cardIndex: idx };
    case 'finance_office': {
      const t = opponents.length > 0 ? opponents[Math.floor(Math.random() * opponents.length)] : null;
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.id } : null;
    }
    case 'midnight_requisition': {
      const t = findRandomStealTarget(opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.playerId, targetCardId: t.cardId } : null;
    }
    case 'chud': {
      const t = findRandomChudTarget(opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.playerId, targetCardId: t.cardId } : null;
    }
    case 'inspector_general': {
      const t = findRandomIGTarget(opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.id, targetColor: t.color } : null;
    }
    case 'tdy_orders': {
      const t = findRandomSwapTarget(bot, opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.targetPlayerId, targetCardId: t.targetCardId, myCardId: t.myCardId } : null;
    }
    case 'upgrade': {
      const color = findUpgradeableSet(bot, 'upgrade');
      return color ? { type: 'play_action', cardIndex: idx, targetColor: color } : null;
    }
    case 'foc': {
      const color = findUpgradeableSet(bot, 'foc');
      return color ? { type: 'play_action', cardIndex: idx, targetColor: color } : null;
    }
    case 'opsec':
      return null; // never play proactively
    default:
      return { type: 'play_money', cardIndex: idx };
  }
}

/* ── CONSERVATIVE MODE ──────────────────────────────────────────────── */

function decideConservative(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const closeTo = G.completedSets(bot) >= 2; // 1 set away from winning

  // 1. Properties
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'property') return { type: 'play_property', cardIndex: i };
    if (c.type === 'wild_property') {
      return { type: 'play_property', cardIndex: i, targetColor: chooseBestColorForWild(bot, c) };
    }
  }

  // 2. PCS Orders
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 3. Upgrade/FOC
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'upgrade') {
      const color = findUpgradeableSet(bot, 'upgrade');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (hand[i].action === 'foc') {
      const color = findUpgradeableSet(bot, 'foc');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }

  // 4. Surge Ops + Rent on complete sets
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  const rentOnComplete = findRentOnCompleteSet(bot, hand);
  if (surgeIdx >= 0 && rentOnComplete && !state._surgeOps && state.playsRemaining >= 2) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 5. Rent on complete sets ONLY
  if (rentOnComplete) {
    return { type: 'play_action', cardIndex: rentOnComplete.cardIndex, targetColor: rentOnComplete.color };
  }

  // 6. If close to winning, become aggressive
  if (closeTo) {
    // Try offensive actions
    const offensive = tryOffensiveActions(state, bot, botId, hand, opponents, 'conservative');
    if (offensive) return offensive;
  }

  // 7. Bank everything else (except OPSEC)
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.action === 'opsec') continue; // hold OPSEC
    if (c.type === 'property' || c.type === 'wild_property') continue; // already handled
    if (c.type === 'money' || c.type === 'rent' || c.type === 'action') {
      return { type: 'play_money', cardIndex: i };
    }
  }

  return null;
}

/* ── NEUTRAL MODE ───────────────────────────────────────────────────── */

function decideNeutral(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // 1. Properties
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'property') return { type: 'play_property', cardIndex: i };
    if (c.type === 'wild_property') {
      return { type: 'play_property', cardIndex: i, targetColor: chooseBestColorForWild(bot, c) };
    }
  }

  // 2. PCS Orders
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 3. Surge Ops (if we have rent and 2+ plays)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  const hasRent = hand.some(c => c.type === 'rent');
  if (surgeIdx >= 0 && hasRent && !state._surgeOps && state.playsRemaining >= 2) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 4. Rent (prefer highest, plays on incomplete sets if rent >= 3)
  const rentPlay = findBestRent(bot, hand, 3);
  if (rentPlay) return rentPlay;

  // 5. Offensive actions
  const offensive = tryOffensiveActions(state, bot, botId, hand, opponents, 'neutral');
  if (offensive) return offensive;

  // 6. Upgrade/FOC
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'upgrade') {
      const color = findUpgradeableSet(bot, 'upgrade');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (hand[i].action === 'foc') {
      const color = findUpgradeableSet(bot, 'foc');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }

  // 7. Bank
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.action === 'opsec') continue;
    if (c.type === 'money') return { type: 'play_money', cardIndex: i };
    if (c.type === 'action' && c.value > 0) return { type: 'play_money', cardIndex: i };
    if (c.type === 'rent') return { type: 'play_money', cardIndex: i };
  }

  return null;
}

/* ── AGGRESSIVE MODE ────────────────────────────────────────────────── */

function decideAggressive(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // 1. Surge Ops first (before rent)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  const hasRent = hand.some(c => c.type === 'rent');
  if (surgeIdx >= 0 && hasRent && !state._surgeOps && state.playsRemaining >= 2) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 2. Rent — any color with properties, maximize damage
  const rentPlay = findBestRent(bot, hand, 0); // no minimum threshold
  if (rentPlay) return rentPlay;

  // 3. CHUD — immediate
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'chud') {
      const target = findAggressiveChudTarget(state, bot, botId, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 4. Inspector General — immediate
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'inspector_general') {
      const target = findBestIGTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color };
    }
  }

  // 5. Finance Office — target most properties
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = findMostPropertyPlayer(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // 6. Roll Call
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0) return { type: 'play_action', cardIndex: rcIdx };

  // 7. Midnight Requisition
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      const target = findSmartStealTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 8. TDY Orders — trade up
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'tdy_orders') {
      const target = findAggressiveSwapTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.targetPlayerId, targetCardId: target.targetCardId, myCardId: target.myCardId };
    }
  }

  // 9. Properties (lower priority for aggressive)
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'property') return { type: 'play_property', cardIndex: i };
    if (c.type === 'wild_property') {
      return { type: 'play_property', cardIndex: i, targetColor: chooseBestColorForWild(bot, c) };
    }
  }

  // 10. PCS Orders
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 11. Upgrade/FOC
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'upgrade') {
      const color = findUpgradeableSet(bot, 'upgrade');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (hand[i].action === 'foc') {
      const color = findUpgradeableSet(bot, 'foc');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }

  // 12. Bank only when nothing else
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.action === 'opsec') continue;
    if (c.type === 'money') return { type: 'play_money', cardIndex: i };
    if (c.type === 'rent') return { type: 'play_money', cardIndex: i };
    if (c.type === 'action') return { type: 'play_money', cardIndex: i };
  }

  return null;
}

/* ── CHUD MODE — anti-strategy ──────────────────────────────────────── */

function decideChud(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // 1. Bank money/rent first (waste plays on banking)
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'money') return { type: 'play_money', cardIndex: i };
  }
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'rent') return { type: 'play_money', cardIndex: i };
  }

  // 2. Surge Ops (then DON'T play rent — will bank or play property next)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 3. TDY Orders — swap best for worst
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'tdy_orders') {
      const target = findChudSwapTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.targetPlayerId, targetCardId: target.targetCardId, myCardId: target.myCardId };
    }
  }

  // 4. Finance Office — target poorest
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = findPoorestPlayer(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // 5. Roll Call
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0) return { type: 'play_action', cardIndex: rcIdx };

  // 6. Midnight Requisition — steal cheapest
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      const target = findCheapestStealTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 7. CHUD — target player with fewest properties, steal cheapest
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'chud') {
      const target = findChudChudTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 8. Inspector General — target cheapest complete set
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'inspector_general') {
      const target = findCheapestIGTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color };
    }
  }

  // 9. Bank action cards (including OPSEC — chud doesn't care)
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'action' && c.action !== 'opsec') {
      return { type: 'play_money', cardIndex: i };
    }
  }

  // 10. Properties last — wild on random color
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'property') return { type: 'play_property', cardIndex: i };
    if (c.type === 'wild_property') {
      const validColors = c.colors[0] === 'any' ? Object.keys(G.COLORS) : c.colors;
      const color = validColors[Math.floor(Math.random() * validColors.length)];
      return { type: 'play_property', cardIndex: i, targetColor: color };
    }
  }

  // 11. PCS Orders last (opposite of optimal)
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  return null;
}

/* ── Shared offensive action helpers ────────────────────────────────── */

function tryOffensiveActions(state, bot, botId, hand, opponents, mode) {
  // Inspector General
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'inspector_general') {
      const target = findBestIGTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color };
    }
  }

  // CHUD
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'chud') {
      const target = findSmartChudTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // Midnight Requisition
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      const target = findSmartStealTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // Finance Office
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = findRichestPlayer(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // Roll Call
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0) return { type: 'play_action', cardIndex: rcIdx };

  // TDY Orders
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'tdy_orders') {
      const target = findSmartSwapTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.targetPlayerId, targetCardId: target.targetCardId, myCardId: target.myCardId };
    }
  }

  return null;
}

/* ── Execute bot play ───────────────────────────────────────────────── */

function executeBotPlay(state, room, botId, action, callbacks) {
  let result;
  switch (action.type) {
    case 'play_property':
      result = G.playProperty(state, botId, action.cardIndex, action.targetColor);
      break;
    case 'play_money':
      result = G.playAsMoney(state, botId, action.cardIndex);
      break;
    case 'play_action':
      result = G.playAction(state, botId, action.cardIndex, {
        targetId: action.targetId,
        targetColor: action.targetColor,
        targetCardId: action.targetCardId,
        myCardId: action.myCardId,
      });
      break;
  }
  if (result?.error) {
    console.log(`[BOT] ${botId} play error: ${result.error}`);
  }
  if (state.phase === 'finished') callbacks.clearTimer(room);
}

/* ── End turn ───────────────────────────────────────────────────────── */

function botEndTurn(state, room, botId, mode, callbacks) {
  const bot = G.getPlayer(state, botId);
  if (!bot) return;

  let discardIds;
  if (bot.hand.length > 7) {
    discardIds = chooseDiscards(bot, bot.hand.length - 7, mode);
  }

  const result = G.endTurn(state, botId, discardIds);
  if (result.error) {
    // Force advance
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
    state.turnPhase = 'draw';
    state.playsRemaining = 3;
  }
  callbacks.startTimer(room);
  callbacks.broadcast(room);
  scheduleBotAction(room, callbacks);
}

/* ── Target selection helpers ───────────────────────────────────────── */

function findLeader(opponents) {
  if (opponents.length === 0) return null;
  return opponents.reduce((best, p) => {
    const bSets = G.completedSets(best);
    const pSets = G.completedSets(p);
    if (pSets > bSets) return p;
    if (pSets === bSets && totalProps(p) > totalProps(best)) return p;
    return best;
  });
}

function findPoorestPlayer(opponents) {
  if (opponents.length === 0) return null;
  return opponents.reduce((worst, p) => {
    return G.playerTotalValue(p) < G.playerTotalValue(worst) ? p : worst;
  });
}

function findRichestPlayer(opponents) {
  if (opponents.length === 0) return null;
  return opponents.reduce((best, p) => {
    const bBank = p.bank.reduce((s, c) => s + c.value, 0);
    const bestBank = best.bank.reduce((s, c) => s + c.value, 0);
    return bBank > bestBank ? p : best;
  });
}

function findMostPropertyPlayer(opponents) {
  if (opponents.length === 0) return null;
  return opponents.reduce((best, p) => totalProps(p) > totalProps(best) ? p : best);
}

function totalProps(player) {
  let count = 0;
  for (const cards of Object.values(player.properties)) count += cards.length;
  return count;
}

/* ── Wild card color selection ──────────────────────────────────────── */

function chooseBestColorForWild(bot, card) {
  const validColors = card.colors[0] === 'any' ? Object.keys(G.COLORS) : card.colors;
  let best = validColors[0];
  let bestScore = -1;
  for (const color of validColors) {
    const info = G.COLORS[color];
    if (!info) continue;
    const have = (bot.properties[color] || []).length;
    const score = have / info.size; // closer to 1 = closer to completion
    if (score > bestScore) { bestScore = score; best = color; }
  }
  return best;
}

/* ── Rent helpers ───────────────────────────────────────────────────── */

function findBestRent(bot, hand, minRent) {
  let bestRent = null;
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type !== 'rent') continue;
    const color = chooseBestRentColor(bot, c);
    if (!color) continue;
    const rent = G.calcRent(bot, color);
    if (rent < minRent) continue;
    if (!bestRent || rent > bestRent.rent) {
      bestRent = { cardIndex: i, color, rent };
    }
  }
  if (!bestRent) return null;
  return { type: 'play_action', cardIndex: bestRent.cardIndex, targetColor: bestRent.color };
}

function chooseBestRentColor(bot, card) {
  const validColors = card.colors[0] === 'any'
    ? Object.keys(bot.properties).filter(c => (bot.properties[c] || []).length > 0)
    : card.colors.filter(c => (bot.properties[c] || []).length > 0);
  if (validColors.length === 0) return null;
  return validColors.reduce((best, col) =>
    G.calcRent(bot, col) > G.calcRent(bot, best) ? col : best);
}

function randomRentColor(bot, card) {
  const validColors = card.colors[0] === 'any'
    ? Object.keys(bot.properties).filter(c => (bot.properties[c] || []).length > 0)
    : card.colors.filter(c => (bot.properties[c] || []).length > 0);
  return validColors.length > 0 ? validColors[Math.floor(Math.random() * validColors.length)] : null;
}

function findRentOnCompleteSet(bot, hand) {
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type !== 'rent') continue;
    const validColors = c.colors[0] === 'any'
      ? Object.keys(bot.properties)
      : c.colors;
    for (const color of validColors) {
      if (G.isSetComplete(bot, color)) {
        return { cardIndex: i, color };
      }
    }
  }
  return null;
}

/* ── Inspector General targets ──────────────────────────────────────── */

function findBestIGTarget(opponents) {
  let best = null;
  let bestValue = -1;
  for (const opp of opponents) {
    for (const [color, cards] of Object.entries(opp.properties)) {
      if (!G.isSetComplete(opp, color)) continue;
      const value = cards.reduce((s, c) => s + c.value, 0);
      if (value > bestValue) { bestValue = value; best = { id: opp.id, color }; }
    }
  }
  return best;
}

function findRandomIGTarget(opponents) {
  const targets = [];
  for (const opp of opponents) {
    for (const [color] of Object.entries(opp.properties)) {
      if (G.isSetComplete(opp, color)) targets.push({ id: opp.id, color });
    }
  }
  return targets.length > 0 ? targets[Math.floor(Math.random() * targets.length)] : null;
}

function findCheapestIGTarget(opponents) {
  let worst = null;
  let worstValue = Infinity;
  for (const opp of opponents) {
    for (const [color, cards] of Object.entries(opp.properties)) {
      if (!G.isSetComplete(opp, color)) continue;
      const value = cards.reduce((s, c) => s + c.value, 0);
      if (value < worstValue) { worstValue = value; worst = { id: opp.id, color }; }
    }
  }
  return worst;
}

/* ── CHUD / steal targets ───────────────────────────────────────────── */

function findSmartChudTarget(bot, opponents) {
  // First: property that completes one of our sets
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have > 0 && have < info.size) {
      for (const opp of opponents) {
        const oppCards = opp.properties[color] || [];
        for (const c of oppCards) {
          return { playerId: opp.id, cardId: c.id };
        }
      }
    }
  }
  // Fallback: highest value property from leader
  const leader = findLeader(opponents);
  if (!leader) return null;
  let best = null;
  for (const cards of Object.values(leader.properties)) {
    for (const c of cards) {
      if (!best || c.value > best.value) best = { playerId: leader.id, cardId: c.id, value: c.value };
    }
  }
  return best;
}

function findAggressiveChudTarget(state, bot, botId, opponents) {
  // Target the leader's most valuable property
  const leader = findLeader(opponents);
  if (!leader) return null;
  let best = null;
  for (const cards of Object.values(leader.properties)) {
    for (const c of cards) {
      if (!best || c.value > best.value) best = { playerId: leader.id, cardId: c.id, value: c.value };
    }
  }
  return best;
}

function findChudChudTarget(opponents) {
  // Target player with FEWEST properties, steal CHEAPEST card
  let weakest = null;
  let fewestProps = Infinity;
  for (const opp of opponents) {
    const count = totalProps(opp);
    if (count > 0 && count < fewestProps) { fewestProps = count; weakest = opp; }
  }
  if (!weakest) return null;
  let cheapest = null;
  for (const cards of Object.values(weakest.properties)) {
    for (const c of cards) {
      if (!cheapest || c.value < cheapest.value) cheapest = { playerId: weakest.id, cardId: c.id, value: c.value };
    }
  }
  return cheapest;
}

function findRandomChudTarget(opponents) {
  const all = [];
  for (const opp of opponents) {
    for (const cards of Object.values(opp.properties)) {
      for (const c of cards) all.push({ playerId: opp.id, cardId: c.id });
    }
  }
  return all.length > 0 ? all[Math.floor(Math.random() * all.length)] : null;
}

/* ── Steal targets (Midnight Requisition) ───────────────────────────── */

function findSmartStealTarget(bot, opponents) {
  // Prefer cards that complete our sets
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have > 0 && have < info.size) {
      for (const opp of opponents) {
        if (G.isSetComplete(opp, color)) continue;
        const oppCards = opp.properties[color] || [];
        for (const c of oppCards) {
          return { playerId: opp.id, cardId: c.id };
        }
      }
    }
  }
  // Fallback: most valuable stealable property
  let best = null;
  for (const opp of opponents) {
    for (const [col, cards] of Object.entries(opp.properties)) {
      if (G.isSetComplete(opp, col)) continue;
      for (const c of cards) {
        if (!best || c.value > best.value) best = { playerId: opp.id, cardId: c.id, value: c.value };
      }
    }
  }
  return best;
}

function findCheapestStealTarget(opponents) {
  let cheapest = null;
  for (const opp of opponents) {
    for (const [col, cards] of Object.entries(opp.properties)) {
      if (G.isSetComplete(opp, col)) continue;
      for (const c of cards) {
        if (!cheapest || c.value < cheapest.value) cheapest = { playerId: opp.id, cardId: c.id, value: c.value };
      }
    }
  }
  return cheapest;
}

function findRandomStealTarget(opponents) {
  const all = [];
  for (const opp of opponents) {
    for (const [col, cards] of Object.entries(opp.properties)) {
      if (G.isSetComplete(opp, col)) continue;
      for (const c of cards) all.push({ playerId: opp.id, cardId: c.id });
    }
  }
  return all.length > 0 ? all[Math.floor(Math.random() * all.length)] : null;
}

/* ── Swap targets (TDY Orders) ──────────────────────────────────────── */

function findSmartSwapTarget(bot, opponents) {
  // Find my least valuable property from a color I have only 1 of
  let myWorst = null;
  for (const [col, cards] of Object.entries(bot.properties)) {
    if (cards.length !== 1) continue; // only swap from isolated singles
    for (const c of cards) {
      if (!myWorst || c.value < myWorst.value) myWorst = { cardId: c.id, value: c.value, color: col };
    }
  }
  if (!myWorst) return null;

  // Find opponent's property that helps complete one of our sets
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have > 0 && have < info.size && color !== myWorst.color) {
      for (const opp of opponents) {
        const oppCards = opp.properties[color] || [];
        for (const c of oppCards) {
          return { targetPlayerId: opp.id, targetCardId: c.id, myCardId: myWorst.cardId };
        }
      }
    }
  }
  return null;
}

function findAggressiveSwapTarget(bot, opponents) {
  // Trade worst for best
  let myWorst = null;
  for (const [col, cards] of Object.entries(bot.properties)) {
    for (const c of cards) {
      if (!myWorst || c.value < myWorst.value) myWorst = { cardId: c.id, value: c.value };
    }
  }
  if (!myWorst) return null;

  let theirBest = null;
  for (const opp of opponents) {
    for (const cards of Object.values(opp.properties)) {
      for (const c of cards) {
        if (c.value > myWorst.value && (!theirBest || c.value > theirBest.value)) {
          theirBest = { targetPlayerId: opp.id, targetCardId: c.id, myCardId: myWorst.cardId, value: c.value };
        }
      }
    }
  }
  return theirBest;
}

function findChudSwapTarget(bot, opponents) {
  // Swap BEST property for opponent's WORST — actively trade down
  let myBest = null;
  for (const [col, cards] of Object.entries(bot.properties)) {
    for (const c of cards) {
      if (!myBest || c.value > myBest.value) myBest = { cardId: c.id, value: c.value };
    }
  }
  if (!myBest) return null;

  let theirWorst = null;
  for (const opp of opponents) {
    for (const cards of Object.values(opp.properties)) {
      for (const c of cards) {
        if (!theirWorst || c.value < theirWorst.value) {
          theirWorst = { targetPlayerId: opp.id, targetCardId: c.id, myCardId: myBest.cardId, value: c.value };
        }
      }
    }
  }
  return theirWorst;
}

function findRandomSwapTarget(bot, opponents) {
  const myCards = [];
  for (const cards of Object.values(bot.properties)) {
    for (const c of cards) myCards.push(c.id);
  }
  if (myCards.length === 0) return null;

  const theirCards = [];
  for (const opp of opponents) {
    for (const cards of Object.values(opp.properties)) {
      for (const c of cards) theirCards.push({ playerId: opp.id, cardId: c.id });
    }
  }
  if (theirCards.length === 0) return null;

  const my = myCards[Math.floor(Math.random() * myCards.length)];
  const their = theirCards[Math.floor(Math.random() * theirCards.length)];
  return { targetPlayerId: their.playerId, targetCardId: their.cardId, myCardId: my };
}

/* ── Upgrade helpers ────────────────────────────────────────────────── */

function findUpgradeableSet(bot, type) {
  for (const [color] of Object.entries(bot.properties)) {
    if (!G.isSetComplete(bot, color)) continue;
    const ups = bot.upgrades[color] || [];
    if (type === 'upgrade' && !ups.includes('house')) return color;
    if (type === 'foc' && ups.includes('house') && !ups.includes('hotel')) return color;
  }
  return null;
}

/* ── Payment selection ──────────────────────────────────────────────── */

function selectPaymentCards(bot, amount, mode) {
  const cards = [];
  bot.bank.forEach(c => cards.push({ id: c.id, value: c.value, source: 'bank' }));
  for (const [color, propCards] of Object.entries(bot.properties)) {
    const setProgress = (propCards.length || 0) / (G.COLORS[color]?.size || 99);
    propCards.forEach(c => cards.push({ id: c.id, value: c.value, source: 'prop', color, setProgress }));
  }
  if (cards.length === 0) return [];

  switch (mode) {
    case 'chud':
      // Pay with MOST valuable first, prioritize near-complete sets (maximum self-damage)
      cards.sort((a, b) => {
        if (a.source === 'prop' && b.source === 'bank') return -1; // props first
        if (a.source === 'bank' && b.source === 'prop') return 1;
        if (a.source === 'prop' && b.source === 'prop') return (b.setProgress || 0) - (a.setProgress || 0); // near-complete first
        return b.value - a.value; // highest value first
      });
      break;

    case 'conservative':
      // Bank first (smallest), properties only as absolute last resort
      cards.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'bank' ? -1 : 1;
        if (a.source === 'prop') return (a.setProgress || 0) - (b.setProgress || 0); // least progress first
        return a.value - b.value;
      });
      break;

    case 'aggressive':
      // Bank first, then isolated properties (1 card in color), protect near-complete sets
      cards.sort((a, b) => {
        if (a.source === 'bank' && b.source === 'prop') return -1;
        if (a.source === 'prop' && b.source === 'bank') return 1;
        if (a.source === 'prop' && b.source === 'prop') return (a.setProgress || 0) - (b.setProgress || 0);
        return a.value - b.value;
      });
      break;

    case 'random':
      shuffle(cards);
      break;

    default: // neutral
      // Bank first (smallest to largest), then properties (least valuable, furthest from completion)
      cards.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'bank' ? -1 : 1;
        if (a.source === 'prop') return (a.setProgress || 0) - (b.setProgress || 0);
        return a.value - b.value;
      });
      break;
  }

  const selected = [];
  let total = 0;
  for (const c of cards) {
    if (total >= amount) break;
    selected.push(c.id);
    total += c.value;
  }
  return selected;
}

function getAllPayableCardIds(bot) {
  const ids = [];
  bot.bank.forEach(c => ids.push(c.id));
  for (const cards of Object.values(bot.properties)) {
    cards.forEach(c => ids.push(c.id));
  }
  return ids;
}

/* ── Discard selection ──────────────────────────────────────────────── */

function chooseDiscards(bot, excess, mode) {
  const hand = [...bot.hand];

  switch (mode) {
    case 'chud':
      // Discard OPSEC and high-value action cards first. Keep junk.
      hand.sort((a, b) => {
        if (a.action === 'opsec' && b.action !== 'opsec') return -1;
        if (b.action === 'opsec' && a.action !== 'opsec') return 1;
        if (a.type === 'action' && b.type !== 'action') return -1;
        if (b.type === 'action' && a.type !== 'action') return 1;
        return b.value - a.value; // highest value first
      });
      break;

    case 'conservative':
      // Discard high-value offensive action cards, keep OPSEC and properties
      hand.sort((a, b) => {
        // Keep OPSEC at all costs
        if (a.action === 'opsec') return 1;
        if (b.action === 'opsec') return -1;
        // Keep properties
        if ((a.type === 'property' || a.type === 'wild_property') &&
            b.type !== 'property' && b.type !== 'wild_property') return 1;
        if ((b.type === 'property' || b.type === 'wild_property') &&
            a.type !== 'property' && a.type !== 'wild_property') return -1;
        // Discard offensive actions first
        const offensiveA = ['inspector_general','chud','midnight_requisition','tdy_orders','finance_office','roll_call'].includes(a.action);
        const offensiveB = ['inspector_general','chud','midnight_requisition','tdy_orders','finance_office','roll_call'].includes(b.action);
        if (offensiveA && !offensiveB) return -1;
        if (offensiveB && !offensiveA) return 1;
        return a.value - b.value;
      });
      break;

    case 'aggressive':
      // Discard money and isolated properties, keep action cards
      hand.sort((a, b) => {
        if (a.type === 'money' && b.type !== 'money') return -1;
        if (b.type === 'money' && a.type !== 'money') return 1;
        // Keep action cards
        if (a.type === 'action' && b.type !== 'action') return 1;
        if (b.type === 'action' && a.type !== 'action') return -1;
        return a.value - b.value;
      });
      break;

    case 'random':
      shuffle(hand);
      break;

    default: // neutral
      // Discard lowest value, keep OPSEC
      hand.sort((a, b) => {
        if (a.action === 'opsec') return 1;
        if (b.action === 'opsec') return -1;
        return a.value - b.value;
      });
      break;
  }

  return hand.slice(0, excess).map(c => c.id);
}

/* ── Utility ────────────────────────────────────────────────────────── */

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { scheduleBotAction, cancelBotTimeout };
