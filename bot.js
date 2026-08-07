// bot.js — Bot AI engine for Chudopoly with 5 personality modes
const G = require('./game');

/* ── Randomness ─────────────────────────────────────────────────────── */
// Injectable so simulate.js can run reproducible matrices; defaults to Math.random.
let RND = Math.random;
function rnd() { return RND(); }
function setRng(fn) { RND = typeof fn === 'function' ? fn : Math.random; }

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
  return range[0] + rnd() * (range[1] - range[0]);
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
  if (!state.pendingAction) return null;
  for (const pid of G.pendingResponders(state)) {
    if (room.players.find(p => p.id === pid)?.isBot) return pid;
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

/* ── §3.10 Final approach: breaking it and defending it ─────────────── */

function findArmed(players, exceptId) {
  return players.filter(p => p.finalApproach && !p.eliminated && p.id !== exceptId);
}

// Cards sitting in a zone that is exactly a complete set — the only cards whose loss
// actually costs the owner a set.
function completeSetCards(player) {
  const out = [];
  for (const [color, cards] of Object.entries(player.properties)) {
    // Must be isSetComplete, not "zone is full": under the pureSetRequired toggle a zone
    // full of nothing but wilds is NOT a set, and Inspector General refuses it. Measured:
    // 7 refused IG plays across 1,440 mdFaithful games before this.
    if (!G.isSetComplete(player, color)) continue;
    for (const card of cards) out.push({ color, card });
  }
  return out;
}

function bankValue(player) {
  return player.bank.reduce((sum, c) => sum + c.value, 0);
}

// What an armed player can hand over WITHOUT losing a set: the bank, properties sitting in
// zones that are not complete sets, and upgrades. Upgrades are payable (§3.1b) and a House
// leaving a set costs its owner rent, not the set — so they are spent before a set property
// (that is exactly the order selectPaymentCards() uses below).
//
// This, not the bank alone, is the number a charge has to beat. A demand the victim can
// settle out of loose change moves money and disarms nobody, and during a grace cycle there
// is no later turn in which that money would have mattered. Measured on the pre-fix bot:
// 51.9% of every charge aimed at an armed player was payable without touching a set.
function disposableValue(player) {
  let total = bankValue(player);
  for (const [color, cards] of Object.entries(player.properties)) {
    if (G.isSetComplete(player, color)) continue;
    for (const c of cards) total += c.value;
  }
  for (const ups of Object.values(player.upgrades || {})) {
    for (const u of ups) if (u && typeof u === 'object') total += u.value || 0;
  }
  return total;
}

// The four cards in a 106-card deck that can actually pull a card out of a complete set.
// Banking one of these while somebody is armed is never a trade worth making.
function isHardBreaker(card) {
  return card && (card.action === 'inspector_general' || card.action === 'chud');
}

// How hard each personality tries to shoot down a final approach — the gate on firing a
// counter that we know will land if it is not OPSEC'd.
const BREAK_URGENCY = { aggressive: 1, chud: 1, neutral: 0.9, conservative: 0.85, random: 0.2 };

// How far each personality will OVERPAY for the attempt: burning a play on a speculative
// draw to dig for a counter, or on attrition that cannot disarm by itself. This is the axis
// the personalities are allowed to differ on — none of them may ignore an armed player, but
// an aggressive bot will spend its whole turn hunting and a conservative one will not.
const BREAK_OVERPAY = { aggressive: 0.95, chud: 0.85, neutral: 0.75, conservative: 0.55, random: 0.15 };

// The absolute turn number at which a player converts. checkpointForecast() is the engine's
// own forecast, so this cannot drift from resolveFinalApproach() the way a reimplementation
// would. Use `.turn`, NOT `.opponents`: two players armed on the same tick have the same
// number of opponent turns left but still convert in seat order, and `.opponents` reports
// them as tied while `.turn` orders them correctly.
function checkpointTurn(state, player) {
  const f = G.checkpointForecast(state, player);
  return f ? f.turn : null;
}

// Which armed opponent do we shoot at? Not the one with the most sets — the one whose
// checkpoint arrives FIRST, because that is the one who actually wins. Sets break the tie
// only in the degenerate case where the engine cannot forecast either.
function pickArmedVictim(state, armed) {
  return armed.reduce((best, p) => {
    const a = checkpointTurn(state, p);
    const b = checkpointTurn(state, best);
    if (a == null) return best;
    if (b == null) return p;
    if (a !== b) return a < b ? p : best;
    return G.completedSets(p) > G.completedSets(best) ? p : best;
  });
}

function tryBreakFinalApproach(state, bot, botId, hand, armed, mode) {
  // If we are armed too, the only question is who converts first. When our own checkpoint
  // arrives before theirs we have already won the race and spending our counter on them is
  // pure loss — hold it and defend. When theirs arrives first, they win before we do and the
  // counter has to be spent now, armed or not.
  if (bot.finalApproach) {
    const mine = checkpointTurn(state, bot);
    if (mine != null) {
      armed = armed.filter(p => {
        const theirs = checkpointTurn(state, p);
        return theirs == null || theirs < mine;
      });
    }
  }
  if (armed.length === 0) return null;

  const victim = pickArmedVictim(state, armed);
  const theirSets = completeSetCards(victim);
  if (theirSets.length === 0) return null;
  const overpay = BREAK_OVERPAY[mode] ?? 0.75;

  // 1. Inspector General — takes the WHOLE set, permanently, and it lands on our board, so
  //    it swings two sets at once. Strictly the best counter whenever it is in hand.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'inspector_general') continue;
    const color = theirSets[0].color;
    return { type:'play_action', cardIndex:i, targetId:victim.id, targetColor:color };
  }

  // 2. THE CHUD CARD — the only card in the deck that reaches into a complete set for a
  //    single property. Permanent, and one card is all it takes to disarm.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'chud') continue;
    const best = theirSets.reduce((a, b) => (b.card.value > a.card.value ? b : a));
    return { type:'play_action', cardIndex:i, targetId:victim.id, targetCardId:best.card.id };
  }

  // 3. TDY Orders is NOT a break tool. §3.1 was reversed on 2026-08-06: Hasbro FAQ 926 bars
  //    Forced Deal from complete sets on BOTH sides of the swap, and game.js enforces it
  //    (playAction case 'tdy_orders'). Proposing one here would burn a play on a move the
  //    engine refuses. Midnight Requisition is barred the same way and appears far below,
  //    as attrition only — `zoneRequisitionable` confines it to zones that are NOT complete
  //    sets, so it can never reduce anybody's completedSets() count.

  // 4. Charge them past what they can pay from loose change, and a set card has to come out.
  //    §3.1c: Surge Ops doubles RENT ONLY — never Finance Office, never Roll Call — so it is
  //    only ever worth a play ahead of a rent, and only when doubling is what pushes the
  //    charge over the line. (The old code surged before Finance Office and threw the play
  //    away, at the one moment in the game when plays are worth the most.)
  const spare = disposableValue(victim);
  const surges = state._surgeOps || 0;
  const rentMult = 2 ** surges;
  const financeIdx = hand.findIndex(c => c.action === 'finance_office');
  const rollCallIdx = hand.findIndex(c => c.action === 'roll_call');
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');

  let bestRent = null;
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (card.type !== 'rent') continue;
    const color = chooseBestRentColor(bot, card);
    if (!color) continue;
    const base = G.calcRent(bot, color);
    if (bestRent === null || base > bestRent.base) bestRent = { i, color, base, card };
  }

  // The charges still firable this turn, biggest first. Round 5 asked of each one alone
  // "does this beat `disposableValue`", which threw away every hand that could only get
  // there by stacking two — a 4M rent and a 5M Finance Office cannot disarm a victim
  // holding 6M of loose change one at a time, and comfortably can together. The bar is the
  // SEQUENCE, and after the first charge lands `disposableValue` has already fallen, so this
  // branch re-runs next play and the second charge is usually clearing the bar on its own by
  // then.
  //
  // This is NOT the attrition fallback measured and removed in round 5. That one fired
  // charges the victim could pay in full, which cannot disarm anybody by definition; this
  // fires only when the charges that FIT IN THIS TURN add up to more than the victim can
  // cover without breaking a set.
  const charges = [];
  if (bestRent) charges.push({ amount: bestRent.base * rentMult, kind: 'rent' });
  if (financeIdx >= 0) charges.push({ amount: 5, kind: 'finance' });
  if (rollCallIdx >= 0) charges.push({ amount: 2, kind: 'roll' });
  charges.sort((a, b) => b.amount - a.amount);
  const firable = charges.slice(0, Math.max(0, state.playsRemaining));
  const stacked = firable.reduce((sum, c) => sum + c.amount, 0);

  // Surge first only when doubling the rent is what carries the sequence over the bar, and
  // only if a play remains to fire the rent with. §3.1c — rent only; surging ahead of a
  // Finance Office spends a play on a multiplier the engine never applies.
  if (bestRent && surgeIdx >= 0 && state.playsRemaining >= 2
    && stacked <= spare && stacked + bestRent.base * rentMult > spare) {
    return { type:'play_action', cardIndex:surgeIdx };
  }
  if (stacked > spare && firable.length > 0) {
    const first = firable[0];
    if (first.kind === 'rent') {
      if (bestRent.card.colors[0] === 'any') {
        return { type:'play_action', cardIndex:bestRent.i, targetColor:bestRent.color, targetId:victim.id };
      }
      return { type:'play_action', cardIndex:bestRent.i, targetColor:bestRent.color };
    }
    if (first.kind === 'finance') return { type:'play_action', cardIndex:financeIdx, targetId:victim.id };
    // Roll Call is only 2M and it hits the whole table, but 2M is all it takes against a
    // player who has already spent down to nothing.
    return { type:'play_action', cardIndex:rollCallIdx };
  }

  // 5. Nothing in hand can disarm them. There is no next turn to draw into — so a
  //    speculative dig beats every ordinary play we could make instead. PCS Orders is the
  //    only card that turns an empty hand into a chance, and both drawn cards are live
  //    immediately because this branch runs again on the next play.
  if (rnd() < overpay) {
    for (let i = 0; i < hand.length; i++) {
      if (hand[i].action !== 'pcs_orders') continue;
      if (state.playsRemaining < 2) break;   // no play left to fire what we draw
      return { type:'play_action', cardIndex:i };
    }
  }

  // 6. Denial, and only denial. Midnight Requisition cannot touch a complete set (§3.1), so
  //    it never disarms by itself — but it takes a card off the victim permanently, and the
  //    zone it comes out of is the one they would rebuild from if we do break a set later in
  //    the cycle. Only the personalities willing to overpay spend a play on it.
  //
  //    Deliberately NOT here: a blanket "charge them anyway" fallback. A demand they can
  //    afford cannot disarm anybody, the personality planner below already makes exactly
  //    that play when it is the right one, and forcing it through this branch would override
  //    the holdback that stops bots attacking on every single play. Measured over 1,500
  //    games per table size: including it moved conversion by 0.4–1.5 points (inside run
  //    noise) while pushing 5-player games decided on points from 8.3% to 8.9%. It bought
  //    nothing and cost variety.
  if (rnd() >= overpay) return null;
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'midnight_requisition') continue;
    for (const [color, cards] of Object.entries(victim.properties)) {
      if (!G.zoneRequisitionable(victim, color) || cards.length === 0) continue;
      return { type:'play_action', cardIndex:i, targetId:victim.id, targetCardId:cards[0].id };
    }
  }
  return null;
}

