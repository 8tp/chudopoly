// server.js — Chudopoly GO entry point

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const G = require('./game');
const Bot = require('./bot');
const broadcast = require('./server/broadcast');
const timers = require('./server/timers');
const absent = require('./server/absent');
const handlers = require('./server/handlers');
const protocol = require('./server/protocol');

/* ── App setup ─────────────────────────────────────────────────────── */

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const configuredOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }) => {
    if (!origin) return process.env.NODE_ENV !== 'production';
    if (configuredOrigins.has(origin)) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  },
});

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' ws: wss: https://api.giphy.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
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
  do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function genId() { return crypto.randomUUID(); }
function genResumeToken() { return crypto.randomBytes(32).toString('base64url'); }

/* ── Initialize modules ────────────────────────────────────────────── */

broadcast.init({ G, Bot });
timers.init({ G, Bot, broadcast });
absent.init({ G, broadcast });
handlers.init({ G, Bot, broadcast, timers, absent, rooms, globalChat, CHAT_MAX, chatIdRef, genCode, genId, genResumeToken, wss });

/* ── API routes ────────────────────────────────────────────────────── */

app.get('/api/config', (req, res) => {
  res.json({ giphyKey: process.env.GIPHY_KEY || '' });
});
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ── WebSocket ─────────────────────────────────────────────────────── */

wss.on('connection', (ws) => {
  const state = { playerId: null, roomCode: null };
  let windowStartedAt = Date.now();
  let messageCount = 0;

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStartedAt >= 5000) { windowStartedAt = now; messageCount = 0; }
    messageCount++;
    if (messageCount > 40) { ws.close(1008, 'Rate limit exceeded'); return; }
    let msg;
    try { msg = JSON.parse(raw); }
    catch { broadcast.send(ws, { type: 'error', message: 'Message must be valid JSON' }); return; }
    const validation = protocol.validateMessage(msg);
    if (!validation.ok) { broadcast.send(ws, { type: 'error', message: validation.error }); return; }
    try {
      handlers.handleMessage(ws, validation.value, state);
    } catch (error) {
      console.error('[WS] Message handling failed:', error);
      broadcast.send(ws, { type: 'error', message: 'Unable to process that request' });
    }
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
