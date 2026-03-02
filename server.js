// server.js — Chudopoly GO entry point

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const G = require('./game');
const Bot = require('./bot');
const broadcast = require('./server/broadcast');
const timers = require('./server/timers');
const absent = require('./server/absent');
const handlers = require('./server/handlers');

/* ── App setup ─────────────────────────────────────────────────────── */

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const globalChat = [];
const CHAT_MAX = 50;
const chatIdRef = { value: 0 };

/* ── Utilities ─────────────────────────────────────────────────────── */

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function genId() { return Math.random().toString(36).slice(2, 10); }

/* ── Initialize modules ────────────────────────────────────────────── */

broadcast.init({ G, Bot });
timers.init({ G, Bot, broadcast });
absent.init({ G, broadcast });
handlers.init({ G, Bot, broadcast, timers, absent, rooms, globalChat, CHAT_MAX, chatIdRef, genCode, genId, wss });

/* ── API routes ────────────────────────────────────────────────────── */

app.get('/api/config', (req, res) => {
  res.json({ giphyKey: process.env.GIPHY_KEY || '' });
});

/* ── WebSocket ─────────────────────────────────────────────────────── */

wss.on('connection', (ws) => {
  const state = { playerId: null, roomCode: null };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handlers.handleMessage(ws, msg, state);
  });

  ws.on('close', () => {
    handlers.handleClose(state);
  });
});

/* ── Start ─────────────────────────────────────────────────────────── */

server.listen(PORT, () => {
  console.log(`\n  CHUDOPOLY GO — Air Force Card Game`);
  console.log(`  Server running on http://localhost:${PORT}\n`);
});
