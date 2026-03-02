// server/broadcast.js — Room broadcasting and connection utilities

let G, Bot;

function init(deps) {
  G = deps.G;
  Bot = deps.Bot;
}

function broadcastRoom(room) {
  const timerInfo = room.turnTimeout > 0 && room.turnStartedAt
    ? { timeout: room.turnTimeout, startedAt: room.turnStartedAt }
    : null;
  const responseTimerInfo = room.responseTimeout > 0 && room.responseStartedAt
    ? { timeout: room.responseTimeout, startedAt: room.responseStartedAt }
    : null;
  room.players.forEach(p => {
    if (p.ws?.readyState === 1) {
      const view = room.state ? G.getPlayerView(room.state, p.id) : null;
      p.ws.send(JSON.stringify({
        type: 'state', code: room.code,
        phase: room.phase,
        players: room.players.map(x => ({
          id: x.id, name: x.name,
          connected: x.isBot || x.ws?.readyState === 1,
          isBot: !!x.isBot, botMode: x.botMode || null,
        })),
        hostId: room.hostId,
        game: view,
        turnTimer: timerInfo,
        responseTimer: responseTimerInfo,
      }));
    }
  });
}

function broadcastAndScheduleBot(room) {
  broadcastRoom(room);
  Bot.scheduleBotAction(room, {
    broadcast: broadcastRoom,
    startTimer: require('./timers').startTurnTimer,
    clearTimer: require('./timers').clearTurnTimer,
  });
}

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function transferHost(room) {
  const connected = room.players.filter(x => x.ws?.readyState === 1 && x.id !== room.hostId && !x.isBot);
  if (connected.length === 0) return;
  const newHost = connected[Math.floor(Math.random() * connected.length)];
  room.hostId = newHost.id;
  console.log(`[ROOM] ${room.code} host transferred to ${newHost.name}`);
}

function isConnected(room, pid) {
  const p = room.players.find(x => x.id === pid);
  if (p?.isBot) return true;
  return p?.ws?.readyState === 1;
}

module.exports = { init, broadcastRoom, broadcastAndScheduleBot, send, transferHost, isConnected };