// Even the gremlin should not waste the only card that reaches into a complete set on a
// player with nothing to lose. Armed first, then whoever is closest to arming.
function biggestThreat(opponents) {
  const armed = opponents.filter(o => o.finalApproach);
  if (armed.length > 0) return armed[0];
  const ranked = opponents.filter(o => G.completedSets(o) >= 2);
  if (ranked.length === 0) return null;
  return ranked.reduce((a, b) => (G.completedSets(b) > G.completedSets(a) ? b : a));
}

function chudTargetOn(player) {
  const sets = completeSetCards(player);
  if (sets.length > 0) return { playerId: player.id, cardId: sets[0].card.id };
  for (const cards of Object.values(player.properties)) {
    if (cards.length > 0) return { playerId: player.id, cardId: cards[0].id };
  }
  return null;
}

// Armed bots stop building (they cannot win by having more sets) and start hoarding cash
// so an incoming charge does not have to be paid out of a completed set.
const ARMED_BANK_BIAS = { conservative: 0.9, neutral: 0.85, aggressive: 0.7, chud: 0.4, random: 0.2 };

function tryDefendFinalApproach(bot, hand, mode, othersArmed) {
  if (rnd() > (ARMED_BANK_BIAS[mode] ?? 0.8)) return null;
  let best = -1, bestIdx = -1;
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (card.type === 'property' || card.type === 'wild_property') continue;
    if (card.action === 'opsec') continue;              // the shield is worth more than the cash
    // Inspector General is the highest-value card in the deck (5M), so "bank the biggest
    // thing" used to reach for it first and quietly bury the best counter in the game under
    // a pile of cash. While anyone else is armed it is a weapon, not currency.
    if (othersArmed && isHardBreaker(card)) continue;
    if (card.value > best) { best = card.value; bestIdx = i; }
  }
  return bestIdx >= 0 ? { type:'play_money', cardIndex:bestIdx } : null;
}

