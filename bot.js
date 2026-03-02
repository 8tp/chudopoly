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
    if (currentCp.id !== cp.id) return;
    const bp = room.players.find(p => p.id === cp.id);
    if (!bp?.isBot) return;
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

/* ── Situational awareness helpers ─────────────────────────────────── */

function threatLevel(opponents) {
  // How close is any opponent to winning? Returns 0-3
  let maxSets = 0;
  for (const opp of opponents) {
    const sets = G.completedSets(opp);
    if (sets > maxSets) maxSets = sets;
  }
  return maxSets;
}

function findThreats(opponents) {
  // Find opponents with 2+ complete sets (1 away from winning)
  return opponents.filter(opp => G.completedSets(opp) >= 2);
}

function myProgress(bot) {
  // How many sets toward each color?
  const progress = {};
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    progress[color] = { have, need: info.size, pct: have / info.size };
  }
  return progress;
}

function bestBuildingColor(bot) {
  // Which color is the bot closest to completing (but not yet complete)?
  let best = null, bestPct = 0;
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have >= info.size) continue; // already complete
    if (have === 0) continue;
    const pct = have / info.size;
    if (pct > bestPct) { bestPct = pct; best = color; }
  }
  return best;
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
    // Chud mode: random chance to end turn early (reduced from 40% to 20%)
    if (mode === 'chud' && state.playsRemaining > 0 && state.playsRemaining < 3 && Math.random() < 0.2) {
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

  const shouldOpsec = hasOpsec && shouldPlayOpsecDecision(state, pa, mode, botId);

  if (shouldOpsec) {
    const result = G.respondToAction(state, botId, 'opsec');
    if (result.error) {
      acceptAction(state, bot, botId, pa, mode);
    }
    callbacks.broadcast(room);
    if (state.phase === 'finished') return;
    scheduleBotAction(room, callbacks);
    return;
  }

  acceptAction(state, bot, botId, pa, mode);
  callbacks.broadcast(room);
  if (state.phase === 'finished') return;
  scheduleBotAction(room, callbacks);
}

function acceptAction(state, bot, botId, pa, mode) {
  const needsPayment = pa.type === 'payment' || pa.type === 'payment_all' ||
    pa.type === 'chud' || pa.action === 'chud_payment' ||
    pa.action === 'finance_office' || pa.action === 'roll_call' || pa.action === 'rent';

  if (needsPayment && pa.amount > 0) {
    const payCards = selectPaymentCards(bot, pa.amount, mode);
    const result = G.respondToAction(state, botId, 'accept', payCards.length > 0 ? payCards : undefined);
    if (result?.needPayment) {
      const allCards = getAllPayableCardIds(bot);
      G.respondToAction(state, botId, 'accept', allCards.length > 0 ? allCards : undefined);
    }
  } else {
    G.respondToAction(state, botId, 'accept');
  }
}

/* ── OPSEC decision — smarter per mode ────────────────────────────── */

