// server.js — Express + WebSocket multiplayer server for Chudopoly GO
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const G = require('./game');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const rooms = new Map();   // code → room
const globalChat = [];     // last 50 global chat messages
const CHAT_MAX = 50;
let chatId = 0;

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function genId() { return Math.random().toString(36).slice(2,10); }

function broadcastRoom(room) {
  const timerInfo = room.turnTimeout > 0 && room.turnStartedAt
    ? { timeout: room.turnTimeout, startedAt: room.turnStartedAt }
    : null;
  room.players.forEach(p => {
    if (p.ws?.readyState === 1) {
      const view = room.state ? G.getPlayerView(room.state, p.id) : null;
      p.ws.send(JSON.stringify({
        type: 'state', code: room.code,
        phase: room.phase,
        players: room.players.map(x => ({ id:x.id, name:x.name, connected:x.ws?.readyState===1 })),
        hostId: room.hostId,
        game: view,
        turnTimer: timerInfo,
      }));
    }
  });
}

function send(ws, msg) { if (ws?.readyState===1) ws.send(JSON.stringify(msg)); }

function transferHost(room) {
  const connected = room.players.filter(x => x.ws?.readyState === 1 && x.id !== room.hostId);
  if (connected.length === 0) return;
  const newHost = connected[Math.floor(Math.random() * connected.length)];
  room.hostId = newHost.id;
  console.log(`[ROOM] ${room.code} host transferred to ${newHost.name}`);
}

function isConnected(room, pid) {
  const p = room.players.find(x => x.id === pid);
  return p?.ws?.readyState === 1;
}

function handleAbsent(room) {
  if (!room?.state || room.state.phase !== 'playing') return;
  const MAX_ITER = 30;
  for (let i = 0; i < MAX_ITER; i++) {
    if (room.state.phase !== 'playing') return;

    // If only 1 connected non-eliminated player remains, they win
    const active = room.players.filter(x => !room.state.players?.find(sp => sp.id === x.id)?.eliminated);
    const connected = active.filter(x => x.ws?.readyState === 1);
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

    return; // current player is present
  }
}

/* ── Turn timer ─────────────────────────────────────────────────────── */

function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.turnTimeout || room.turnTimeout <= 0) return;
  if (!room.state || room.state.phase !== 'playing') return;
  room.turnStartedAt = Date.now();
  room.turnTimerId = setTimeout(() => {
    if (!room.state || room.state.phase !== 'playing') return;
    const cp = G.currentPlayer(room.state);
    // Skip if there's a pending action (waiting for responses, not the player's fault)
    if (room.state.pendingAction) {
      // Restart timer — don't penalize for waiting on others
      startTurnTimer(room);
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
    broadcastRoom(room);
  }, room.turnTimeout * 1000);
}

function clearTurnTimer(room) {
  if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; }
  room.turnStartedAt = null;
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
            (!x.ws || x.ws.readyState !== 1) &&
            x.name.toLowerCase() === rjName.toLowerCase()
          );
          if (!dc) {
            send(ws, { type:'error', message:'Game in progress. To rejoin, enter the EXACT call sign you used when you joined (case doesn\'t matter).' });
            break;
          }
          dc.ws = ws;
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
        send(target.ws, { type:'kicked' });
        if (target.ws) { try { target.ws.close(); } catch {} }
        room.players = room.players.filter(x => x.id !== msg.targetId);
        broadcastRoom(room);
        console.log(`[ROOM] ${roomCode} host kicked ${target.name}`);
        break;
      }

      case 'leave_room': {
        const room = rooms.get(roomCode);
        if (!room) break;
        const lp = room.players.find(x => x.id === playerId);
        if (!lp) break;
        const wasHost = room.hostId === playerId;

        if (room.phase === 'playing') {
          // During game: keep player slot but disconnect (allows rejoin by name)
          lp.ws = null;
          console.log(`[ROOM] ${roomCode} -${lp.name} left game (can rejoin)`);
          if (wasHost) transferHost(room);
          handleAbsent(room);
          broadcastRoom(room);
        } else {
          // Lobby: remove completely
          room.players = room.players.filter(x => x.id !== playerId);
          console.log(`[ROOM] ${roomCode} -${lp.name} left`);
          if (room.players.length === 0) {
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
        room.state = G.createGame(room.players.map(p => ({ id:p.id, name:p.name })));
        if (room.turnTimeout > 0) startTurnTimer(room);
        broadcastRoom(room);
        console.log(`[GAME] ${roomCode} started with ${room.players.length} players, timeout=${room.turnTimeout}s`);
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
        broadcastRoom(room);
        break;
      }

      case 'play_money': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.playAsMoney(room.state, playerId, msg.cardIndex);
        if (res.error) { send(ws, { type:'error', message:res.error }); break; }
        broadcastRoom(room);
        break;
      }

      case 'play_property': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.playProperty(room.state, playerId, msg.cardIndex, msg.targetColor);
        if (res.error) { send(ws, { type:'error', message:res.error }); break; }
        broadcastRoom(room);
        break;
      }

      case 'move_property': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.moveProperty(room.state, playerId, msg.cardId, msg.toColor);
        if (res.error) { send(ws, { type:'error', message:res.error }); break; }
        broadcastRoom(room);
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
        broadcastRoom(room);
        break;
      }

      case 'respond': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.respondToAction(room.state, playerId, msg.response, msg.paymentCards);
        if (res.error) { send(ws, { type:'error', message:res.error }); }
        if (res.needPayment) { send(ws, { type:'need_payment', amount:res.amount }); break; }
        broadcastRoom(room);
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
        broadcastRoom(room);
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
        broadcastRoom(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.find(x => x.id === playerId);
    if (p) p.ws = null;
    console.log(`[ROOM] ${roomCode} -${p?.name||'?'} disconnected`);
    // Transfer host if the disconnecting player was host
    if (playerId === room.hostId) transferHost(room);
    // Skip absent players' turns so game doesn't freeze
    handleAbsent(room);
    // Clean up empty rooms after a delay (give time to reconnect)
    const closedRoomCode = roomCode;
    setTimeout(() => {
      const r = rooms.get(closedRoomCode);
      if (r && r.players.every(x => !x.ws || x.ws.readyState !== 1)) {
        rooms.delete(closedRoomCode);
        console.log(`[ROOM] ${closedRoomCode} deleted (empty)`);
      } else if (r) {
        broadcastRoom(r);
      }
    }, 30000);
    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`\n  CHUDOPOLY GO — Air Force Card Game`);
  console.log(`  Server running on http://localhost:${PORT}\n`);
});
