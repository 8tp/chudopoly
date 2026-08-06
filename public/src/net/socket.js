// net/socket.js — the socket, the reconnect, and the message router.
//
// Two measured server behaviours shape this file (server.js, harness P2):
//   • 40 messages per rolling 5s per socket, then close(1008) with no warning.
//     Outbound is therefore a FIFO drained at MIN_GAP; 150ms is the proven-safe
//     gap (≈33 msgs / 5s worst case).
//   • Legal commands get NO ack — the next state broadcast is the ack. Illegal
//     ones reply {type:'error'} and do NOT rebroadcast, so the client must never
//     wait for a state that will not come.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';

const MIN_GAP = 150;
const RETRY_MS = 2000;

const KEY_PID = 'chud_pid';
const KEY_ROOM = 'chud_room';
const KEY_RESUME = 'chud_resume';

let ws = null;
let connecting = false;
let retryTimer = 0;
let wantConnection = false;

const outbox = [];
let drainTimer = 0;
let lastSentAt = 0;

/** Harness contract (§9 + tools/touchtest.mjs): every outbound message, in order. */
export const sentLog = [];
let recordSends = false;
export function setSendRecording(on) { recordSends = !!on; }

export function creds() {
  return {
    playerId: session(KEY_PID),
    code: session(KEY_ROOM),
    resumeToken: session(KEY_RESUME),
  };
}

export function storeCreds({ playerId, code, resumeToken }) {
  try {
    if (playerId) sessionStorage.setItem(KEY_PID, playerId);
    if (code) sessionStorage.setItem(KEY_ROOM, code);
    if (resumeToken) sessionStorage.setItem(KEY_RESUME, resumeToken);
  } catch { /* private mode: resume simply will not work */ }
}

export function clearCreds() {
  try {
    sessionStorage.removeItem(KEY_PID);
    sessionStorage.removeItem(KEY_ROOM);
    sessionStorage.removeItem(KEY_RESUME);
  } catch { /* ignore */ }
}

function session(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

export function isOpen() { return ws?.readyState === 1; }

export function connect() {
  wantConnection = true;
  if (isOpen() || connecting) return;
  connecting = true;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(`${proto}//${location.host}`);
  } catch (err) {
    connecting = false;
    bus.reportError(err);
    scheduleRetry();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    connecting = false;
    bus.emit(EVENTS.NET_OPEN, null);
    drain();
  };

  socket.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    route(msg);
  };

  socket.onerror = () => { connecting = false; };

  socket.onclose = (e) => {
    connecting = false;
    if (ws === socket) ws = null;
    bus.emit(EVENTS.NET_CLOSE, { code: e?.code || 0, reason: e?.reason || '' });
    if (wantConnection) scheduleRetry();
  };
}

export function disconnect() {
  wantConnection = false;
  clearTimeout(retryTimer);
  retryTimer = 0;
  outbox.length = 0;
  try { ws?.close(); } catch { /* already gone */ }
  ws = null;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    if (!wantConnection) return;
    resumeOrConnect();
  }, RETRY_MS);
}

/** Reconnect and immediately re-claim the seat if this tab holds resume creds. */
export function resumeOrConnect() {
  const { playerId, code, resumeToken } = creds();
  const resume = playerId && code && resumeToken;
  bus.once(EVENTS.NET_OPEN, () => {
    if (resume) send({ type: 'reconnect', playerId, code, resumeToken });
  });
  connect();
}

const ROUTES = {
  joined: EVENTS.NET_JOINED,
  state: EVENTS.NET_STATE,
  error: EVENTS.NET_ERROR,
  kicked: EVENTS.NET_KICKED,
  emote: EVENTS.NET_EMOTE,
  chat: EVENTS.NET_CHAT,
  chat_history: EVENTS.NET_CHAT_HISTORY,
  need_payment: EVENTS.NET_NEED_PAYMENT,
};

function route(msg) {
  if (msg?.type === 'joined') {
    storeCreds({ playerId: msg.playerId, code: msg.code, resumeToken: msg.resumeToken });
  }
  const channel = ROUTES[msg?.type];
  if (channel) bus.emit(channel, msg);
}

/**
 * Queue an outbound message. Never writes to the socket directly — see MIN_GAP.
 * sentLog records at ENQUEUE, not at flush: the harness question is "did that
 * touch ask the server for anything", and fixture-staged pages have no socket
 * to flush to at all.
 */
export function send(msg) {
  if (recordSends) sentLog.push({ ...msg, t: Math.round(performance.now()) });
  outbox.push(msg);
  drain();
}

function drain() {
  if (drainTimer) return;
  if (!outbox.length) return;
  if (!isOpen()) return;                    // onopen re-enters drain()
  const wait = Math.max(0, MIN_GAP - (Date.now() - lastSentAt));
  if (wait > 0) {
    drainTimer = setTimeout(() => { drainTimer = 0; drain(); }, wait);
    return;
  }
  const msg = outbox.shift();
  lastSentAt = Date.now();
  try {
    ws.send(JSON.stringify(msg));
    bus.emit(EVENTS.NET_SENT, msg);
  } catch (err) {
    bus.reportError(err);
  }
  if (outbox.length) drain();
}
