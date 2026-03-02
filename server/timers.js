// server/timers.js — Turn timer and response timer management

let G, Bot, broadcast;

function init(deps) {
  G = deps.G;
  Bot = deps.Bot;
  broadcast = deps.broadcast;
}

/* ── Turn timer ─────────────────────────────────────────────────────── */

function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.turnTimeout || room.turnTimeout <= 0) return;
  if (!room.state || room.state.phase !== 'playing') return;
  if (room.state.pendingAction) {
    startResponseTimer(room);
    return;
  }
  room.turnStartedAt = Date.now();
  room.turnTimerId = setTimeout(() => {
    if (!room.state || room.state.phase !== 'playing') return;
    const cp = G.currentPlayer(room.state);
    if (room.state.pendingAction) {
      room.turnTimerId = null;
      room.turnStartedAt = null;
      startResponseTimer(room);
      return;
    }
    room.state.log.push(cp.name + '\'s turn timed out!');
    room.state.turnPhase = 'play';
    const excess = cp.hand.length > 7 ? cp.hand.slice(-(cp.hand.length - 7)).map(c => c.id) : undefined;
    const res = G.endTurn(room.state, cp.id, excess);
    if (res.error) {
      room.state.currentPlayerIndex = (room.state.currentPlayerIndex + 1) % room.state.players.length;
      room.state.turnPhase = 'draw';
      room.state.playsRemaining = 3;
    }
    startTurnTimer(room);
    broadcast.broadcastAndScheduleBot(room);
  }, room.turnTimeout * 1000);
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

  let responderId = pa.responderId;
  if (pa.type === 'payment_all' && pa.pending?.length > 0) {
    responderId = pa.pending[0];
  }
  if (pa.opsecChains) {
    for (const [pid, chain] of Object.entries(pa.opsecChains)) {
      if (chain.responderId) { responderId = chain.responderId; break; }
    }
  }
  if (!responderId) return;

  const responder = G.getPlayer(room.state, responderId);
  if (!responder) return;

  room.state.log.push(responder.name + '\'s response timed out — auto-accepting');

  const res = G.respondToAction(room.state, responderId, 'accept', autoPickPayment(responder, pa.amount || 0));
  if (res.needPayment) {
    const cards = autoPickPayment(responder, res.amount || pa.amount || 0);
    G.respondToAction(room.state, responderId, 'accept', cards);
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

module.exports = { init, startTurnTimer, clearTurnTimer, startResponseTimer, clearResponseTimer };
