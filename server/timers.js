// server/timers.js — Turn timer and response timer management

let G, Bot, broadcast;

function init(deps) {
  G = deps.G;
  Bot = deps.Bot;
  broadcast = deps.broadcast;
}

/* ── Turn timer ─────────────────────────────────────────────────────── */

// Arms (or disarms) only the turn deadline. Never touches the response timer or the bot
// timeout, so it is safe to call from syncTimers().
function armTurnTimer(room) {
  if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; }
  room.turnStartedAt = null;
  if (!room.turnTimeout || room.turnTimeout <= 0) return;
  if (!room.state || room.state.phase !== 'playing') return;
  if (room.state.pendingAction) return;
  room.turnStartedAt = Date.now();
  room.turnTimerId = setTimeout(() => onTurnTimeout(room), room.turnTimeout * 1000);
}

function onTurnTimeout(room) {
  room.turnTimerId = null;
  room.turnStartedAt = null;
  if (!room.state || room.state.phase !== 'playing') return;
  const cp = G.currentPlayer(room.state);
  if (room.state.pendingAction) { startResponseTimer(room); return; }
  G.logLine(room.state, cp.name + '\'s turn timed out!');
  room.state.turnPhase = 'play';
  const excess = cp.hand.length > 7 ? cp.hand.slice(-(cp.hand.length - 7)).map(c => c.id) : undefined;
  const res = G.endTurn(room.state, cp.id, excess);
  // Blind `(idx+1) % len` here could hand the turn to an eliminated seat and skipped
  // beginTurn(), so an armed final approach parked at its checkpoint never resolved.
  if (res.error) G.forceEndTurn(room.state);
  startTurnTimer(room);
  broadcast.broadcastAndScheduleBot(room);
}

// The pendingAction branch is deliberately BEFORE the turnTimeout<=0 return: response
// deadlines must not depend on the turn clock. With turnTimeout 0 (Quick Play) the old
// order meant a bot's charge armed no response timer at all — nothing ever auto-resolved
// and the client correctly showed no countdown.
function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.state || room.state.phase !== 'playing') return;
  if (room.state.pendingAction) { startResponseTimer(room); return; }
  armTurnTimer(room);
}

// Idempotent reconciliation of room timers against room.state. Called after every
// broadcast (including the bots' own) so a pending action created outside a handler —
// a bot playing rent — still gets a response deadline.
function syncTimers(room) {
  if (!room?.state) return;
  // A finished game must not leave a re-arming turn timer behind.
  if (room.state.phase !== 'playing') { clearTurnTimer(room); return; }
  if (room.state.pendingAction) {
    if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; room.turnStartedAt = null; }
    if (!room.responseTimerId) startResponseTimer(room);
    return;
  }
  if (room.responseTimerId) clearResponseTimer(room);
  if (!room.turnTimerId) armTurnTimer(room);
}

function clearTurnTimer(room) {
  if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; }
  room.turnStartedAt = null;
  clearResponseTimer(room);
  Bot.cancelBotTimeout(room);
}

/* ── Response timer ──────────────────────────────────────────────────── */

function startResponseTimer(room) {
  clearResponseTimer(room);
  if (!room.responseTimeout || room.responseTimeout <= 0) return;
  if (!room.state?.pendingAction) return;
  room.responseStartedAt = Date.now();
  room.responseTimerId = setTimeout(() => {
    if (!room.state || !room.state.pendingAction) return;
    autoResolveResponse(room);
  }, room.responseTimeout * 1000);
}

function clearResponseTimer(room) {
  if (room.responseTimerId) { clearTimeout(room.responseTimerId); room.responseTimerId = null; }
  room.responseStartedAt = null;
}

function autoResolveResponse(room) {
  const pa = room.state.pendingAction;
  if (!pa) return;

  const responderId = G.pendingResponders(room.state)[0];
  if (!responderId) return;

  const responder = G.getPlayer(room.state, responderId);
  if (!responder) return;

  G.logLine(room.state, responder.name + '\'s response timed out — auto-accepting');

  const owed = pa.type === 'payment' && responderId !== pa.sourceId ? (pa.amount || 0) : 0;
  const res = G.respondToAction(room.state, responderId, 'accept', autoPickPayment(responder, owed));
  if (res.needPayment) {
    G.respondToAction(room.state, responderId, 'accept', G.payableCards(responder).map(c => c.id));
  }

  if (room.state.pendingAction) {
    startResponseTimer(room);
  } else {
    startTurnTimer(room);
  }
  broadcast.broadcastAndScheduleBot(room);
}

function autoPickPayment(player, amount) {
  if (!amount || amount <= 0) return [];
  const cards = [];
  let total = 0;

  const bankSorted = [...(player.bank || [])].sort((a, b) => a.value - b.value);
  for (const c of bankSorted) {
    if (total >= amount) break;
    cards.push(c.id);
    total += c.value;
  }

  if (total < amount) {
    const allProps = [];
    for (const propCards of Object.values(player.properties || {})) {
      if (propCards) allProps.push(...propCards);
    }
    allProps.sort((a, b) => a.value - b.value);
    for (const c of allProps) {
      if (total >= amount) break;
      cards.push(c.id);
      total += c.value;
    }
  }

  return cards;
}

module.exports = {
  init, startTurnTimer, clearTurnTimer, startResponseTimer, clearResponseTimer,
  autoPickPayment, autoResolveResponse, syncTimers, armTurnTimer,
};