/* ── §3.8 free rearranging ──────────────────────────────────────────────
 *
 * Moving a wild between your own sets is FREE and does not cost a play (Hasbro FAQ 937,
 * ARCHITECTURE §3.8; the client itself got this wrong until `55a014f`). Every bot in this
 * file has ignored it since the file was written — `moveProperty` and `swapProperties` were
 * never once called from a bot decision.
 *
 * That is not a rounding error. Instrumented over 400 four-player games, sampling every
 * player's board at every turn start: on **16-21% of turn starts** a single free move would
 * have completed a set outright, and not one bot ever made it. It is the largest thing in
 * this file that was simply missing rather than wrong.
 *
 * The planner is a hill climb on a board score, and everything about it is chosen so it
 * cannot thrash or wedge:
 *
 *   - A CARD NEVER LEAVES A COMPLETE SET. Moving out of one can cost a set and can gain at
 *     most one, so the count of completed sets is monotone non-decreasing under every move
 *     the planner will make — which is both the strategy and the termination argument.
 *   - Only STRICT improvements are taken, on a deterministic score, so A→B→A is impossible.
 *   - Every precondition `moveProperty()` and `swapProperties()` check is checked here
 *     first, so the engine can never refuse a proposal. A refusal would be an infinite loop:
 *     a rejected rearrange costs no play and no budget, so `botTakeTurn` would re-decide,
 *     re-propose and reschedule forever.
 *   - At most four rearranges per turn, read off the engine's own budget rather than a
 *     counter of ours. The opportunity is one move deep in almost every case, and a bot that
 *     spends eight seconds sliding cards around is worse to sit across from than one that
 *     leaves a set unfinished.
 */

// Completed sets are the win condition, so they dominate. Below that the score is the
// SQUARE of each zone's progress, which is what makes concentration beat scatter: 2/4 in
// one colour outscores 1/3 + 1/4 across two, and a wild parked where it can never finish
// anything is worth moving to wherever it can.
function zoneScore(bot, color) {
  const info = G.COLORS[color];
  if (!info) return 0;
  const have = (bot.properties[color] || []).length;
  if (have === 0) return 0;
  if (G.isSetComplete(bot, color)) return 1000 + 10 * info.size;
  const frac = have / info.size;
  return 200 * frac * frac;
}

function boardScore(bot) {
  let total = 0;
  for (const color of Object.keys(G.COLORS)) total += zoneScore(bot, color);
  return total;
}

// Apply a move on the real arrays, score, and put everything back exactly as it was.
// Cheaper than cloning the board, and `isSetComplete` has to see the real zones because
// `pureSetRequired` makes "is this a set" depend on what else is sitting in the zone.
function scoreAfterMove(bot, card, from, to) {
  const src = bot.properties[from];
  const at = src.indexOf(card);
  if (at < 0) return -Infinity;
  const created = !bot.properties[to];
  if (created) bot.properties[to] = [];
  const dst = bot.properties[to];
  const wasPlaced = card.placedColor;
  src.splice(at, 1);
  card.placedColor = to;
  dst.push(card);
  const score = boardScore(bot);
  dst.pop();
  card.placedColor = wasPlaced;
  src.splice(at, 0, card);
  if (created) delete bot.properties[to];
  return score;
}

function scoreAfterSwap(bot, a, b) {
  const from = a.color, to = b.color;
  const ia = bot.properties[from].indexOf(a.card);
  const ib = bot.properties[to].indexOf(b.card);
  if (ia < 0 || ib < 0) return -Infinity;
  bot.properties[from].splice(ia, 1, b.card);
  bot.properties[to].splice(ib, 1, a.card);
  const pa = a.card.placedColor, pb = b.card.placedColor;
  a.card.placedColor = to; b.card.placedColor = from;
  const score = boardScore(bot);
  bot.properties[from].splice(ia, 1, a.card);
  bot.properties[to].splice(ib, 1, b.card);
  a.card.placedColor = pa; b.card.placedColor = pb;
  return score;
}

// How readily each personality tidies its board, per decision. This is the axis the trait
// lives on: the three planning modes always take a free set, the gremlin usually notices,
// and random mostly does not. Nobody is FORBIDDEN the move — it is free, and a bot that
// left a finished set on the floor forever would just read as broken.
const REARRANGE_BIAS = { conservative: 1, neutral: 1, aggressive: 1, chud: 0.3, random: 0.12 };
// Whether a personality will spend a move on mere consolidation — a wild that improves the
// board without finishing anything today. The chaotic two will not: they take the free set
// and nothing else, which keeps their boards scattered, which is their whole shape.
const REARRANGE_CONSOLIDATES = { conservative: true, neutral: true, aggressive: true, chud: false, random: false };
// A completed set is worth ~1000 on the board score; anything under this is housekeeping.
const SET_DELTA = 500;

function rearrangesLeft(state) {
  const left = state?.rearrangesRemaining;
  return Number.isFinite(left) ? left : G.REARRANGE_BUDGET;
}