function shouldPlayOpsecDecision(state, pa, mode, botId) {
  const bot = G.getPlayer(state, botId);
  const opsecCount = bot ? bot.hand.filter(c => c.action === 'opsec').length : 0;
  const isChainResponse = pa._opsecChain > 0 ||
    (pa.opsecChains && Object.values(pa.opsecChains).some(c => c.responderId === botId));

  switch (mode) {
    case 'random':
      // Even random mode should have some survival instinct
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return Math.random() > 0.3;
      if (pa.action === 'roll_call') return Math.random() > 0.8; // rarely block small stuff
      if (pa.action === 'rent' && pa.amount <= 2) return Math.random() > 0.8;
      return Math.random() > 0.5;

    case 'conservative':
      // Smart defense: save OPSEC for high-value threats
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return true;
      if (pa.action === 'midnight_requisition') {
        // Only block steals from sets we're building
        const building = bestBuildingColor(bot);
        if (pa.targetColor === building) return true;
        return opsecCount > 1; // if we have spare OPSEC, block anyway
      }
      if (pa.action === 'finance_office') return pa.amount >= 5 && opsecCount > 1;
      if (pa.action === 'rent' && pa.amount >= 4) return true;
      if (pa.action === 'rent' && pa.amount >= 2 && opsecCount > 1) return true;
      if (pa.action === 'roll_call') return opsecCount > 1; // save for bigger threats
      if (pa.action === 'chud_payment') return false;
      if (isChainResponse) return true;
      return false;

    case 'neutral':
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return true;
      if (pa.action === 'finance_office') return true;
      if (pa.action === 'rent' && pa.amount >= 4) return true;
      if (pa.action === 'midnight_requisition') return Math.random() > 0.3;
      if (pa.action === 'chud_payment') return false;
      if (isChainResponse) return true;
      return false;

    case 'aggressive':
      // Only protect complete/near-complete sets
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') {
        // Check if the targeted card is from a near-complete set
        const mySets = G.completedSets(bot);
        return mySets >= 2 || Math.random() > 0.3;
      }
      if (isChainResponse) return true;
      // Don't waste OPSEC on money demands — save for property theft
      return false;

    case 'chud':
      // Chaotic OPSEC: block small stuff, let big stuff through
      if (pa.action === 'roll_call') return Math.random() > 0.3;
      if (pa.action === 'rent' && pa.amount <= 3) return Math.random() > 0.4;
      if (pa.action === 'inspector_general') return Math.random() > 0.6; // 40% chance to block
      if (pa.action === 'chud') return Math.random() > 0.7; // 30% chance to block
      if (pa.action === 'finance_office') return Math.random() > 0.5;
      if (pa.action === 'midnight_requisition') return Math.random() > 0.5;
      return Math.random() > 0.6;

    default:
      return false;
  }
}

/* ── Core decision engine ───────────────────────────────────────────── */

function decideBotPlay(state, botId, mode) {
  const bot = G.getPlayer(state, botId);
  if (!bot || state.playsRemaining <= 0) return null;
  if (bot.hand.length === 0) return null;

  // Human-like holdback: sometimes don't use all 3 plays
  // Conservative: 20% chance to stop after 2 plays (save cards for defense)
  // Neutral: 10% chance to stop after 2 plays
  // Random: 25% chance to stop at any point
  // Aggressive: 5% chance (almost always uses all plays)
  // Chud: handled in botTakeTurn
  const played = 3 - state.playsRemaining;
  if (played >= 1) {
    // After 1 play: small chance to stop. After 2 plays: bigger chance.
    const holdChance = played === 1
      ? (mode === 'conservative' ? 0.08 : mode === 'random' ? 0.12 : mode === 'neutral' ? 0.05 : 0)
      : (mode === 'conservative' ? 0.25 : mode === 'neutral' ? 0.15
        : mode === 'random' ? 0.25 : mode === 'aggressive' ? 0.08 : 0);
    // Don't hold back if we have 8+ cards (need to discard anyway)
    if (holdChance > 0 && bot.hand.length <= 7 && Math.random() < holdChance) return null;
  }
  // Also: if only OPSEC cards remain in hand, conservative/neutral hold them
  if ((mode === 'conservative' || mode === 'neutral') && played >= 1) {
    const nonOpsec = bot.hand.filter(c => c.action !== 'opsec');
    if (nonOpsec.length === 0) return null; // only OPSEC in hand — hold it
  }

  switch (mode) {
    case 'random':       return decideRandom(state, bot, botId);
    case 'conservative': return decideConservative(state, bot, botId);
    case 'neutral':      return decideNeutral(state, bot, botId);
    case 'aggressive':   return decideAggressive(state, bot, botId);
    case 'chud':         return decideChud(state, bot, botId);
    default:             return decideNeutral(state, bot, botId);
  }
}

/* ── RANDOM MODE — unpredictable but slightly smarter ──────────────── */

function decideRandom(state, bot, botId) {
  // Lower early-end chance: 15% instead of 30%
  if (Math.random() < 0.15) return null;

  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // Shuffle indices
  const indices = hand.map((_, i) => i);
  shuffle(indices);

  // Slight bias: if we have properties, 60% chance to play them first
  if (Math.random() < 0.6) {
    for (const i of indices) {
      const c = hand[i];
      if (c.type === 'property') return { type: 'play_property', cardIndex: i };
      if (c.type === 'wild_property') {
        const validColors = c.colors[0] === 'any' ? Object.keys(G.COLORS) : c.colors;
        const color = validColors[Math.floor(Math.random() * validColors.length)];
        return { type: 'play_property', cardIndex: i, targetColor: color };
      }
    }
  }

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
      // Only if we have rent to follow up
      if (bot.hand.some(c => c.type === 'rent') && state.playsRemaining >= 2) {
        return { type: 'play_action', cardIndex: idx };
      }
      return Math.random() > 0.5 ? { type: 'play_action', cardIndex: idx } : null;
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
      return null;
    default:
      return { type: 'play_money', cardIndex: idx };
  }
}

