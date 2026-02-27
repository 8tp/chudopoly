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

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function genId() { return Math.random().toString(36).slice(2,10); }

function broadcastRoom(room) {
  room.players.forEach(p => {
    if (p.ws?.readyState === 1) {
      const view = room.state ? G.getPlayerView(room.state, p.id) : null;
      p.ws.send(JSON.stringify({
        type: 'state', code: room.code,
        phase: room.phase,
        players: room.players.map(x => ({ id:x.id, name:x.name, connected:x.ws?.readyState===1 })),
        hostId: room.hostId,
        game: view,
      }));
    }
  });
}

function send(ws, msg) { if (ws?.readyState===1) ws.send(JSON.stringify(msg)); }

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
        const room = { code, phase:'lobby', hostId:playerId, players:[player], state:null };
        rooms.set(code, room);
        send(ws, { type:'joined', code, playerId, name:player.name });
        broadcastRoom(room);
        console.log(`[ROOM] ${code} created by ${player.name}`);
        break;
      }

      case 'join_room': {
        const code = (msg.code||'').toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type:'error', message:'Room not found' }); break; }
        if (room.phase !== 'lobby') { send(ws, { type:'error', message:'Game already in progress' }); break; }
        if (room.players.length >= 5) { send(ws, { type:'error', message:'Room is full (max 5)' }); break; }
        playerId = genId();
        roomCode = code;
        const name = msg.name || ('Player ' + (room.players.length+1));
        const player = { id:playerId, name, ws };
        room.players.push(player);
        send(ws, { type:'joined', code, playerId, name });
        broadcastRoom(room);
        console.log(`[ROOM] ${code} +${name} (${room.players.length} players)`);
        break;
      }

      case 'start_game': {
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== playerId) { send(ws, { type:'error', message:'Only host can start' }); break; }
        if (room.players.length < 2) { send(ws, { type:'error', message:'Need at least 2 players' }); break; }
        room.phase = 'playing';
        room.state = G.createGame(room.players.map(p => ({ id:p.id, name:p.name })));
        broadcastRoom(room);
        console.log(`[GAME] ${roomCode} started with ${room.players.length} players`);
        break;
      }

      case 'draw': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const cp = G.currentPlayer(room.state);
        if (cp.id !== playerId) { send(ws, { type:'error', message:'Not your turn' }); break; }
        if (room.state.turnPhase !== 'draw') { send(ws, { type:'error', message:'Not draw phase' }); break; }
        G.drawCards(room.state);
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

      case 'end_turn': {
        const room = rooms.get(roomCode);
        if (!room?.state) break;
        const res = G.endTurn(room.state, playerId, msg.discardIds);
        if (res.error) {
          send(ws, { type:'error', message:res.error, needDiscard:res.needDiscard, excess:res.excess });
          break;
        }
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
    // Clean up empty rooms
    if (room.players.every(x => !x.ws || x.ws.readyState !== 1)) {
      rooms.delete(roomCode);
      console.log(`[ROOM] ${roomCode} deleted (empty)`);
    } else {
      broadcastRoom(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  CHUDOPOLY GO — Air Force Card Game`);
  console.log(`  Server running on http://localhost:${PORT}\n`);
});