function planRearrange(state, bot, mode) {
  if (state.turnPhase !== 'play') return null;
  const left = rearrangesLeft(state);
  if (left <= 0) return null;
  if (G.REARRANGE_BUDGET - left >= 4) return null;   // the per-turn cap described above
  if (rnd() > (REARRANGE_BIAS[mode] ?? 1)) return null;
  const consolidates = REARRANGE_CONSOLIDATES[mode] ?? true;

  const base = boardScore(bot);
  const movable = [];
  for (const [color, cards] of Object.entries(bot.properties)) {
    if (!cards.length) continue;
    // Never out of a complete set: it can cost a set and can gain at most one.
    if (G.isSetComplete(bot, color)) continue;
    for (const card of cards) {
      if (card.type !== 'wild_property') continue;
      movable.push({ color, card });
    }
  }
  if (movable.length === 0) return null;

  let best = null;
  for (const { color: from, card } of movable) {
    for (const to of G.legalColorsFor(card)) {
      if (to === from || !G.COLORS[to] || G.zoneFull(bot, to)) continue;
      const delta = scoreAfterMove(bot, card, from, to) - base;
      if (delta <= 1e-9) continue;
      if (!best || delta > best.delta) best = { delta, plan: { type: 'rearrange', cardId: card.id, toColor: to } };
    }
  }

  // The atomic swap (§3.5 owner ruling, `d05d523`). Only reachable when NO single move
  // helps, because it costs two rearranges and a one-card move that achieves the same thing
  // is always cheaper — which is exactly the case the swap was ruled in for: two zones that
  // are each full of what the other one wants, where neither card can go first.
  if (!best && left >= G.SWAP_COST) {
    for (let i = 0; i < movable.length; i++) {
      for (let j = i + 1; j < movable.length; j++) {
        const a = movable[i], b = movable[j];
        if (a.color === b.color) continue;
        if (!G.legalColorsFor(a.card).includes(b.color)) continue;
        if (!G.legalColorsFor(b.card).includes(a.color)) continue;
        const delta = scoreAfterSwap(bot, a, b) - base;
        if (delta <= 1e-9) continue;
        if (!best || delta > best.delta) {
          best = { delta, plan: { type: 'swap', cardIdA: a.card.id, cardIdB: b.card.id } };
        }
      }
    }
  }

  if (!best) return null;
  if (!consolidates && best.delta < SET_DELTA) return null;
  return best.plan;
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
    if (mode === 'chud' && state.playsRemaining > 0 && state.playsRemaining < 3 && rnd() < 0.2) {
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

function amountOwed(state, pa, botId) {
  const entry = G.pendingEntryFor(state, botId);
  if (!entry || pa.type !== 'payment') return 0;
  if (botId === pa.sourceId || entry.depth % 2 === 1) return 0;  // conceding a block, not paying
  return pa.amount || 0;
}

function acceptAction(state, bot, botId, pa, mode) {
  const owed = amountOwed(state, pa, botId);

  if (owed > 0) {
    const payCards = selectPaymentCards(bot, owed, mode);
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
  const entry = G.pendingEntryFor(state, botId);
  const isChainResponse = !!entry && entry.depth > 0;

  // §3.10 — an armed bot is one turn from winning: anything that could cost it a set is
  // worth an OPSEC. Random keeps a coin-flip's worth of incompetence.
  if (bot?.finalApproach && pa.sourceId !== botId) {
    const forcedOutOfSets = pa.type === 'payment' && bankValue(bot) < (pa.amount || 0);
    if (pa.type !== 'payment' || forcedOutOfSets) {
      return mode === 'random' ? rnd() < 0.6 : true;
    }
  }

  switch (mode) {
    case 'random':
      // Even random mode should have some survival instinct
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return rnd() > 0.3;
      if (pa.action === 'roll_call') return rnd() > 0.8; // rarely block small stuff
      if (pa.action === 'rent' && pa.amount <= 2) return rnd() > 0.8;
      return rnd() > 0.5;

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
      if (isChainResponse) return true;
      return false;

    case 'neutral':
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return true;
      if (pa.action === 'finance_office') return true;
      if (pa.action === 'rent' && pa.amount >= 4) return true;
      if (pa.action === 'midnight_requisition') return rnd() > 0.3;
      if (isChainResponse) return true;
      return false;

    case 'aggressive':
      // Only protect complete/near-complete sets
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') {
        // Check if the targeted card is from a near-complete set
        const mySets = G.completedSets(bot);
        return mySets >= 2 || rnd() > 0.3;
      }
      if (isChainResponse) return true;
      // Don't waste OPSEC on money demands — save for property theft
      return false;

    case 'chud':
      // Chaotic OPSEC: block small stuff, let big stuff through
      if (pa.action === 'roll_call') return rnd() > 0.3;
      if (pa.action === 'rent' && pa.amount <= 3) return rnd() > 0.4;
      if (pa.action === 'inspector_general') return rnd() > 0.6; // 40% chance to block
      if (pa.action === 'chud') return rnd() > 0.7; // 30% chance to block
      if (pa.action === 'finance_office') return rnd() > 0.5;
      if (pa.action === 'midnight_requisition') return rnd() > 0.5;
      return rnd() > 0.6;

    default:
      return false;
  }
}

/* ── Core decision engine ───────────────────────────────────────────── */

function decideBotPlay(state, botId, mode) {
  const bot = G.getPlayer(state, botId);
  if (!bot || state.playsRemaining <= 0) return null;

  // §3.8 — rearranging costs no play, so it is decided before everything that does: before
  // the personality plan, before the human-like holdback (a bot sitting on its hand should
  // still tidy its board) and before the empty-hand return below (a bot that has spent its
  // whole hand can still finish a set for free). Nothing is deferred by taking it — the
  // caller re-enters within the same turn with the same plays still in the bank.
  const tidy = planRearrange(state, bot, mode);
  if (tidy) return tidy;

  if (bot.hand.length === 0) return null;

  // §3.10 — a live final approach outranks every personality quirk, including the
  // human-like holdback below: there may be no next turn to use the card on.
  const armed = findArmed(state.players, botId);
  if (armed.length > 0 && rnd() < (BREAK_URGENCY[mode] ?? 0.8)) {
    const shot = tryBreakFinalApproach(state, bot, botId, bot.hand, armed, mode);
    if (shot) return shot;
  }
  if (bot.finalApproach) {
    const shield = tryDefendFinalApproach(bot, bot.hand, mode, armed.length > 0);
    if (shield) return shield;
  }

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
      ? (mode === 'conservative' ? 0.08 : mode === 'random' ? 0.08 : mode === 'neutral' ? 0.05 : 0)
      : (mode === 'conservative' ? 0.25 : mode === 'neutral' ? 0.15
        : mode === 'random' ? 0.15 : mode === 'aggressive' ? 0.08 : 0);
    // Don't hold back if we have 8+ cards (need to discard anyway)
    if (holdChance > 0 && bot.hand.length <= 7 && rnd() < holdChance) return null;
  }
  // Also: if only OPSEC cards remain in hand, conservative/neutral hold them
  if ((mode === 'conservative' || mode === 'neutral') && played >= 1) {
    const nonOpsec = bot.hand.filter(c => c.action !== 'opsec');
    if (nonOpsec.length === 0) return null; // only OPSEC in hand — hold it
  }

  const plan = (() => {
    switch (mode) {
      case 'random':       return decideRandom(state, bot, botId);
      case 'conservative': return decideConservative(state, bot, botId);
      case 'neutral':      return decideNeutral(state, bot, botId);
      case 'aggressive':   return decideAggressive(state, bot, botId);
      case 'chud':         return decideChud(state, bot, botId);
      default:             return decideNeutral(state, bot, botId);
    }
  })();

  // §3.10 last line of defence. Every personality has its own banking rules and every one of
  // them values a card by its face value, so five separate code paths could each decide to
  // bank a 5M Inspector General for cash while the player across the table is one turn from
  // winning. Vetoing it once, here, covers all five (and anything added later) instead of
  // patching the same mistake in five places. We only reach this line when the break branch
  // above already declined to fire — either the urgency roll failed or the card had no legal
  // target this instant — and in both cases holding the card is strictly better than
  // converting the only counter in the deck into money we will never get to spend.
  if (armed.length > 0 && plan && plan.type === 'play_money' && isHardBreaker(bot.hand[plan.cardIndex])) {
    const alt = bot.hand.findIndex((c, i) => i !== plan.cardIndex && !isHardBreaker(c)
      && c.type !== 'property' && c.type !== 'wild_property' && c.action !== 'opsec');
    return alt >= 0 ? { type:'play_money', cardIndex:alt } : null;
  }
  return plan;
}

/* ── RANDOM MODE — unpredictable but slightly smarter ──────────────── */

function decideRandom(state, bot, botId) {
  // A 15% per-decision pass compounded with decideBotPlay's holdback into a 2.5%
  // mixed winrate (§3 floor is 8%). 5% → 8.6%/10.0% on two seeds, 2% → 11.8%/14.1%.
  if (rnd() < 0.02) return null;

  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // Shuffle indices
  const indices = hand.map((_, i) => i);
  shuffle(indices);

  // Slight bias: if we have properties, 60% chance to play them first
  if (rnd() < 0.6) {
    for (const i of indices) {
      const play = randomPropertyPlay(bot, hand[i], i);
      if (play) return play;
    }
  }

  for (const i of indices) {
    const c = hand[i];

    const propPlay = randomPropertyPlay(bot, c, i);
    if (propPlay) return propPlay;
    if (c.type === 'money') {
      return { type: 'play_money', cardIndex: i };
    }
    if (c.type === 'rent') {
      const color = randomRentColor(bot, c);
      const play = makeRentPlay(state, bot, hand, i, color, opponents, 'random');
      if (play) return play;
    }
    if (c.type === 'action') {
      const action = tryRandomAction(state, bot, botId, c, i, opponents);
      if (action) return action;
    }
  }
  return null;
}

// Random/chud placement still has to respect the zone cap (§3.5).
// Uniform-random colors scattered wilds across all ten sets and random never finished
// one (1.2% winrate); a 70% pull toward a colour already started keeps the personality
// unpredictable but lets it actually win.
function randomWildColor(bot, card) {
  const open = openColorsForWild(bot, card);
  if (open.length === 0) return null;
  const started = open.filter(color => (bot.properties[color] || []).length > 0);
  const pool = started.length > 0 && rnd() < 0.7 ? started : open;
  return pool[Math.floor(rnd() * pool.length)];
}

function randomPropertyPlay(bot, card, idx) {
  if (card.type === 'property') {
    return G.zoneFull(bot, card.color) ? null : { type: 'play_property', cardIndex: idx };
  }
  if (card.type === 'wild_property') {
    const color = randomWildColor(bot, card);
    if (!color) return null;
    return { type: 'play_property', cardIndex: idx, targetColor: color };
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
      // Only if a rent can actually follow it (§3.1c — Finance Office and Roll Call are
      // never doubled). Random keeps a small chance of arming one for nothing, because
      // that is the seat's character; it used to be a coin flip, and 83% of its Surges
      // expired unused.
      if (bot.hand.some(c => c.type === 'rent' && chooseBestRentColor(bot, c)) && state.playsRemaining >= 2) {
        return { type: 'play_action', cardIndex: idx };
      }
      return rnd() < 0.2 ? { type: 'play_action', cardIndex: idx } : null;
    case 'finance_office': {
      const t = opponents.length > 0 ? opponents[Math.floor(rnd() * opponents.length)] : null;
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
  const mode = 'conservative';
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

  // 1. Surge before a rent — and ONLY before a rent (§3.1c; see hasChargeFollowUp).
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  const rentOnComplete = findRentOnCompleteSet(state, bot, hand, opponents, mode);
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && (rentOnComplete || hasChargeFollowUp(bot, hand, opponents))) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 1b. A live Surge expires at end of turn, so once it is armed the rent comes next, full
  //     stop. Conservative used to arm one and then wander off to PCS Orders or a property
  //     and throw the multiplier away — 89 of its 145 Surges were followed by something
  //     other than a charge, and 64% expired unused.
  if (state._surgeOps) {
    const surged = rentOnComplete || findBestRent(state, bot, hand, 0, opponents, mode);
    if (surged) return surged;
  }

  // 2. Rent on complete sets — good income, low risk
  if (rentOnComplete) return rentOnComplete;

  // 3. PCS Orders — draw more cards (sometimes first, sometimes after property)
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0 && (played === 0 || rnd() < 0.5)) {
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
  const decentRent = findBestRent(state, bot, hand, 2, opponents, mode);
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
  const mode = 'neutral';
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

  // 1. Surge Ops → charge combo (rent, Finance Office or Roll Call — §3.3)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && hasChargeFollowUp(bot, hand, opponents)) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 2. Rent if surged, or high-value rent (>= 3)
  if (state._surgeOps) {
    const rentPlay = findBestRent(state, bot, hand, 0, opponents, mode);
    if (rentPlay) return rentPlay;
  }

  // 3. Vary opening play — don't always lead with property
  const roll = rnd();
  if (played === 0) {
    if (roll < 0.35) {
      // 35% chance: lead with rent if decent
      const highRent = findBestRent(state, bot, hand, 2, opponents, mode);
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
  const rentPlay = findBestRent(state, bot, hand, 2, opponents, mode);
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
  const lowRent = findBestRent(state, bot, hand, 1, opponents, mode);
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
  const mode = 'aggressive';
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const mySets = G.completedSets(bot);
  const played = 3 - state.playsRemaining;

  // If we have 0 sets and 0 properties, build first (need sets to win)
  if (mySets === 0 && Object.values(bot.properties).every(c => c.length === 0) && played === 0) {
    const propPlay = findBestPropertyPlay(bot, hand);
    if (propPlay) return propPlay;
  }

  // 1. Surge Ops first (before any charge — §3.3)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && hasChargeFollowUp(bot, hand, opponents)) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 2. Rent — any color with properties, maximize damage
  const rentPlay = findBestRent(state, bot, hand, 0, opponents, mode);
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

  // 0. Coin-flip: sometimes slam a property down before the harassment starts.
  //    Pure harass-first left chud with 1.4 sets at game end (5.2% vs 3 neutral).
  if (rnd() < 0.45) {
    for (let i = 0; i < hand.length; i++) {
      const play = randomPropertyPlay(bot, hand[i], i);
      if (play) return play;
    }
  }

  // 1. CHUD card — play it immediately for maximum chaos
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'chud') {
      // Spraying CHUD at whoever left chud unable to answer a final approach later:
      // 53.8% of approaches converted against an all-chud field vs 47.6% vs aggressive.
      const threat = biggestThreat(opponents);
      const target = (threat && chudTargetOn(threat)) || findChudChudTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 2. Inspector General — seize sets chaotically (target random complete set)
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'inspector_general') {
      const threat = biggestThreat(opponents);
      if (threat) {
        const sets = completeSetCards(threat);
        if (sets.length > 0) return { type: 'play_action', cardIndex: i, targetId: threat.id, targetColor: sets[0].color };
      }
      const target = findRandomIGTarget(opponents) || findBestIGTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color };
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
      const target = opponents.length > 0 ? opponents[Math.floor(rnd() * opponents.length)] : null;
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

  // 7. Surge Ops. Chud still burns it carelessly — but only when a rent can follow, or on a
  //    quarter-chance for the noise. 126 of chud's 185 Surges were armed with no rent in
  //    hand at all, and a multiplier that cannot fire is not chaos, it is a lost play.
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && (hasChargeFollowUp(bot, hand, opponents) || rnd() < 0.25)) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 8. Rent — actually charge it now (chaotically pick a color)
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'rent') {
      const color = randomRentColor(bot, c);
      const play = makeRentPlay(state, bot, hand, i, color, opponents, 'chud');
      if (play) return play;
    }
  }

  // 9. Properties — play them but on random/suboptimal colors
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'property') {
      if (G.zoneFull(bot, c.color)) continue;
      return { type: 'play_property', cardIndex: i };
    }
    if (c.type === 'wild_property') {
      const open = openColorsForWild(bot, c);
      if (open.length === 0) continue;
      // 50% chance to pick worst color, 50% chance random
      const color = rnd() > 0.5
        ? chooseBestColorForWild(bot, c)
        : open[Math.floor(rnd() * open.length)];
      if (color) return { type: 'play_property', cardIndex: i, targetColor: color };
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
      if (G.zoneFull(bot, c.color)) continue;
      const pct = progress[c.color]?.pct || 0;
      // Prefer colors we're already building + smaller sets (easier to complete)
      const sizeBonus = (5 - G.COLORS[c.color].size) * 0.1;
      const score = pct + sizeBonus + (progress[c.color]?.have > 0 ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; bestPlay = { type: 'play_property', cardIndex: i }; }
    }
    if (c.type === 'wild_property') {
      const color = chooseBestColorForWild(bot, c);
      if (!color) continue;
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

// The ONE place a bot decision becomes an engine call. Exported (`_internal.applyBotAction`)
// because every harness that drives bots — simulate.js, the test suite, anything an agent
// writes next — otherwise reimplements this switch, and the day a new action type appears
// each copy silently stops executing it and spins the turn loop instead. That is exactly
// what happened when §3.8's free rearrange was added.
function applyBotAction(state, botId, action) {
  switch (action.type) {
    case 'play_property':
      return G.playProperty(state, botId, action.cardIndex, action.targetColor);
    case 'play_money':
      return G.playAsMoney(state, botId, action.cardIndex);
    case 'play_action':
      return G.playAction(state, botId, action.cardIndex, {
        targetId: action.targetId,
        targetColor: action.targetColor,
        targetCardId: action.targetCardId,
        myCardId: action.myCardId,
      });
    // §3.8 — free, and it does NOT spend a play. planRearrange() re-checks every
    // precondition these two enforce, so a refusal here would be a bug rather than a
    // rejected gamble: the turn would neither advance nor end.
    case 'rearrange':
      return G.moveProperty(state, botId, action.cardId, action.toColor);
    case 'swap':
      return G.swapProperties(state, botId, action.cardIdA, action.cardIdB);
    default:
      return { error: 'Unknown bot action ' + action.type };
  }
}

function executeBotPlay(state, room, botId, action, callbacks) {
  const result = applyBotAction(state, botId, action);
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
  // Blind `(idx+1) % len` skipped beginTurn() and could hand the turn to an eliminated
  // seat; forceEndTurn() advances to the next ACTIVE seat and runs the turn-start hooks.
  if (result.error) G.forceEndTurn(state);
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

// §3.5 — a zone that already holds a full set is not a legal destination.
function openColorsForWild(bot, card) {
  const all = card.colors[0] === 'any' ? Object.keys(G.COLORS) : card.colors;
  return all.filter(color => G.COLORS[color] && !G.zoneFull(bot, color));
}

function chooseBestColorForWild(bot, card) {
  const validColors = openColorsForWild(bot, card);
  if (validColors.length === 0) return null;
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

// §3.2 — the wild ("any") rent card must name a single victim.
function isWildRent(card) { return card.type === 'rent' && card.colors[0] === 'any'; }

// What a charge of `face` is actually worth against this opponent. Two corrections to
// "the rent number on the card":
//   - it is capped by what they can hand over. A 7M rent aimed at a player holding 2M
//     collects 2M, and aiming it at somebody solvent instead is free money.
//   - anything above their BANK has to come off the board, and a property leaving their
//     board is worth more than the same millions in cash — that is the denial half of a
//     rent, and it is why bleeding a player past their cash is not the same as taxing them.
function collectableFrom(opp, face) {
  const got = Math.min(face, G.playerTotalValue(opp));
  return got + (got > bankValue(opp) ? 1.5 : 0);
}

function chooseRentTarget(opponents, mode, face = Infinity) {
  const live = opponents.filter(o => !o.eliminated);
  if (live.length === 0) return null;
  // §3.10 — bleed the armed player first, and when two are armed pick the one further along.
  const armed = live.filter(o => o.finalApproach);
  if (armed.length > 0) {
    return armed.reduce((best, p) => (G.completedSets(p) > G.completedSets(best) ? p : best));
  }
  if (mode === 'chud' || mode === 'random') return live[Math.floor(rnd() * live.length)];
  // Hit whoever the charge actually hurts most, with the leader worth two millions a set —
  // so a rent goes to the player in front unless they are too broke to feel it.
  return live.reduce((best, p) =>
    (collectableFrom(p, face) + 2 * G.completedSets(p)
      > collectableFrom(best, face) + 2 * G.completedSets(best)) ? p : best);
}

// §3.1c — Surge Ops applies to RENT ONLY, and it STACKS. This is the multiplier a rent
// played right now would be charged at.
function surgeMultiplier(state) { return 2 ** (state?._surgeOps || 0); }

// What a rent card is worth THIS INSTANT, in millions actually collected.
//
// The old ranking compared `calcRent` across cards and took the biggest number, which is the
// wrong comparison in two ways at once. A COLOUR rent hits every opponent (only §3.2's wild
// "any" rent names a single victim), so a 2M charge on a colour collects 6M at a four-handed
// table while a 4M wild rent collects 4M — and either is capped by what the victims own.
// Measured before this: conservative captured 91.7% of the millions its own hand could have
// collected and neutral 96.4%, the whole gap being wild-versus-colour and target choice.
function rentYield(state, bot, card, color, opponents, mode) {
  const face = G.calcRent(bot, color) * surgeMultiplier(state);
  if (face <= 0 || opponents.length === 0) return { face, value: 0, target: null };
  if (isWildRent(card)) {
    const target = chooseRentTarget(opponents, mode, face);
    return { face, value: target ? collectableFrom(target, face) : 0, target };
  }
  let total = 0;
  for (const o of opponents) total += collectableFrom(o, face);
  return { face, value: total, target: null };
}

function makeRentPlay(state, bot, hand, cardIndex, color, opponents, mode) {
  const card = hand[cardIndex];
  if (!card || !color) return null;
  const play = { type: 'play_action', cardIndex, targetColor: color };
  if (isWildRent(card)) {
    const face = G.calcRent(bot, color) * surgeMultiplier(state);
    const target = chooseRentTarget(opponents, mode, face);
    if (!target) return null;
    play.targetId = target.id;
  }
  return play;
}

// `minRent` still gates on the card's FACE value — that is the "is this rent worth a play
// at all" question every personality tunes — but the choice between cards that clear the
// gate is made on what they actually collect.
function findBestRent(state, bot, hand, minRent, opponents, mode) {
  let bestRent = null;
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type !== 'rent') continue;
    const color = chooseBestRentColor(bot, c);
    if (!color) continue;
    if (G.calcRent(bot, color) < minRent) continue;
    const { value } = rentYield(state, bot, c, color, opponents, mode);
    if (!bestRent || value > bestRent.value) bestRent = { cardIndex: i, color, value };
  }
  if (!bestRent) return null;
  return makeRentPlay(state, bot, hand, bestRent.cardIndex, bestRent.color, opponents, mode);
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
  return validColors.length > 0 ? validColors[Math.floor(rnd() * validColors.length)] : null;
}

// The BEST rent on a complete set, not the first one the hand happens to hold.
function findRentOnCompleteSet(state, bot, hand, opponents, mode) {
  let best = null;
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type !== 'rent') continue;
    const validColors = c.colors[0] === 'any' ? Object.keys(bot.properties) : c.colors;
    for (const color of validColors) {
      if (!G.isSetComplete(bot, color)) continue;
      const { value } = rentYield(state, bot, c, color, opponents, mode);
      if (!best || value > best.value) best = { i, color, value };
    }
  }
  if (!best) return null;
  return makeRentPlay(state, bot, hand, best.i, best.color, opponents, mode);
}

