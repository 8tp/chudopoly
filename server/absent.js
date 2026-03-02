// server/absent.js — Absent player handling and bot name generation

let G, broadcast;

function init(deps) {
  G = deps.G;
  broadcast = deps.broadcast;
}

const BOT_CALLSIGNS = [
  'Viper', 'Iceman', 'Phoenix', 'Rooster', 'Hangman',
  'Warlock', 'Coyote', 'Merlin', 'Slider', 'Bandit',
  'Cobra', 'Hawk', 'Reaper', 'Phantom', 'Shadow',
  'Bolt', 'Ace', 'Blaze', 'Raptor', 'Jester',
];

function generateBotName(room) {
  const used = room.players.map(p => p.name);
  const available = BOT_CALLSIGNS.filter(n => !used.includes(n));
  return available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : 'Bot-' + Math.floor(Math.random() * 900 + 100);
}

function handleAbsent(room) {
  if (!room?.state || room.state.phase !== 'playing') return;
  const MAX_ITER = 30;
  for (let i = 0; i < MAX_ITER; i++) {
    if (room.state.phase !== 'playing') return;

    const active = room.players.filter(x => !room.state.players?.find(sp => sp.id === x.id)?.eliminated);
    const connected = active.filter(x => x.isBot || x.ws?.readyState === 1);
    const humanConnected = active.filter(x => !x.isBot && x.ws?.readyState === 1);
    if (humanConnected.length === 0 && connected.length > 1) {
      return;
    }
    if (connected.length <= 1 && active.length > 1) {
      if (connected.length === 1) {
        const winner = G.getPlayer(room.state, connected[0].id);
        room.state.phase = 'finished';
        room.state.winner = connected[0].id;
        room.state.log.push(winner.name + ' wins — all other players left!');
      }
      return;
    }

    if (room.state.pendingAction) {
      const pa = room.state.pendingAction;

      if (pa.type === 'payment_all') {
        let resolved = false;
        for (const pid of [...(pa.pending || [])]) {
          if (!broadcast.isConnected(room, pid)) {
            const gp = G.getPlayer(room.state, pid);
            const rpName = gp?.name || '?';
            let payCards = [];
            gp.bank.forEach(c => payCards.push(c.id));
            for (const cards of Object.values(gp.properties))
              cards.forEach(c => payCards.push(c.id));
            G.respondToAction(room.state, pid, 'accept', payCards.length > 0 ? payCards : undefined);
            room.state.log.push(rpName + ' is absent — auto-resolved');
            resolved = true;
          }
        }
        for (const [pid, chain] of Object.entries(pa.opsecChains || {})) {
          if (!broadcast.isConnected(room, chain.responderId)) {
            G.respondToAction(room.state, chain.responderId, 'accept');
            const gp = G.getPlayer(room.state, chain.responderId);
            room.state.log.push((gp?.name || '?') + ' is absent — auto-resolved');
            resolved = true;
          }
        }
        if (resolved) continue;
        if ((pa.pending?.length > 0) || Object.keys(pa.opsecChains || {}).length > 0) return;
        continue;
      }

      if (pa.responderId && !broadcast.isConnected(room, pa.responderId)) {
        const gp = G.getPlayer(room.state, pa.responderId);
        const rpName = gp?.name || '?';
        let payCards = [];
        if (pa.type === 'payment') {
          gp.bank.forEach(c => payCards.push(c.id));
          for (const cards of Object.values(gp.properties))
            cards.forEach(c => payCards.push(c.id));
        }
        G.respondToAction(room.state, pa.responderId, 'accept', payCards.length > 0 ? payCards : undefined);
        room.state.log.push(rpName + ' is absent — auto-resolved');
        continue;
      }
      return;
    }

    const cp = G.currentPlayer(room.state);
    if (cp.eliminated || !broadcast.isConnected(room, cp.id)) {
      if (!cp.eliminated) room.state.log.push(cp.name + ' is absent — turn skipped');
      room.state.turnPhase = 'play';
      const excess = cp.hand.length > 7 ? cp.hand.slice(-(cp.hand.length - 7)).map(c => c.id) : undefined;
      const res = G.endTurn(room.state, cp.id, excess);
      if (res.error) {
        room.state.currentPlayerIndex = (room.state.currentPlayerIndex + 1) % room.state.players.length;
        room.state.turnPhase = 'draw';
        room.state.playsRemaining = 3;
      }
      continue;
    }

    return;
  }
}

module.exports = { init, generateBotName, handleAbsent };
