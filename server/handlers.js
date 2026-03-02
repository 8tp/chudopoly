// server/handlers.js — WebSocket message handlers

let G, Bot, broadcast, timers, absent;
let rooms, globalChat, CHAT_MAX, chatIdRef, genCode, genId, wss;

function init(deps) {
  G = deps.G;
  Bot = deps.Bot;
  broadcast = deps.broadcast;
  timers = deps.timers;
  absent = deps.absent;
  rooms = deps.rooms;
  globalChat = deps.globalChat;
  CHAT_MAX = deps.CHAT_MAX;
  chatIdRef = deps.chatIdRef;
  genCode = deps.genCode;
  genId = deps.genId;
  wss = deps.wss;
}

function handleMessage(ws, msg, state) {
  const playerId = state.playerId;
  const roomCode = state.roomCode;

  switch (msg.type) {

    case 'create_room': {
      const code = genCode();
      state.playerId = genId();
      state.roomCode = code;
      const player = { id: state.playerId, name: msg.name || 'Player 1', ws };
      const room = { code, phase: 'lobby', hostId: state.playerId, players: [player], state: null, chat: [] };
      rooms.set(code, room);
      broadcast.send(ws, { type: 'joined', code, playerId: state.playerId, name: player.name });
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${code} created by ${player.name}`);
      break;
    }

    case 'join_room': {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { broadcast.send(ws, { type: 'error', message: 'Room not found' }); break; }
      if (room.phase !== 'lobby') {
        const rjName = (msg.name || '').trim();
        const dc = room.players.find(x =>
          (!x.isBot || x._wasHuman) &&
          (!x.ws || x.ws.readyState !== 1) &&
          x.name.toLowerCase() === rjName.toLowerCase()
        );
        if (!dc) {
          broadcast.send(ws, { type: 'error', message: 'Game in progress. To rejoin, enter the EXACT call sign you used when you joined (case doesn\'t matter).' });
          break;
        }
        dc.ws = ws;
        if (dc.isBot && dc._wasHuman) {
          dc.isBot = false;
          delete dc._wasHuman;
          delete dc.botMode;
          Bot.cancelBotTimeout(room);
          console.log(`[BOT] ${code} ${dc.name} reclaimed from bot (rejoin)`);
        }
        state.playerId = dc.id;
        state.roomCode = code;
        broadcast.send(ws, { type: 'joined', code, playerId: dc.id, name: dc.name });
        broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
        if (room.chat.length) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
        broadcast.broadcastRoom(room);
        console.log(`[ROOM] ${code} ~${dc.name} rejoined game`);
        break;
      }
      if (room.players.length >= 5) { broadcast.send(ws, { type: 'error', message: 'Room is full (max 5)' }); break; }
      state.playerId = genId();
      state.roomCode = code;
      const name = msg.name || ('Player ' + (room.players.length + 1));
      const player = { id: state.playerId, name, ws };
      room.players.push(player);
      broadcast.send(ws, { type: 'joined', code, playerId: state.playerId, name });
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      if (room.chat.length) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${code} +${name} (${room.players.length} players)`);
      break;
    }

    case 'reconnect': {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { broadcast.send(ws, { type: 'error', message: 'Room not found' }); break; }
      const p = room.players.find(x => x.id === msg.playerId);
      if (!p) { broadcast.send(ws, { type: 'error', message: 'Player not found in room' }); break; }
      p.ws = ws;
      if (p.isBot && p._wasHuman) {
        p.isBot = false;
        delete p._wasHuman;
        delete p.botMode;
        Bot.cancelBotTimeout(room);
        console.log(`[BOT] ${code} ${p.name} reclaimed from bot (reconnect)`);
      }
      state.playerId = msg.playerId;
      state.roomCode = code;
      broadcast.send(ws, { type: 'joined', code, playerId: msg.playerId, name: p.name });
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      if (room.chat.length) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${code} ~${p.name} reconnected`);
      break;
    }

    case 'kick': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can kick' }); break; }
      if (room.phase !== 'lobby') { broadcast.send(ws, { type: 'error', message: 'Cannot kick during a game' }); break; }
      const target = room.players.find(x => x.id === msg.targetId);
      if (!target) break;
      if (target.id === playerId) { broadcast.send(ws, { type: 'error', message: 'Cannot kick yourself' }); break; }
      if (target.ws) { broadcast.send(target.ws, { type: 'kicked' }); try { target.ws.close(); } catch {} }
      room.players = room.players.filter(x => x.id !== msg.targetId);
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${roomCode} host kicked ${target.name}`);
      break;
    }

    case 'add_bot': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can add bots' }); break; }
      if (room.phase !== 'lobby') { broadcast.send(ws, { type: 'error', message: 'Cannot add bots during a game' }); break; }
      if (room.players.length >= 5) { broadcast.send(ws, { type: 'error', message: 'Room is full (max 5)' }); break; }
      const mode = ['random', 'conservative', 'neutral', 'aggressive', 'chud'].includes(msg.mode) ? msg.mode : 'neutral';
      const botId = genId();
      const botName = absent.generateBotName(room);
      const bot = { id: botId, name: botName, ws: null, isBot: true, botMode: mode };
      room.players.push(bot);
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${roomCode} +BOT ${botName} [${mode}] (${room.players.length} players)`);
      break;
    }

    case 'remove_bot': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can remove bots' }); break; }
      if (room.phase !== 'lobby') { broadcast.send(ws, { type: 'error', message: 'Cannot remove bots during a game' }); break; }
      const target = room.players.find(x => x.id === msg.targetId && x.isBot);
      if (!target) break;
      room.players = room.players.filter(x => x.id !== msg.targetId);
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${roomCode} -BOT ${target.name}`);
      break;
    }

    case 'leave_room': {
      const room = rooms.get(roomCode);
      if (!room) break;
      const lp = room.players.find(x => x.id === playerId);
      if (!lp) break;
      const wasHost = room.hostId === playerId;

      if (room.phase === 'playing') {
        lp.ws = null;
        lp.isBot = true;
        lp._wasHuman = true;
        lp.botMode = ['conservative', 'neutral', 'aggressive'][Math.floor(Math.random() * 3)];
        console.log(`[BOT] ${roomCode} bot took over for ${lp.name} [${lp.botMode}]`);
        if (wasHost) broadcast.transferHost(room);
        absent.handleAbsent(room);
        broadcast.broadcastAndScheduleBot(room);
      } else {
        room.players = room.players.filter(x => x.id !== playerId);
        console.log(`[ROOM] ${roomCode} -${lp.name} left`);
        if (room.players.length === 0 || room.players.every(x => x.isBot)) {
          rooms.delete(roomCode);
          console.log(`[ROOM] ${roomCode} deleted (empty)`);
        } else {
          if (wasHost) broadcast.transferHost(room);
          broadcast.broadcastRoom(room);
        }
      }
      state.playerId = null;
      state.roomCode = null;
      break;
    }

    case 'start_game': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can start' }); break; }
      if (room.players.length < 2) { broadcast.send(ws, { type: 'error', message: 'Need at least 2 players' }); break; }
      room.phase = 'playing';
      room.turnTimeout = Math.max(0, Math.min(300, parseInt(msg.turnTimeout) || 0));
      room.responseTimeout = Math.max(0, Math.min(120, parseInt(msg.responseTimeout) || 0));
      room.state = G.createGame(room.players.map(p => ({ id: p.id, name: p.name })));
      if (room.turnTimeout > 0) timers.startTurnTimer(room);
      broadcast.broadcastAndScheduleBot(room);
      console.log(`[GAME] ${roomCode} started with ${room.players.length} players, timeout=${room.turnTimeout}s, responseTimeout=${room.responseTimeout}s`);
      break;
    }

    case 'draw': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const cp = G.currentPlayer(room.state);
      if (cp.id !== playerId) { broadcast.send(ws, { type: 'error', message: 'Not your turn' }); break; }
      if (room.state.turnPhase !== 'draw') { broadcast.send(ws, { type: 'error', message: 'Not draw phase' }); break; }
      const drawRes = G.drawCards(room.state);
      if (drawRes.autoWin) timers.clearTurnTimer(room);
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'play_money': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.playAsMoney(room.state, playerId, msg.cardIndex);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'play_property': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.playProperty(room.state, playerId, msg.cardIndex, msg.targetColor);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'move_property': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.moveProperty(room.state, playerId, msg.cardId, msg.toColor);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'play_action': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.playAction(room.state, playerId, msg.cardIndex, {
        targetId: msg.targetId,
        targetColor: msg.targetColor,
        targetCardId: msg.targetCardId,
        myCardId: msg.myCardId,
      });
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      if (room.state.pendingAction) {
        if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; }
        room.turnStartedAt = null;
        timers.startResponseTimer(room);
      }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'respond': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.respondToAction(room.state, playerId, msg.response, msg.paymentCards);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); }
      if (res.needPayment) { broadcast.send(ws, { type: 'need_payment', amount: res.amount }); break; }
      if (!room.state.pendingAction) {
        timers.clearResponseTimer(room);
        timers.startTurnTimer(room);
      } else {
        timers.startResponseTimer(room);
      }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'emote': {
      const room = rooms.get(roomCode);
      if (!room) break;
      const emotePlayer = room.players.find(x => x.id === playerId);
      if (!emotePlayer) break;
      const text = (msg.text || '').slice(0, 30);
      room.players.forEach(p => {
        if (p.ws?.readyState === 1) {
          p.ws.send(JSON.stringify({ type: 'emote', playerId, name: emotePlayer.name, text }));
        }
      });
      break;
    }

    case 'chat': {
      if (!playerId) break;
      const text = (msg.text || '').slice(0, 500);
      if (!text) break;
      const scope = msg.scope === 'global' ? 'global' : 'room';
      const room = rooms.get(roomCode);
      const cp = room?.players.find(x => x.id === playerId);
      const name = cp?.name || 'Anon';
      const entry = { id: ++chatIdRef.value, ts: Date.now(), pid: playerId, name, text, scope };
      if (scope === 'global') {
        globalChat.push(entry);
        if (globalChat.length > CHAT_MAX) globalChat.shift();
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'chat', msg: entry })); });
      } else {
        if (!room) break;
        room.chat.push(entry);
        if (room.chat.length > CHAT_MAX) room.chat.shift();
        room.players.forEach(rp => {
          if (rp.ws?.readyState === 1) rp.ws.send(JSON.stringify({ type: 'chat', msg: entry }));
        });
      }
      break;
    }

    case 'chat_history': {
      const room = rooms.get(roomCode);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      if (room) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
      break;
    }

    case 'scoop': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.scoop(room.state, playerId);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      if (room.state.phase === 'finished') timers.clearTurnTimer(room);
      else timers.startTurnTimer(room);
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'end_turn': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.endTurn(room.state, playerId, msg.discardIds);
      if (res.error) {
        broadcast.send(ws, { type: 'error', message: res.error, needDiscard: res.needDiscard, excess: res.excess });
        break;
      }
      timers.startTurnTimer(room);
      broadcast.broadcastAndScheduleBot(room);
      break;
    }
  }
}

function handleClose(state) {
  const { playerId, roomCode } = state;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  const p = room.players.find(x => x.id === playerId);
  if (p) {
    p.ws = null;
    if (room.phase === 'playing' && !p.isBot) {
      p.isBot = true;
      p._wasHuman = true;
      p.botMode = ['conservative', 'neutral', 'aggressive'][Math.floor(Math.random() * 3)];
      console.log(`[BOT] ${roomCode} bot took over for ${p.name} [${p.botMode}]`);
    }
  }
  console.log(`[ROOM] ${roomCode} -${p?.name || '?'} disconnected`);
  if (playerId === room.hostId) broadcast.transferHost(room);
  absent.handleAbsent(room);
  const closedRoomCode = roomCode;
  setTimeout(() => {
    const r = rooms.get(closedRoomCode);
    if (r && r.players.every(x => x.isBot || !x.ws || x.ws.readyState !== 1)) {
      rooms.delete(closedRoomCode);
      console.log(`[ROOM] ${closedRoomCode} deleted (empty)`);
    } else if (r) {
      broadcast.broadcastRoom(r);
    }
  }, 30000);
  broadcast.broadcastAndScheduleBot(room);
}

module.exports = { init, handleMessage, handleClose };