// Surge Ops is only worth a play if a RENT can follow it this turn.
//
// §3.1c: Surge follows Double The Rent — it applies to rent ONLY, never Finance Office and
// never Roll Call, and `game.js` proves it, because those two call `chargeAmount()` with no
// `surgeable` flag and their multiplier is always 1. This function used to answer yes to
// either of them, so all three planning modes routinely spent a play arming a multiplier
// that could not fire. Round 5 fixed exactly this inside `tryBreakFinalApproach()` and left
// the personality planners — which is where nearly all the Surges are played — still wrong.
// Measured over 400 four-player games before the fix: 39% of neutral's and aggressive's
// Surges expired unused, 64% of conservative's, and 77-85% of the chaotic two's.
function hasChargeFollowUp(bot, hand, opponents) {
  if (opponents.length === 0) return false;
  for (const c of hand) {
    if (c.type === 'rent' && chooseBestRentColor(bot, c)) return true;
  }
  return false;
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
  return targets.length > 0 ? targets[Math.floor(rnd() * targets.length)] : null;
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
  return all.length > 0 ? all[Math.floor(rnd() * all.length)] : null;
}

function findRandomChudTarget(opponents) {
  const all = [];
  for (const opp of opponents) {
    for (const cards of Object.values(opp.properties)) {
      for (const c of cards) all.push({ playerId: opp.id, cardId: c.id });
    }
  }
  return all.length > 0 ? all[Math.floor(rnd() * all.length)] : null;
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
  return all.length > 0 ? all[Math.floor(rnd() * all.length)] : null;
}