/* ── CONSERVATIVE MODE — defensive but not passive ─────────────────── */

function decideConservative(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const mySets = G.completedSets(bot);
  const threats = findThreats(opponents);
  const threat = threatLevel(opponents);
  const played = 3 - state.playsRemaining;

  // If opponent is about to win, go offensive FIRST (before building)
  if (threat >= 2) {
    const offensive = tryDefensiveOffense(state, bot, botId, hand, opponents, threats);
    if (offensive) return offensive;
  }

  // 1. Surge + Rent combo — play surge first when we have rent queued
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  const rentOnComplete = findRentOnCompleteSet(bot, hand);
  if (surgeIdx >= 0 && rentOnComplete && !state._surgeOps && state.playsRemaining >= 2) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 2. Rent on complete sets — good income, low risk
  if (rentOnComplete) {
    return { type: 'play_action', cardIndex: rentOnComplete.cardIndex, targetColor: rentOnComplete.color };
  }

  // 3. PCS Orders — draw more cards (sometimes first, sometimes after property)
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0 && (played === 0 || Math.random() < 0.5)) {
    return { type: 'play_action', cardIndex: pcsIdx };
  }

  // 4. Properties — build toward completion
  const propPlay = findBestPropertyPlay(bot, hand);
  if (propPlay) return propPlay;

  // 5. PCS if we skipped it above
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 6. Upgrade/FOC on complete sets
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

  // 7. Rent — any color with rent >= 2
  const decentRent = findBestRent(bot, hand, 2);
  if (decentRent) return decentRent;

  // 8. If WE are close to winning (2 sets), get offensive
  if (mySets >= 2) {
    const offensive = tryOffensiveActions(state, bot, botId, hand, opponents);
    if (offensive) return offensive;
  }

  // 9. Roll Call if multiple opponents
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0 && opponents.length >= 2) {
    return { type: 'play_action', cardIndex: rcIdx };
  }

  // 10. Finance Office — target richest (conservative uses it now)
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = findRichestPlayer(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // 11. Bank money cards
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'money') return { type: 'play_money', cardIndex: i };
  }

  // 12. Bank rent cards we can't use
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'rent' && !chooseBestRentColor(bot, hand[i])) {
      return { type: 'play_money', cardIndex: i };
    }
  }

  return null; // hold remaining cards (don't bank useful actions)
}

/* ── NEUTRAL MODE — balanced with threat awareness ─────────────────── */

function decideNeutral(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const threat = threatLevel(opponents);
  const mySets = G.completedSets(bot);
  const played = 3 - state.playsRemaining;

  // If someone's about to win — go aggressive to stop them FIRST
  if (threat >= 2) {
    const threats = findThreats(opponents);
    const defensive = tryDefensiveOffense(state, bot, botId, hand, opponents, threats);
    if (defensive) return defensive;
  }

  // 1. Surge Ops → Rent combo (play surge first)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  const hasRent = hand.some(c => c.type === 'rent');
  if (surgeIdx >= 0 && hasRent && !state._surgeOps && state.playsRemaining >= 2) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 2. Rent if surged, or high-value rent (>= 3)
  if (state._surgeOps) {
    const rentPlay = findBestRent(bot, hand, 0);
    if (rentPlay) return rentPlay;
  }

  // 3. Vary opening play — don't always lead with property
  const roll = Math.random();
  if (played === 0) {
    if (roll < 0.35) {
      // 35% chance: lead with rent if decent
      const highRent = findBestRent(bot, hand, 2);
      if (highRent) return highRent;
    } else if (roll < 0.50) {
      // 15% chance: lead with PCS Orders
      const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
      if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };
    }
    // Otherwise fall through to property
  }

  // 4. Properties — smart placement
  const propPlay = findBestPropertyPlay(bot, hand);
  if (propPlay) return propPlay;

  // 5. PCS Orders (if not played above)
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 5. Medium rent (>= 2)
  const rentPlay = findBestRent(bot, hand, 2);
  if (rentPlay) return rentPlay;

  // 6. Offensive actions
  const offensive = tryOffensiveActions(state, bot, botId, hand, opponents);
  if (offensive) return offensive;

  // 7. Upgrade/FOC
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

  // 8. Any rent (>= 1)
  const lowRent = findBestRent(bot, hand, 1);
  if (lowRent) return lowRent;

  // 9. Bank money
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'money') return { type: 'play_money', cardIndex: i };
  }

  // 10. Bank unusable rent
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'rent' && !chooseBestRentColor(bot, hand[i])) {
      return { type: 'play_money', cardIndex: i };
    }
  }

  return null; // hold remaining (OPSEC, usable actions)
}

