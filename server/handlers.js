// server/handlers.js — WebSocket message handlers

let G, Bot, broadcast, timers, absent;
let rooms, globalChat, CHAT_MAX, chatIdRef, genCode, genId, genResumeToken, wss;

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
  genResumeToken = deps.genResumeToken;
  wss = deps.wss;
}

function sendJoined(ws, room, player) {
  broadcast.send(ws, {
    type: 'joined', code: room.code, playerId: player.id,
    resumeToken: player.resumeToken, name: player.name,
  });
}

let seedWarned = false;

// Dev/harness determinism hook (ARCHITECTURE §0.7). Refused in production so a
// misconfigured deploy can never hand every room the same deck.
function seedFromEnv(env = process.env) {
  const raw = env.CHUD_SEED;
  if (raw === undefined || raw === null || raw === '') return null;
  if (env.NODE_ENV === 'production') {
    if (!seedWarned) {
      seedWarned = true;
      console.warn('[SEED] CHUD_SEED is ignored in production');
    }
    return null;
  }
  return String(raw);
}

// A clock of 0 means "no clock". That is fine when exactly one human is at the table
// (Quick Play, solo-vs-bots) — only that player can stall, and only their own game suffers;
// if their socket dies the heartbeat reaps it and a bot takes the seat over.
// With two or more humans a 0 clock is a griefing tool: one player can freeze the table for
// everyone with no recovery path at all. Those rooms get a floor instead.
const MIN_HUMAN_TURN_TIMEOUT = 30;
const MIN_HUMAN_RESPONSE_TIMEOUT = 15;

function startRoomGame(room, turnTimeout = 60, responseTimeout = 30, ruleOpts) {
  room.phase = 'playing';
  // Room ruleset, chosen in the lobby next to the timers. A preset supplies the base and
  // any individual toggle overrides it; resolution happens HERE, server-side, so a preset
  // is never a client-side illusion. Sticky across rematches (ruleOpts undefined = keep).
  room.rules = ruleOpts === undefined
    ? (room.rules || G.resolveRules({}))
    : G.resolveRules(ruleOpts);
  room.winRule = room.rules.winRule;   // legacy field, kept in sync
  room.turnTimeout = Math.max(0, Math.min(300, Number(turnTimeout) || 0));
  room.responseTimeout = Math.max(0, Math.min(120, Number(responseTimeout) || 0));
  const humans = room.players.filter(p => !p.isBot).length;
  if (humans > 1) {
    if (room.turnTimeout < MIN_HUMAN_TURN_TIMEOUT) room.turnTimeout = MIN_HUMAN_TURN_TIMEOUT;
    if (room.responseTimeout < MIN_HUMAN_RESPONSE_TIMEOUT) room.responseTimeout = MIN_HUMAN_RESPONSE_TIMEOUT;
  }
  room.gameCount = (room.gameCount || 0) + 1;
  const seedBase = seedFromEnv();
  const options = { ...room.rules };
  if (seedBase !== null) options.seed = `${seedBase}#${room.gameCount}`;
  room.state = G.createGame(room.players.map(p => ({ id: p.id, name: p.name })), options);
  if (room.turnTimeout > 0) timers.startTurnTimer(room);
  broadcast.broadcastAndScheduleBot(room);
}

