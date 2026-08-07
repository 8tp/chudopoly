// server.js — Chudopoly entry point

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');            // hardLog() only — see "Death forensics" below

const pkg = require('./package.json');
const G = require('./game');
const Bot = require('./bot');
const broadcast = require('./server/broadcast');
const timers = require('./server/timers');
const absent = require('./server/absent');
const handlers = require('./server/handlers');
const protocol = require('./server/protocol');
const icon = require('./server/icon');

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
/* ── App icon ──────────────────────────────────────────────────────────
   Served, not stored. §0.3 bans .svg and .png files in the repo, so the tab
   favicon and every install raster are generated from one shape list in
   server/icon.js — SVG as text, PNG through node:zlib. Registered ABOVE the
   static mount so these paths never touch the filesystem. Cache-Control
   matches the rest of the tree (revalidate; the ?v= in index.html is what
   actually busts), and express adds the ETag off the buffer. */
app.get('/icon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(icon.tabSVG());
});
app.get('/icon-:key.png', (req, res, next) => {
  const png = icon.pngFor(req.params.key);
  if (!png) return next();
  res.type('image/png').set('Cache-Control', 'no-cache').send(png);
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // HTML must always revalidate so its cache-busted asset URLs stay in sync.
    res.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-store' : 'no-cache');
  },
}));

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
const STARTED_AT = Date.now();
app.get('/health', (req, res) => res.json({
  ok: true,
  rooms: rooms.size,
  version: pkg.version,
  // A deploy could not tell which build was live from {ok, rooms} alone.
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null,
  node: process.version,
  uptime: Math.round(process.uptime()),
  startedAt: STARTED_AT,
  sockets: wss.clients.size,
}));

/* ── WebSocket ─────────────────────────────────────────────────────── */

/* Liveness. Without this a half-open socket (phone loses signal, no FIN) keeps
   readyState === 1 until the OS TCP keepalive gives up (~2h on Linux): no close event, so
   no bot takeover, absent.js never engages, and reconnect is refused forever with
   "That player is already connected". Measured: 3/3 reconnect attempts refused.
   PING_INTERVAL 15s → a dead socket is reaped within 30s. */
const PING_INTERVAL = Math.max(50, Number(process.env.CHUD_PING_MS) || 15000);
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { try { ws.terminate(); } catch {} }
  }
}, PING_INTERVAL);
heartbeat.unref?.();
wss.on('close', () => clearInterval(heartbeat));

// A WebSocket with no 'error' listener re-throws as an uncaught exception and takes the
// whole process down. Four unauthenticated single-frame vectors did exactly that
// (>16KB payload, invalid UTF-8, RSV1 set, opcode 0x3) — the Origin check is no
// mitigation because a non-browser client sets Origin freely.
wss.on('error', (err) => console.error('[WSS] server error:', err?.message || err));

/* Connection caps. There were none: 400 sockets from one client opened in 0.1s
   (sockets:401), and every one of them is an independent budget for the frame rate limit,
   an independent chat_history amplifier, and a fan-out target for global chat. The per-IP
   cap is the one that matters — the global cap is a backstop for a distributed flood so the
   process runs out of sockets on its own terms rather than the OS's. */
const MAX_SOCKETS_PER_IP = Math.max(1, Number(process.env.CHUD_MAX_SOCKETS_PER_IP) || 100);
const MAX_SOCKETS_TOTAL = Math.max(1, Number(process.env.CHUD_MAX_SOCKETS) || 2000);
const socketsByIp = new Map();

// Behind Railway/any reverse proxy every socket shares the proxy's remoteAddress, which
// would make a per-IP cap either useless or a global outage. The forwarded chain is
// trusted only for its first hop, exactly as the platform sets it.
function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req?.socket?.remoteAddress || 'unknown';
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const liveForIp = (socketsByIp.get(ip) || 0) + 1;
  socketsByIp.set(ip, liveForIp);
  // Registered BEFORE the cap check so a refused socket still gives its slot back.
  ws.on('close', () => {
    const remaining = (socketsByIp.get(ip) || 1) - 1;
    if (remaining > 0) socketsByIp.set(ip, remaining); else socketsByIp.delete(ip);
  });
  if (liveForIp > MAX_SOCKETS_PER_IP || wss.clients.size > MAX_SOCKETS_TOTAL) {
    console.warn(`[WS] connection refused (${ip}: ${liveForIp} sockets, ${wss.clients.size} total)`);
    ws.on('error', () => {});
    try { ws.close(1013, 'Too many connections'); } catch { try { ws.terminate(); } catch {} }
    return;
  }

  const state = { playerId: null, roomCode: null };
  let windowStartedAt = Date.now();
  let messageCount = 0;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (err) => {
    console.warn('[WS] socket error:', err?.message || err);
    try { ws.terminate(); } catch {}
  });

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
    handlers.handleClose(state, ws);
  });
});