/* ── AGGRESSIVE MODE — attack-first but not suicidal ───────────────── */

function decideAggressive(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const mySets = G.completedSets(bot);
  const played = 3 - state.playsRemaining;

  // If we have 0 sets and 0 properties, build first (need sets to win)
  if (mySets === 0 && Object.values(bot.properties).every(c => c.length === 0) && played === 0) {
    const propPlay = findBestPropertyPlay(bot, hand);
    if (propPlay) return propPlay;
  }

  // 1. Surge Ops first (before rent)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  const hasRent = hand.some(c => c.type === 'rent');
  if (surgeIdx >= 0 && hasRent && !state._surgeOps && state.playsRemaining >= 2) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 2. Rent — any color with properties, maximize damage
  const rentPlay = findBestRent(bot, hand, 0);
  if (rentPlay) return rentPlay;

  // 3. CHUD — target strategically
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'chud') {
      const target = findAggressiveChudTarget(state, bot, botId, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 4. Inspector General
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'inspector_general') {
      const target = findBestIGTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color };
    }
  }

  // 5. Finance Office — target richest bank
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = findRichestPlayer(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // 6. Roll Call
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0) return { type: 'play_action', cardIndex: rcIdx };

  // 7. Midnight Requisition — steal what we need
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

  // 9. Properties — still need to build sets to win
  const propPlay = findBestPropertyPlay(bot, hand);
  if (propPlay) return propPlay;

  // 10. PCS Orders (draw more ammo)
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

  // 12. Bank — only when nothing better to do
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.action === 'opsec') continue;
    if (c.type === 'money') return { type: 'play_money', cardIndex: i };
    if (c.type === 'rent') return { type: 'play_money', cardIndex: i };
    if (c.type === 'action') return { type: 'play_money', cardIndex: i };
  }

  return null;
}

/* ── CHUD MODE — chaotic gremlin, but actually plays the game ──────── */

function decideChud(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // Chud still plays chaotically, but now actually builds sets
  // Priority: harass opponents > build own empire > bank

  // 1. CHUD card — play it immediately for maximum chaos
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'chud') {
      const target = findChudChudTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 2. Inspector General — seize sets chaotically (target random complete set)
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'inspector_general') {
      const target = findRandomIGTarget(opponents);
      if (!target) { const best = findBestIGTarget(opponents); if (best) return { type: 'play_action', cardIndex: i, targetId: best.id, targetColor: best.color }; }
      else return { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color };
    }
  }

  // 3. Midnight Requisition — steal from whoever
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      const target = findRandomStealTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 4. Finance Office — target random player (not always poorest)
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = opponents.length > 0 ? opponents[Math.floor(Math.random() * opponents.length)] : null;
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // 5. Roll Call
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0) return { type: 'play_action', cardIndex: rcIdx };

  // 6. TDY Orders — swap randomly
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'tdy_orders') {
      const target = findRandomSwapTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.targetPlayerId, targetCardId: target.targetCardId, myCardId: target.myCardId };
    }
  }

  // 7. Surge Ops — burn it even without rent
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 8. Rent — actually charge it now (chaotically pick a color)
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'rent') {
      const color = randomRentColor(bot, c);
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }

  // 9. Properties — play them but on random/suboptimal colors
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'property') return { type: 'play_property', cardIndex: i };
    if (c.type === 'wild_property') {
      const validColors = c.colors[0] === 'any' ? Object.keys(G.COLORS) : c.colors;
      // 50% chance to pick worst color, 50% chance random
      const color = Math.random() > 0.5
        ? chooseBestColorForWild(bot, c)
        : validColors[Math.floor(Math.random() * validColors.length)];
      return { type: 'play_property', cardIndex: i, targetColor: color };
    }
  }

  // 10. PCS Orders
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 11. Bank money
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'money') return { type: 'play_money', cardIndex: i };
  }

  // 12. Bank remaining actions (even OPSEC — chud doesn't care about defense)
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'action') return { type: 'play_money', cardIndex: i };
  }

  return null;
}