/* ── Swap targets (TDY Orders) ──────────────────────────────────────── */

// §3.1 (reversed 2026-08-06, Hasbro FAQ 926) — TDY Orders may not take a card OUT of a
// complete set nor give one out of yours. Every swap finder filters both sides through
// this; without it the bot proposes a move playAction() refuses and burns its turn.
function swappableCards(player) {
  const out = [];
  for (const [color, cards] of Object.entries(player.properties || {})) {
    if (!G.zoneRequisitionable(player, color)) continue;
    for (const card of cards) out.push({ color, card });
  }
  return out;
}

function findSmartSwapTarget(bot, opponents) {
  let myWorst = null;
  for (const { color: col, card: c } of swappableCards(bot)) {
    if ((bot.properties[col] || []).length !== 1) continue;
    if (!myWorst || c.value < myWorst.value) myWorst = { cardId: c.id, value: c.value, color: col };
  }
  if (!myWorst) return null;

  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have > 0 && have < info.size && color !== myWorst.color) {
      for (const opp of opponents) {
        if (!G.zoneRequisitionable(opp, color)) continue;
        for (const c of (opp.properties[color] || [])) {
          return { targetPlayerId: opp.id, targetCardId: c.id, myCardId: myWorst.cardId };
        }
      }
    }
  }
  return null;
}

