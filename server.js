// server.js — Express + WebSocket multiplayer server for Chudopoly GO
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const G = require('./game');
const Bot = require('./bot');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const rooms = new Map();   // code → room
const globalChat = [];     // last 50 global chat messages
const CHAT_MAX = 50;
let chatId = 0;

/* ── Bot callsign pool ──────────────────────────────────────────────── */

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

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function genId() { return Math.random().toString(36).slice(2,10); }

/* ── Bot callbacks ──────────────────────────────────────────────────── */

const botCallbacks = {
  broadcast: broadcastRoom,
  startTimer: startTurnTimer,
  clearTimer: clearTurnTimer,
};

function broadcastAndScheduleBot(room) {
  broadcastRoom(room);
  Bot.scheduleBotAction(room, botCallbacks);
}

/* ── Broadcasting ───────────────────────────────────────────────────── */

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

function send(ws, msg) { if (ws?.readyState===1) ws.send(JSON.stringify(msg)); }

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

function handleAbsent(room) {
  if (!room?.state || room.state.phase !== 'playing') return;
  const MAX_ITER = 30;
  for (let i = 0; i < MAX_ITER; i++) {
    if (room.state.phase !== 'playing') return;

    // If only 1 connected non-eliminated player remains, they win
    const active = room.players.filter(x => !room.state.players?.find(sp => sp.id === x.id)?.eliminated);
    const connected = active.filter(x => x.isBot || x.ws?.readyState === 1);
    // But don't count "only bots" as game-over — need at least 1 human or let bots play
    const humanConnected = active.filter(x => !x.isBot && x.ws?.readyState === 1);
    if (humanConnected.length === 0 && connected.length > 1) {
      // Only bots left — let them play on (room cleanup timeout will handle it)
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

    // Handle pending action with absent responder — auto-accept
    if (room.state.pendingAction) {
      const pa = room.state.pendingAction;

      // Simultaneous payment_all: auto-resolve any absent players in pending
      if (pa.type === 'payment_all') {
        let resolved = false;
        // Auto-resolve absent pending payers
        for (const pid of [...(pa.pending || [])]) {
          if (!isConnected(room, pid)) {
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
        // Auto-resolve absent opsec chain responders
        for (const [pid, chain] of Object.entries(pa.opsecChains || {})) {
          if (!isConnected(room, chain.responderId)) {
            G.respondToAction(room.state, chain.responderId, 'accept');
            const gp = G.getPlayer(room.state, chain.responderId);
            room.state.log.push((gp?.name || '?') + ' is absent — auto-resolved');
            resolved = true;
          }
        }
        if (resolved) continue;
        // Check if anyone is still pending
        if ((pa.pending?.length > 0) || Object.keys(pa.opsecChains || {}).length > 0) return;
        continue; // pendingAction was cleared
      }

      // Single-responder actions
      if (pa.responderId && !isConnected(room, pa.responderId)) {
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
      return; // responder(s) are present, wait for them
    }

    // Handle current player being absent or eliminated — skip their turn
    const cp = G.currentPlayer(room.state);
    if (cp.eliminated || !isConnected(room, cp.id)) {
      if (!cp.eliminated) room.state.log.push(cp.name + ' is absent — turn skipped');
      // Skip draw, just end turn (endTurn doesn't require draw phase)
      room.state.turnPhase = 'play';
      const excess = cp.hand.length > 7 ? cp.hand.slice(-(cp.hand.length - 7)).map(c => c.id) : undefined;
      const res = G.endTurn(room.state, cp.id, excess);
      if (res.error) {
        // Force advance if endTurn fails
        room.state.currentPlayerIndex = (room.state.currentPlayerIndex + 1) % room.state.players.length;
        room.state.turnPhase = 'draw';
        room.state.playsRemaining = 3;
      }
      continue;
    }

    return; // current player is present (or is a bot — bot scheduler will handle)
  }
}

/* ── Turn timer ─────────────────────────────────────────────────────── */

function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.turnTimeout || room.turnTimeout <= 0) return;
  if (!room.state || room.state.phase !== 'playing') return;
  // Don't start turn timer if there's a pending action — response timer handles that
  if (room.state.pendingAction) {
    startResponseTimer(room);
    return;
  }
  room.turnStartedAt = Date.now();
  room.turnTimerId = setTimeout(() => {
    if (!room.state || room.state.phase !== 'playing') return;
    const cp = G.currentPlayer(room.state);
    // If a pending action appeared while timer was running, switch to response timer
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
    broadcastAndScheduleBot(room);
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

  // Find who needs to respond
  let responderId = pa.responderId;
  if (pa.type === 'payment_all' && pa.pending?.length > 0) {
    responderId = pa.pending[0];
  }
  // Check opsec chains
  if (pa.opsecChains) {
    for (const [pid, chain] of Object.entries(pa.opsecChains)) {
      if (chain.responderId) { responderId = chain.responderId; break; }
    }
  }
  if (!responderId) return;

  const responder = G.getPlayer(room.state, responderId);
  if (!responder) return;

  room.state.log.push(responder.name + '\'s response timed out — auto-accepting');

  // Auto-accept: for payments, pick cards automatically (smallest value first from bank, then properties)
  const res = G.respondToAction(room.state, responderId, 'accept', autoPickPayment(responder, pa.amount || 0));
  if (res.needPayment) {
    // Try again with auto-picked cards
    const cards = autoPickPayment(responder, res.amount || pa.amount || 0);
    G.respondToAction(room.state, responderId, 'accept', cards);
  }

  // If pending action is resolved, restart turn timer; otherwise restart response timer
  if (room.state.pendingAction) {
    startResponseTimer(room);
  } else {
    startTurnTimer(room);
  }
  broadcastAndScheduleBot(room);
}

function autoPickPayment(player, amount) {
  if (!amount || amount <= 0) return [];
  const cards = [];
  let total = 0;

  // Pick from bank first, smallest to largest
  const bankSorted = [...(player.bank || [])].sort((a, b) => a.value - b.value);
  for (const c of bankSorted) {
    if (total >= amount) break;
    cards.push(c.id);
    total += c.value;
  }

  // If still short, pick from properties (least valuable first)
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

// Expose GIPHY_KEY to client
app.get('/api/config', (req, res) => {
  res.json({ giphyKey: process.env.GIPHY_KEY || '' });
});

wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_room': {
        const code = genCode();
        playerId = genId();
        roomCode = code;
        const player = { id:playerId, name:msg.name||'Player 1', ws };
        const room = { code, phase:'lobby', hostId:playerId, players:[player], state:null, chat:[] };
        rooms.set(code, room);
        send(ws, { type:'joined', code, playerId, name:player.name });
        send(ws, { type:'chat_history', scope:'global', msgs:globalChat.slice(-CHAT_MAX) });
        broadcastRoom(room);
        console.log(`[ROOM] ${code} created by ${player.name}`);
        break;
      }

      case 'join_room': {
        const code = (msg.code||'').toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type:'error', message:'Room not found' }); break; }
        if (room.phase !== 'lobby') {
          // Game in progress — try to rejoin a disconnected player by name
          const rjName = (msg.name || '').trim();
          const dc = room.players.find(x =>
            (!x.isBot || x._wasHuman) &&
            (!x.ws || x.ws.readyState !== 1) &&
            x.name.toLowerCase() === rjName.toLowerCase()
          );
          if (!dc) {
            send(ws, { type:'error', message:'Game in progress. To rejoin, enter the EXACT call sign you used when you joined (case doesn\'t matter).' });
            break;
          }
          dc.ws = ws;
          // Reclaim from bot if taken over
          if (dc.isBot && dc._wasHuman) {
            dc.isBot = false;
            delete dc._wasHuman;
            delete dc.botMode;
            Bot.cancelBotTimeout(room);
            console.log(`[BOT] ${code} ${dc.name} reclaimed from bot (rejoin)`);
          }
          playerId = dc.id;
          roomCode = code;
          send(ws, { type:'joined', code, playerId, name:dc.name });
          send(ws, { type:'chat_history', scope:'global', msgs:globalChat.slice(-CHAT_MAX) });
          if (room.chat.length) send(ws, { type:'chat_history', scope:'room', msgs:room.chat.slice(-CHAT_MAX) });
          broadcastRoom(room);
          console.log(`[ROOM] ${code} ~${dc.name} rejoined game`);
          break;
        }
        if (room.players.length >= 5) { send(ws, { type:'error', message:'Room is full (max 5)' }); break; }
        playerId = genId();
        roomCode = code;
        const name = msg.name || ('Player ' + (room.players.length+1));
        const player = { id:playerId, name, ws };
        room.players.push(player);
        send(ws, { type:'joined', code, playerId, name });
        send(ws, { type:'chat_history', scope:'global', msgs:globalChat.slice(-CHAT_MAX) });
        if (room.chat.length) send(ws, { type:'chat_history', scope:'room', msgs:room.chat.slice(-CHAT_MAX) });
        broadcastRoom(room);
        console.log(`[ROOM] ${code} +${name} (${room.players.length} players)`);
        break;
      }

      case 'reconnect': {
        const code = (msg.code||'').toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type:'error', message:'Room not found' }); break; }
        const p = room.players.find(x => x.id === msg.playerId);
        if (!p) { send(ws, { type:'error', message:'Player not found in room' }); break; }
        p.ws = ws;
        // Reclaim from bot if taken over
        if (p.isBot && p._wasHuman) {
          p.isBot = false;
          delete p._wasHuman;
          delete p.botMode;
          Bot.cancelBotTimeout(room);
          console.log(`[BOT] ${code} ${p.name} reclaimed from bot (reconnect)`);
        }
        playerId = msg.playerId;
        roomCode = code;
        send(ws, { type:'joined', code, playerId, name:p.name });
        send(ws, { type:'chat_history', scope:'global', msgs:globalChat.slice(-CHAT_MAX) });
        if (room.chat.length) send(ws, { type:'chat_history', scope:'room', msgs:room.chat.slice(-CHAT_MAX) });
        broadcastRoom(room);
        console.log(`[ROOM] ${code} ~${p.name} reconnected`);
        break;
      }

      case 'kick': {
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== playerId) { send(ws, { type:'error', message:'Only host can kick' }); break; }
        if (room.phase !== 'lobby') { send(ws, { type:'error', message:'Cannot kick during a game' }); break; }
        const target = room.players.find(x => x.id === msg.targetId);
        if (!target) break;
        if (target.id === playerId) { send(ws, { type:'error', message:'Cannot kick yourself' }); break; }
        // Notify the kicked player before removing
        if (target.ws) { send(target.ws, { type:'kicked' }); try { target.ws.close(); } catch {} }
        room.players = room.players.filter(x => x.id !== msg.targetId);
        broadcastRoom(room);
        console.log(`[ROOM] ${roomCode} host kicked ${target.name}`);
        break;
      }

      case 'add_bot': {
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== playerId) { send(ws, { type:'error', message:'Only host can add bots' }); break; }
        if (room.phase !== 'lobby') { send(ws, { type:'error', message:'Cannot add bots during a game' }); break; }
        if (room.players.length >= 5) { send(ws, { type:'error', message:'Room is full (max 5)' }); break; }
        const mode = ['random','conservative','neutral','aggressive','chud'].includes(msg.mode) ? msg.mode : 'neutral';
        const botId = genId();
        const botName = generateBotName(room);
        const bot = { id: botId, name: botName, ws: null, isBot: true, botMode: mode };
        room.players.push(bot);
        broadcastRoom(room);
        console.log(`[ROOM] ${roomCode} +BOT ${botName} [${mode}] (${room.players.length} players)`);
        break;
      }

      case 'remove_bot': {
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== playerId) { send(ws, { type:'error', message:'Only host can remove bots' }); break; }
        if (room.phase !== 'lobby') { send(ws, { type:'error', message:'Cannot remove bots during a game' }); break; }
        const target = room.players.find(x => x.id === msg.targetId && x.isBot);
        if (!target) break;
        room.players = room.players.filter(x => x.id !== msg.targetId);
        broadcastRoom(room);
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
          // During game: bot takes over
          lp.ws = null;
          lp.isBot = true;
          lp._wasHuman = true;
          lp.botMode = ['conservative','neutral','aggressive'][Math.floor(Math.random()*3)];
          console.log(`[BOT] ${roomCode} bot took over for ${lp.name} [${lp.botMode}]`);
          if (wasHost) transferHost(room);
          handleAbsent(room);
          broadcastAndScheduleBot(room);
        } else {
          // Lobby: remove completely
          room.players = room.players.filter(x => x.id !== playerId);
          console.log(`[ROOM] ${roomCode} -${lp.name} left`);
          if (room.players.length === 0 || room.players.every(x => x.isBot)) {
            rooms.delete(roomCode);
            console.log(`[ROOM] ${roomCode} deleted (empty)`);
          } else {
            if (wasHost) transferHost(room);
            broadcastRoom(room);
          }
        }
        playerId = null;
        roomCode = null;
        break;
      }

      case 'start_game': {
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== playerId) { send(ws, { type:'error', message:'Only host can start' }); break; }
        if (room.players.length < 2) { send(ws, { type:'error', message:'Need at least 2 players' }); break; }
        room.phase = 'playing';
        room.turnTimeout = Math.max(0, Math.min(300, parseInt(msg.turnTimeout) || 0));
        room.responseTimeout = Math.max(0, Math.min(120, parseInt(msg.responseTimeout) || 0));
        room.state = G.createGame(room.players.map(p => ({ id:p.id, name:p.name })));
        if (room.turnTimeout > 0) startTurnTimer(room);
        broadcastAndScheduleBot(room);
        console.log(`[GAME] ${roomCode} started with ${room.players.length} players, timeout=${room.turnTimeout}s, responseTimeout=${room.responseTimeout}s`);
        break;
      }

      case 'draw': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const cp = G.currentPlayer(room.state);
        if (cp.id !== playerId) { send(ws, { type:'error', message:'Not your turn' }); break; }
        if (room.state.turnPhase !== 'draw') { send(ws, { type:'error', message:'Not draw phase' }); break; }
        const drawRes = G.drawCards(room.state);
        if (drawRes.autoWin) clearTurnTimer(room);
        broadcastAndScheduleBot(room);
        break;
      }

      case 'play_money': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.playAsMoney(room.state, playerId, msg.cardIndex);
        if (res.error) { send(ws, { type:'error', message:res.error }); break; }
        broadcastAndScheduleBot(room);
        break;
      }

      case 'play_property': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.playProperty(room.state, playerId, msg.cardIndex, msg.targetColor);
        if (res.error) { send(ws, { type:'error', message:res.error }); break; }
        broadcastAndScheduleBot(room);
        break;
      }

      case 'move_property': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.moveProperty(room.state, playerId, msg.cardId, msg.toColor);
        if (res.error) { send(ws, { type:'error', message:res.error }); break; }
        broadcastAndScheduleBot(room);
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
        if (res.error) { send(ws, { type:'error', message:res.error }); break; }
        // If a pending action was created, pause turn timer and start response timer
        if (room.state.pendingAction) {
          if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; }
          room.turnStartedAt = null;
          startResponseTimer(room);
        }
        broadcastAndScheduleBot(room);
        break;
      }

      case 'respond': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.respondToAction(room.state, playerId, msg.response, msg.paymentCards);
        if (res.error) { send(ws, { type:'error', message:res.error }); }
        if (res.needPayment) { send(ws, { type:'need_payment', amount:res.amount }); break; }
        // If pending action resolved, clear response timer and restart turn timer
        if (!room.state.pendingAction) {
          clearResponseTimer(room);
          startTurnTimer(room);
        } else {
          // Still pending (e.g. OPSEC chain or payment_all with more responders) — restart response timer
          startResponseTimer(room);
        }
        broadcastAndScheduleBot(room);
        break;
      }

      case 'emote': {
        const room = rooms.get(roomCode);
        if (!room) break;
        const emotePlayer = room.players.find(x => x.id === playerId);
        if (!emotePlayer) break;
        const text = (msg.text||'').slice(0, 30);
        room.players.forEach(p => {
          if (p.ws?.readyState === 1) {
            p.ws.send(JSON.stringify({ type:'emote', playerId, name:emotePlayer.name, text }));
          }
        });
        break;
      }

      case 'chat': {
        if (!playerId) break;
        const text = (msg.text||'').slice(0, 500);
        if (!text) break;
        const scope = msg.scope === 'global' ? 'global' : 'room';
        const room = rooms.get(roomCode);
        const cp = room?.players.find(x => x.id === playerId);
        const name = cp?.name || 'Anon';
        const entry = { id:++chatId, ts:Date.now(), pid:playerId, name, text, scope };
        if (scope === 'global') {
          globalChat.push(entry);
          if (globalChat.length > CHAT_MAX) globalChat.shift();
          wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type:'chat', msg:entry })); });
        } else {
          if (!room) break;
          room.chat.push(entry);
          if (room.chat.length > CHAT_MAX) room.chat.shift();
          room.players.forEach(rp => {
            if (rp.ws?.readyState === 1) rp.ws.send(JSON.stringify({ type:'chat', msg:entry }));
          });
        }
        break;
      }

      case 'chat_history': {
        const room = rooms.get(roomCode);
        send(ws, { type:'chat_history', scope:'global', msgs:globalChat.slice(-CHAT_MAX) });
        if (room) send(ws, { type:'chat_history', scope:'room', msgs:room.chat.slice(-CHAT_MAX) });
        break;
      }

      case 'scoop': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.scoop(room.state, playerId);
        if (res.error) { send(ws, { type:'error', message:res.error }); break; }
        if (room.state.phase === 'finished') clearTurnTimer(room);
        else startTurnTimer(room);
        broadcastAndScheduleBot(room);
        break;
      }

      case 'end_turn': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.endTurn(room.state, playerId, msg.discardIds);
        if (res.error) {
          send(ws, { type:'error', message:res.error, needDiscard:res.needDiscard, excess:res.excess });
          break;
        }
        startTurnTimer(room);
        broadcastAndScheduleBot(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.find(x => x.id === playerId);
    if (p) {
      p.ws = null;
      // Bot takes over during game
      if (room.phase === 'playing' && !p.isBot) {
        p.isBot = true;
        p._wasHuman = true;
        p.botMode = ['conservative','neutral','aggressive'][Math.floor(Math.random()*3)];
        console.log(`[BOT] ${roomCode} bot took over for ${p.name} [${p.botMode}]`);
      }
    }
    console.log(`[ROOM] ${roomCode} -${p?.name||'?'} disconnected`);
    // Transfer host if the disconnecting player was host
    if (playerId === room.hostId) transferHost(room);
    // Handle absent players and schedule bots
    handleAbsent(room);
    // Clean up empty rooms after a delay (give time to reconnect)
    const closedRoomCode = roomCode;
    setTimeout(() => {
      const r = rooms.get(closedRoomCode);
      if (r && r.players.every(x => x.isBot || !x.ws || x.ws.readyState !== 1)) {
        rooms.delete(closedRoomCode);
        console.log(`[ROOM] ${closedRoomCode} deleted (empty)`);
      } else if (r) {
        broadcastRoom(r);
      }
    }, 30000);
    broadcastAndScheduleBot(room);
  });
});

server.listen(PORT, () => {
  console.log(`\n  CHUDOPOLY GO — Air Force Card Game`);
  console.log(`  Server running on http://localhost:${PORT}\n`);
});