/* ── Smart property placement ──────────────────────────────────────── */

function findBestPropertyPlay(bot, hand) {
  // Play properties that advance our best sets first
  const progress = myProgress(bot);
  let bestPlay = null, bestScore = -1;

  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'property') {
      const pct = progress[c.color]?.pct || 0;
      // Prefer colors we're already building + smaller sets (easier to complete)
      const sizeBonus = (5 - G.COLORS[c.color].size) * 0.1;
      const score = pct + sizeBonus + (progress[c.color]?.have > 0 ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; bestPlay = { type: 'play_property', cardIndex: i }; }
    }
    if (c.type === 'wild_property') {
      const color = chooseBestColorForWild(bot, c);
      const pct = progress[color]?.pct || 0;
      const score = pct + 0.3; // bonus for flexibility
      if (score > bestScore) { bestScore = score; bestPlay = { type: 'play_property', cardIndex: i, targetColor: color }; }
    }
  }
  return bestPlay;
}

/* ── Defensive offense (target threats specifically) ───────────────── */

function tryDefensiveOffense(state, bot, botId, hand, opponents, threats) {
  if (threats.length === 0) return tryOffensiveActions(state, bot, botId, hand, opponents);

  // Inspector General — seize a set from the biggest threat
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'inspector_general') {
      for (const threat of threats) {
        for (const [color] of Object.entries(threat.properties)) {
          if (G.isSetComplete(threat, color)) {
            return { type: 'play_action', cardIndex: i, targetId: threat.id, targetColor: color };
          }
        }
      }
    }
  }

  // CHUD — steal from threat's best set
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'chud') {
      for (const threat of threats) {
        let bestCard = null;
        for (const cards of Object.values(threat.properties)) {
          for (const c of cards) {
            if (!bestCard || c.value > bestCard.value) bestCard = { playerId: threat.id, cardId: c.id, value: c.value };
          }
        }
        if (bestCard) return { type: 'play_action', cardIndex: i, targetId: bestCard.playerId, targetCardId: bestCard.cardId };
      }
    }
  }

  // Midnight Requisition — steal from threat's incomplete sets
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      for (const threat of threats) {
        for (const [col, cards] of Object.entries(threat.properties)) {
          if (G.isSetComplete(threat, col)) continue;
          if (cards.length > 0) return { type: 'play_action', cardIndex: i, targetId: threat.id, targetCardId: cards[0].id };
        }
      }
    }
  }

  // Finance Office — drain threat's bank
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      for (const threat of threats) {
        return { type: 'play_action', cardIndex: i, targetId: threat.id };
      }
    }
  }

  // Fall back to general offense
  return tryOffensiveActions(state, bot, botId, hand, opponents);
}

/* ── Shared offensive action helpers ────────────────────────────────── */