function findAggressiveSwapTarget(bot, opponents) {
  let myWorst = null;
  for (const { card: c } of swappableCards(bot)) {
    if (!myWorst || c.value < myWorst.value) myWorst = { cardId: c.id, value: c.value };
  }
  if (!myWorst) return null;

  let theirBest = null;
  for (const opp of opponents) {
    for (const { card: c } of swappableCards(opp)) {
      if (c.value > myWorst.value && (!theirBest || c.value > theirBest.value)) {
        theirBest = { targetPlayerId: opp.id, targetCardId: c.id, myCardId: myWorst.cardId, value: c.value };
      }
    }
  }
  return theirBest;
}

function findRandomSwapTarget(bot, opponents) {
  const myCards = swappableCards(bot).map(e => e.card.id);
  if (myCards.length === 0) return null;

  const theirCards = [];
  for (const opp of opponents) {
    for (const { card: c } of swappableCards(opp)) theirCards.push({ playerId: opp.id, cardId: c.id });
  }
  if (theirCards.length === 0) return null;

  const my = myCards[Math.floor(rnd() * myCards.length)];
  const their = theirCards[Math.floor(rnd() * theirCards.length)];
  return { targetPlayerId: their.playerId, targetCardId: their.cardId, myCardId: my };
}

/* ── Upgrade helpers ────────────────────────────────────────────────── */

function findUpgradeableSet(bot, type) {
  for (const [color] of Object.entries(bot.properties)) {
    if (!G.isSetComplete(bot, color)) continue;
    const ups = G.upgradeKinds(bot, color);
    if (type === 'upgrade' && !ups.includes('house')) return color;
    if (type === 'foc' && ups.includes('house') && !ups.includes('hotel')) return color;
  }
  return null;
}

/* ── Payment selection ──────────────────────────────────────────────── */

// Bank first, then upgrades, then properties: a House costs rent, a property can cost a set.
const PAY_RANK = { bank: 0, upgrade: 1, prop: 2 };
const bySource = (a, b) => PAY_RANK[a.source] - PAY_RANK[b.source];