/* ── Death forensics ───────────────────────────────────────────────────
   The play server has been found dead with a log that simply STOPS: no stack, no last
   line, no explanation. Everything below exists so that never happens again.

   There are exactly two ways this process can end without a word, and both are covered.

   (1) The event loop DRAINS. No request path calls process.exit(), and every throw and
       rejection is trapped below and merely logged, so an exit means Node ran out of work.
       While the server is listening that cannot happen — the listening handle and the
       turn/bot timers hold the loop open (only the heartbeat and the room reaper are
       unref'd) — but the instant the listen handle goes away, nothing does. That is a real
       measured death, and it is handled at `server.on('error')` below.
   (2) A SIGNAL. A signal death runs no 'exit' handler at all, which is precisely why
       nothing was ever printed. Handled just below.

   Everything here writes with fs.writeSync rather than console.error. Node's stdio is
   synchronous for files, TTYs and (measured here, Node 24 on darwin: 20,001 lines survived
   an immediate SIGKILL) pipes — but that is a platform-and-version detail, not a promise,
   and the whole value of these lines is that they are the LAST thing the process ever
   says. A write that has to survive its own death should not depend on which of the three
   the operator happened to redirect to. */
function hardLog(line) {
  try { fs.writeSync(2, line.endsWith('\n') ? line : line + '\n'); }
  catch { try { console.error(line); } catch {} }
}
function vitals() {
  return `uptime ${Math.round(process.uptime())}s, ${rooms.size} rooms, ${wss.clients.size} sockets`;
}

/* Last-resort backstop: one bad frame, one bug in a timer callback, must never end the
   process for every other room on the instance. Anything that reaches here is a defect —
   it is logged loudly — but the server keeps serving. */
process.on('uncaughtException', (err, origin) => {
  hardLog(`[FATAL] uncaught exception (${origin}) — server continues (${vitals()}): ${err?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  hardLog(`[FATAL] unhandled rejection — server continues (${vitals()}): ${reason?.stack || reason}`);
});

/* Signals that are NOT a shutdown request and must never end a game in progress.
   One observed death exited 144 — 128+16, which is SIGURG on macOS and SIGSTKFLT on
   Linux. Neither is something a supervisor sends to stop a server, and SIGURG in
   particular is spurious noise (out-of-band socket data, or a stray group signal from a
   Go-based parent process). Installing a listener is precisely what makes such a signal
   non-fatal: a signal with a JS handler no longer takes its default action, which on
   Linux for signal 16 is "terminate". Unknown names throw on registration and are
   skipped, so this list is portable. */
for (const name of ['SIGURG', 'SIGSTKFLT', 'SIGXCPU', 'SIGXFSZ', 'SIGPIPE']) {
  try {
    process.on(name, () => hardLog(`[SIGNAL] ${name} received and IGNORED — `
      + `not a shutdown request; the server keeps serving (${vitals()})`));
  } catch { /* not a signal this platform knows */ }
}

/* Signals that ARE a shutdown request are still obeyed — but they say so first, and they
   exit 128+n so a supervisor still reads the conventional code. */
for (const [name, number] of Object.entries({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1 })) {
  process.on(name, () => {
    hardLog(`[SIGNAL] ${name} — shutting down (${vitals()})`);
    process.exit(128 + number);
  });
}

// Fires for every exit the process chooses. It cannot fire for a signal death, which is
// the whole point: an [EXIT] line means the process decided, its absence means something
// outside did.
process.on('exit', (code) => hardLog(`[EXIT] code=${code} (${vitals()})`));

/* ── Start ─────────────────────────────────────────────────────────── */

/* THE silent death. Measured, not theorised: start a second server.js on a port that is
   already taken and the pre-fix process printed one line — `[WSS] server error: listen
   EADDRINUSE` — and then EXITED 0. No [FATAL], no stack, no last line, and every client
   on ERR_CONNECTION_REFUSED. Exactly the signature that has been reported.

   Two things conspired. The `ws` server re-emits the HTTP server's error, so wss.on('error')
   above swallowed it and it never reached uncaughtException; and once the listen handle is
   gone nothing else holds the loop open — the heartbeat and the room reaper are both
   unref'd — so Node ran out of work and left quietly with a success code.

   A failed listen is named and fatal ON PURPOSE now, so a supervisor sees a real failure
   and a human sees the reason. An error on an ALREADY-LISTENING server is a different
   animal — one connection's problem, not the process's — so it is logged and survived. */
server.on('error', (err) => {
  if (server.listening) {
    hardLog(`[WS] http server error while listening — server continues: ${err?.stack || err}`);
    return;
  }
  hardLog(`[FATAL] cannot listen on :${PORT} — ${err?.code || ''} ${err?.message || err}`);
  process.exit(1);
});

server.listen(PORT, () => {
  // Build every icon raster before the first request rather than making the
  // first tab paint pay for it. Measured: 29ms for the SVG + all five PNGs.
  const iconMs = icon.warm();
  console.log(`\n  CHUDOPOLY — Air Force Card Game`);
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log(`  icons generated in ${iconMs}ms (no binary in the tree — §0.3)\n`);
});