function tryOffensiveActions(state, bot, botId, hand, opponents) {
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
  return opponents.reduce((worst, p) =>
    G.playerTotalValue(p) < G.playerTotalValue(worst) ? p : worst);
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
    // Score: progress toward completion + bonus for smaller sets
    const score = (have / info.size) + (have > 0 ? 0.3 : 0) + ((5 - info.size) * 0.05);
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
    const validColors = c.colors[0] === 'any' ? Object.keys(bot.properties) : c.colors;
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
  // Target what helps us most, then target leader's best
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have > 0 && have < info.size) {
      for (const opp of opponents) {
        const oppCards = opp.properties[color] || [];
        for (const c of oppCards) return { playerId: opp.id, cardId: c.id };
      }
    }
  }
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
  // Chaotic: pick random player, random property
  const all = [];
  for (const opp of opponents) {
    for (const cards of Object.values(opp.properties)) {
      for (const c of cards) all.push({ playerId: opp.id, cardId: c.id });
    }
  }
  return all.length > 0 ? all[Math.floor(Math.random() * all.length)] : null;
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
  let myWorst = null;
  for (const [col, cards] of Object.entries(bot.properties)) {
    if (cards.length !== 1) continue;
    for (const c of cards) {
      if (!myWorst || c.value < myWorst.value) myWorst = { cardId: c.id, value: c.value, color: col };
    }
  }
  if (!myWorst) return null;

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
      // Pay chaotically — random order
      shuffle(cards);
      break;

    case 'conservative':
      // Bank first (smallest), protect near-complete sets
      cards.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'bank' ? -1 : 1;
        if (a.source === 'prop') return (a.setProgress || 0) - (b.setProgress || 0);
        return a.value - b.value;
      });
      break;

    case 'aggressive':
      // Bank first, then isolated properties, protect near-complete sets
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
      // Discard randomly — true chaos
      shuffle(hand);
      break;

    case 'conservative':
      // Keep OPSEC, properties, rent. Discard offensive actions and low-value stuff.
      hand.sort((a, b) => {
        if (a.action === 'opsec') return 1;
        if (b.action === 'opsec') return -1;
        if ((a.type === 'property' || a.type === 'wild_property') &&
            b.type !== 'property' && b.type !== 'wild_property') return 1;
        if ((b.type === 'property' || b.type === 'wild_property') &&
            a.type !== 'property' && a.type !== 'wild_property') return -1;
        const offA = ['inspector_general','chud','midnight_requisition','tdy_orders'].includes(a.action);
        const offB = ['inspector_general','chud','midnight_requisition','tdy_orders'].includes(b.action);
        if (offA && !offB) return -1;
        if (offB && !offA) return 1;
        return a.value - b.value;
      });
      break;

    case 'aggressive':
      // Keep action cards and properties, discard money and low-value stuff
      hand.sort((a, b) => {
        if (a.type === 'money' && b.type !== 'money') return -1;
        if (b.type === 'money' && a.type !== 'money') return 1;
        if (a.type === 'action' && b.type !== 'action') return 1;
        if (b.type === 'action' && a.type !== 'action') return -1;
        return a.value - b.value;
      });
      break;

    case 'random':
      shuffle(hand);
      break;

    default: // neutral
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

module.exports = {
  scheduleBotAction, cancelBotTimeout,
  // Exported for simulation harness
  _internal: {
    decideBotPlay, shouldPlayOpsecDecision, selectPaymentCards,
    getAllPayableCardIds, chooseDiscards, findResponder: function(state) {
      const pa = state.pendingAction;
      if (!pa) return null;
      if (pa.type === 'payment_all') {
        if (pa.pending && pa.pending.length > 0) return pa.pending[0];
        for (const [pid, chain] of Object.entries(pa.opsecChains || {})) return chain.responderId;
      } else {
        return pa.responderId || null;
      }
      return null;
    },
    botRespondSync: function(state, botId, mode) {
      const pa = state.pendingAction;
      if (!pa) return;
      const bot = G.getPlayer(state, botId);
      if (!bot) return;
      const hasOpsec = bot.hand.some(c => c.action === 'opsec');
      if (hasOpsec && shouldPlayOpsecDecision(state, pa, mode, botId)) {
        const result = G.respondToAction(state, botId, 'opsec');
        if (!result.error) return;
      }
      const needsPayment = pa.type === 'payment' || pa.type === 'payment_all' ||
        pa.type === 'chud' || pa.action === 'chud_payment' ||
        pa.action === 'finance_office' || pa.action === 'roll_call' || pa.action === 'rent';
      if (needsPayment && pa.amount > 0) {
        const payCards = selectPaymentCards(bot, pa.amount, mode);
        const result = G.respondToAction(state, botId, 'accept', payCards.length > 0 ? payCards : undefined);
        if (result?.needPayment) {
          const allCards = getAllPayableCardIds(bot);
          G.respondToAction(state, botId, 'accept', allCards.length > 0 ? allCards : undefined);
        }
      } else {
        G.respondToAction(state, botId, 'accept');
      }
    },
  },
};