function selectPaymentCards(bot, amount, mode) {
  const cards = [];
  bot.bank.forEach(c => cards.push({ id: c.id, value: c.value, source: 'bank' }));
  for (const [color, propCards] of Object.entries(bot.properties)) {
    const setProgress = (propCards.length || 0) / (G.COLORS[color]?.size || 99);
    propCards.forEach(c => cards.push({ id: c.id, value: c.value, source: 'prop', color, setProgress }));
  }
  // §3.1b — upgrades are payable. Spent after the bank but before properties: handing over
  // a House costs rent, handing over a property can cost a whole set.
  for (const [color, ups] of Object.entries(bot.upgrades || {})) {
    for (const u of ups) {
      if (u && typeof u === 'object') cards.push({ id: u.id, value: u.value, source: 'upgrade', color });
    }
  }
  if (cards.length === 0) return [];

  switch (mode) {
    case 'chud':
      // Chaotic order, but the bank goes first — feeding properties to the table while
      // sitting on cash was worth ~3 points of chud winrate.
      shuffle(cards);
      cards.sort(bySource);
      break;

    case 'conservative':
      // Bank first (smallest), protect near-complete sets
      cards.sort((a, b) => {
        if (a.source !== b.source) return bySource(a, b);
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
      // Random order *within* each pool, but cash before property: paying with random
      // properties while holding cash cost random ~2 points of winrate (4.5% → 6.6%).
      shuffle(cards);
      cards.sort(bySource);
      break;

    default: // neutral
      cards.sort((a, b) => {
        if (a.source !== b.source) return bySource(a, b);
        if (a.source === 'prop') return (a.setProgress || 0) - (b.setProgress || 0);
        return a.value - b.value;
      });
      break;
  }

  // §3.10 — never volunteer a card out of a completed set while armed; it disarms us.
  if (bot.finalApproach) {
    const complete = new Set(completeSetCards(bot).map(entry => entry.card.id));
    cards.sort((a, b) => (complete.has(a.id) ? 1 : 0) - (complete.has(b.id) ? 1 : 0));
  }

  return minimalCover(cards, amount);
}

/* ── Minimal-overpay cover ──────────────────────────────────────────────
 *
 * selectPaymentCards() used to close with a greedy walk in sorted order that stopped the
 * moment it had ENOUGH and never asked whether a different combination got CLOSER. A bank
 * of [1, 10] paying a 5M charge took the 1 (total 1 < 5), then the 10 (total 11 >= 5), and
 * handed over 11M for a 5M debt.
 *
 * Measured at HEAD over 400 four-player games, on every payment the payer could actually
 * afford: every personality handed over 28-32% more than it owed — 7.6-8.8M per bot per
 * game — and 56-61% of all solvent payments overpaid at all. That is the owner's report
 * ("bots just pay or give way extra") as a number.
 *
 * THE ORDER ABOVE IS NOT OVERRIDDEN — it is re-expressed as a cost, so the search runs
 * INSIDE it instead of over it. Every card carries a weight: bank 0, upgrade 1, property
 * 4 + how complete its set is. The weights are separated by more than the largest card in
 * the deck (10M), so no amount of overpay saving can ever promote a worse tier: a property
 * is spent only when the bank and the upgrades genuinely cannot cover the debt, exactly as
 * the sort already decided. That ordering is measured, not arbitrary (a House costs rent, a
 * property can cost a set; getting it wrong cost chud ~3 points and random ~2), and §3.10's
 * rule that an armed bot never volunteers a card out of a completed set survives as the
 * heaviest weight of all.
 *
 * What the search actually buys, in order: the cheapest TIER MIX first, then the smallest
 * overpay reachable with that mix, then the fewest cards. So within the bank it makes exact
 * change instead of stopping at the first card that clears the bar, and when it does have to
 * reach for property it takes the fewest cards out of the least-complete sets rather than
 * whichever ones the walk happened to touch first.
 *
 * Zero-value cards are dropped from the search: they cannot move the total, so including one
 * is pure loss. §3.4 still makes them surrenderable — an insolvent payer hands over
 * everything through acceptAction()'s fallback, zero-value wilds included.
 *
 * COST: the pool is every payable card (rarely more than ~25) and the totals are small
 * integers capped at `amount + 10`, so this is a few hundred operations per payment. Timed
 * over a 10,000-game matrix it is inside run-to-run noise.
 */

// Tier weights. The gaps are wider than the largest card value in the deck, which is what
// makes the tier order lexicographic rather than merely preferred.
function payWeight(c) {
  if (c.source === 'bank') return 0;
  if (c.source === 'upgrade') return 1;
  return 4 + (c.setProgress || 0);   // property: near-complete sets cost more to break up
}

function minimalCover(cards, amount) {
  const pool = [];
  let poolTotal = 0;
  for (let i = 0; i < cards.length; i++) {
    poolTotal += cards[i].value;
    if (cards[i].value > 0) pool.push({ ...cards[i], rank: i, w: cards[i].weight ?? payWeight(cards[i]) });
  }
  // Insolvent — hand over everything and let the engine's "surrender every card you own"
  // branch (§3.4) take it, zero-value wilds included.
  if (poolTotal < amount || pool.length === 0) return cards.map(c => c.id);

  let maxVal = 0;
  for (const c of pool) if (c.value > maxVal) maxVal = c.value;
  const cap = amount + maxVal;

  // dp[t] = cheapest (weight, then card count) way to reach EXACTLY t. `layers` keeps one
  // snapshot per item so the winning selection can be walked back out.
  let dp = new Array(cap + 1).fill(null);
  dp[0] = { w: 0, count: 0, take: -1, from: 0 };
  const layers = [dp];
  for (let i = 0; i < pool.length; i++) {
    const v = pool[i].value;
    const next = dp.slice();
    for (let t = 0; t + v <= cap; t++) {
      const cur = dp[t];
      if (!cur) continue;
      const cand = { w: cur.w + pool[i].w, count: cur.count + 1, take: i, from: t };
      const old = next[t + v];
      if (!old || cand.w < old.w - 1e-9
        || (Math.abs(cand.w - old.w) < 1e-9 && cand.count < old.count)) next[t + v] = cand;
    }
    dp = next;
    layers.push(dp);
  }

  // Cheapest tier mix first, then the smallest overpay it can make, then the fewest cards.
  // Scanning t upward from `amount` makes the overpay tie-break implicit: the first total
  // that reaches a given weight is the least it can overshoot by at that weight.
  let best = -1;
  for (let t = amount; t <= cap; t++) {
    const n = dp[t];
    if (!n) continue;
    if (best < 0) { best = t; continue; }
    const b = dp[best];
    if (n.w < b.w - 1e-9) best = t;
  }
  if (best < 0) return cards.map(c => c.id);   // unreachable: poolTotal >= amount above

  const out = [];
  let layer = layers.length - 1, t = best;
  while (t > 0) {
    const node = layers[layer][t];
    if (!node || node.take < 0) break;
    out.push(pool[node.take].id);
    layer = node.take;
    t = node.from;
  }
  return out;
}

// Must mirror G.payableCards() exactly. §3.1b made upgrades payable, and the engine only
// accepts a short payment when EVERY payable card is surrendered — omitting the upgrades
// here made the "pay with everything" fallback fail forever (measured: 82k refusals and
// 7/400 games that never reached an ending).
function getAllPayableCardIds(bot) {
  return G.payableCards(bot).map(c => c.id);
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
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  scheduleBotAction, cancelBotTimeout,
  // Exported for simulation harness
  _internal: {
    decideBotPlay, shouldPlayOpsecDecision, selectPaymentCards, setRng, rnd,
    planRearrange, boardScore, minimalCover, applyBotAction,
    REARRANGE_BIAS, REARRANGE_CONSOLIDATES, payWeight,
    BREAK_URGENCY, BREAK_OVERPAY, disposableValue, tryBreakFinalApproach,
    getAllPayableCardIds, chooseDiscards, findResponder: function(state) {
      return G.pendingResponders(state)[0] || null;
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
      acceptAction(state, bot, botId, pa, mode);
    },
  },
};