function handleMessage(ws, msg, state) {
  const playerId = state.playerId;
  const roomCode = state.roomCode;

  switch (msg.type) {

    case 'create_room': {
      if (state.playerId) { broadcast.send(ws, { type: 'error', message: 'Already joined to a room' }); break; }
      const code = genCode();
      state.playerId = genId();
      state.roomCode = code;
      const player = { id: state.playerId, resumeToken: genResumeToken(), name: msg.name, ws };
      const room = { code, phase: 'lobby', hostId: state.playerId, players: [player], state: null, chat: [] };
      rooms.set(code, room);
      sendJoined(ws, room, player);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${code} created by ${player.name}`);
      break;
    }

    case 'quick_play': {
      if (state.playerId) { broadcast.send(ws, { type: 'error', message: 'Already joined to a room' }); break; }
      const code = genCode();
      state.playerId = genId();
      state.roomCode = code;
      const player = { id: state.playerId, resumeToken: genResumeToken(), name: msg.name, ws };
      const room = { code, phase: 'lobby', hostId: player.id, players: [player], state: null, chat: [] };
      for (const mode of ['neutral', 'aggressive']) {
        room.players.push({ id: genId(), name: absent.generateBotName(room), ws: null, isBot: true, botMode: mode });
      }
      rooms.set(code, room);
      sendJoined(ws, room, player);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      startRoomGame(room, 0, 30);
      console.log(`[GAME] ${code} quick play started for ${player.name}`);
      break;
    }

    case 'join_room': {
      if (state.playerId) { broadcast.send(ws, { type: 'error', message: 'Already joined to a room' }); break; }
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { broadcast.send(ws, { type: 'error', message: 'Room not found' }); break; }
      if (room.phase !== 'lobby') {
        const dc = room.players.find(x => x.id === msg.playerId && x.resumeToken === msg.resumeToken);
        if (!dc) {
          broadcast.send(ws, { type: 'error', message: 'Game in progress. This browser does not have the private resume key for that seat.' });
          break;
        }
        if (dc.ws?.readyState === 1) { broadcast.send(ws, { type: 'error', message: 'That player is already connected' }); break; }
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
        sendJoined(ws, room, dc);
        broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
        if (room.chat.length) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
        broadcast.broadcastRoom(room);
        console.log(`[ROOM] ${code} ~${dc.name} rejoined game`);
        break;
      }
      if (room.players.length >= 5) { broadcast.send(ws, { type: 'error', message: 'Room is full (max 5)' }); break; }
      if (room.players.some(p => p.name.toLowerCase() === msg.name.toLowerCase())) {
        broadcast.send(ws, { type: 'error', message: 'That call sign is already in use' }); break;
      }
      state.playerId = genId();
      state.roomCode = code;
      const name = msg.name;
      const player = { id: state.playerId, resumeToken: genResumeToken(), name, ws };
      room.players.push(player);
      sendJoined(ws, room, player);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      if (room.chat.length) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${code} +${name} (${room.players.length} players)`);
      break;
    }

    case 'reconnect': {
      if (state.playerId) { broadcast.send(ws, { type: 'error', message: 'Already joined to a room' }); break; }
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { broadcast.send(ws, { type: 'error', message: 'Room not found' }); break; }
      const p = room.players.find(x => x.id === msg.playerId);
      if (!p || p.resumeToken !== msg.resumeToken) { broadcast.send(ws, { type: 'error', message: 'Invalid resume credentials' }); break; }
      if (p.ws?.readyState === 1) { broadcast.send(ws, { type: 'error', message: 'That player is already connected' }); break; }
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
      sendJoined(ws, room, p);
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
          // Without this the re-arming turn timer kept driving the deleted room forever:
          // measured 3 further turns in 4s on a 1s clock, and the state object never freed.
          timers.clearTurnTimer(room);
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
      startRoomGame(room, msg.turnTimeout, msg.responseTimeout, {
        preset: msg.preset,
        winRule: msg.winRule,
        setsToWin: msg.setsToWin,
        pureSetRequired: msg.pureSetRequired,
        passGoRestartsTurn: msg.passGoRestartsTurn,
      });
      console.log(`[GAME] ${roomCode} started with ${room.players.length} players, timeout=${room.turnTimeout}s, responseTimeout=${room.responseTimeout}s, rules=${JSON.stringify(room.rules)}`);
      break;
    }

    case 'rematch': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can start a rematch' }); break; }
      if (room.state?.phase !== 'finished') { broadcast.send(ws, { type: 'error', message: 'Current game is not finished' }); break; }
      timers.clearTurnTimer(room);
      startRoomGame(room, room.turnTimeout, room.responseTimeout);
      console.log(`[GAME] ${roomCode} rematch started`);
      break;
    }

    case 'draw': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      // The draw is automatic at turn start (game.js beginTurn), so this command only ever
      // arrives from an old client or a reconnect race. It is accepted and treated as a
      // silent no-op — never an error, never a second draw. Turn/phase/pending guards live
      // inside G.drawCards so no caller can orphan a pendingAction by forcing 'play'.
      const drawRes = G.drawCards(room.state, playerId);
      if (drawRes.alreadyDrawn) break;
      if (drawRes.error) { broadcast.send(ws, { type: 'error', message: drawRes.error }); break; }
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
      // The missing `break` here fell through to startResponseTimer below: any bystander
      // spamming `respond` pushed the only deadline protecting a stalled table back
      // indefinitely (measured +14.3s over 70 messages) and fanned a 22.3KB state to every
      // seat per junk message (~0.87MB/s from one socket, inside the rate limit).
      if (res.error) {
        broadcast.send(ws, { type: 'error', message: res.error });
        if (res.needPayment) broadcast.send(ws, { type: 'need_payment', amount: res.amount });
        break;
      }
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
      const now = Date.now();
      if (state.lastChatAt && now - state.lastChatAt < 500) {
        broadcast.send(ws, { type: 'error', message: 'Please slow down' });
        break;
      }
      state.lastChatAt = now;
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

function handleClose(state, ws) {
  const { playerId, roomCode } = state;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  const p = room.players.find(x => x.id === playerId);
  // A stale socket's late close event used to null out the seat's CURRENT socket and hand
  // the seat to a bot, undoing a reconnect that had already succeeded. Only the socket that
  // still owns the seat may tear it down.
  if (p && ws !== undefined && p.ws !== ws) return;
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
      timers.clearTurnTimer(r);          // otherwise the deleted room keeps playing forever
      rooms.delete(closedRoomCode);
      console.log(`[ROOM] ${closedRoomCode} deleted (empty)`);
    } else if (r) {
      broadcast.broadcastRoom(r);
    }
  }, 30000);
  broadcast.broadcastAndScheduleBot(room);
}

module.exports = { init, handleMessage, handleClose, seedFromEnv };
