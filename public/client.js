// client.js — Chudopoly GO frontend

const COLORS = {
  brown:{name:'Drone Ops',bg:'#8B4513',fg:'#fff',size:2,rent:[1,2]},
  lightblue:{name:'Training',bg:'#87CEEB',fg:'#000',size:3,rent:[1,2,3]},
  pink:{name:'Space Force',bg:'#FF69B4',fg:'#000',size:3,rent:[1,2,4]},
  orange:{name:'Test & Eval',bg:'#FF8C00',fg:'#000',size:3,rent:[1,3,5]},
  red:{name:'Fighters',bg:'#DC143C',fg:'#fff',size:3,rent:[2,3,6]},
  yellow:{name:'Mobility',bg:'#FFD700',fg:'#000',size:3,rent:[2,4,6]},
  green:{name:'Elite Programs',bg:'#228B22',fg:'#fff',size:3,rent:[2,4,7]},
  darkblue:{name:'Command',bg:'#00308F',fg:'#fff',size:2,rent:[3,8]},
  base:{name:'Overseas Bases',bg:'#2F4F4F',fg:'#fff',size:4,rent:[1,2,3,4]},
  intel:{name:'Intelligence',bg:'#708090',fg:'#fff',size:2,rent:[1,2]},
};

const EMOTES = [
  'Bravo Zulu', 'Check Six!', 'Send It',
  'Roger That', 'TYFYS', 'FUBAR',
];

let ws, S = {}, myId = null, myName = '', roomCode = '';
let selectedHandCard = null;
let modalCallback = null;
let _responseModalOpen = false;
let _connecting = false;
let _lastTurnPlayerId = null;
let _tabFocused = true;
let _titleInterval = null;
let _originalTitle = document.title;
let _soundMuted = false;
let _chatMsgs = { room:[], global:[] };
let _chatScope = 'room';
let _chatUnread = { room:0, global:0 };
let _chatDrawerOpen = false;
let _giphyKey = '';
let _gifPickerFrom = '';
let _timerInterval = null;
let _autoDrawTimer = null;
let _responseTimerInterval = null;
let _alarmPlayed = false;
let _responseAlarmPlayed = false;
let _dealInCount = 0;
let _prevPlayerBotState = {}; // track isBot per player for takeover/reclaim detection

/* ── Sound engine (Web Audio API) ────────────────────────────────────── */

let _audioCtx;
function getAudio() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function playTone(freq, dur, type, vol) {
  if (_soundMuted) return;
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.value = vol || 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.stop(ctx.currentTime + dur);
  } catch {}
}

function sfx(name) {
  if (_soundMuted) return;
  switch (name) {
    case 'turn':
      playTone(440, 0.12, 'sine', 0.12);
      setTimeout(() => playTone(660, 0.15, 'sine', 0.15), 130);
      break;
    case 'play':
      playTone(880, 0.08, 'sine', 0.1);
      break;
    case 'bank':
      playTone(1200, 0.06, 'sine', 0.08);
      setTimeout(() => playTone(1400, 0.08, 'sine', 0.08), 70);
      break;
    case 'chud':
      playTone(220, 0.3, 'sawtooth', 0.1);
      setTimeout(() => playTone(165, 0.4, 'sawtooth', 0.12), 300);
      break;
    case 'win':
      [0,100,200,300,400].forEach((d,i) =>
        setTimeout(() => playTone([523,659,784,1047,1319][i], 0.3, 'sine', 0.12), d));
      break;
    case 'opsec':
      playTone(600, 0.15, 'square', 0.08);
      setTimeout(() => playTone(800, 0.15, 'square', 0.08), 160);
      break;
    case 'rent':
      playTone(500, 0.1, 'triangle', 0.1);
      setTimeout(() => playTone(400, 0.15, 'triangle', 0.1), 120);
      break;
    case 'draw':
      playTone(300, 0.05, 'sine', 0.06);
      setTimeout(() => playTone(350, 0.05, 'sine', 0.06), 60);
      break;
    case 'steal':
      playTone(500, 0.15, 'sawtooth', 0.08);
      setTimeout(() => playTone(350, 0.2, 'sawtooth', 0.1), 150);
      break;
    case 'swap':
      playTone(600, 0.1, 'triangle', 0.08);
      setTimeout(() => playTone(500, 0.1, 'triangle', 0.08), 120);
      setTimeout(() => playTone(600, 0.1, 'triangle', 0.08), 240);
      break;
    case 'seize':
      playTone(150, 0.3, 'sawtooth', 0.1);
      setTimeout(() => playTone(120, 0.35, 'sawtooth', 0.12), 100);
      setTimeout(() => playTone(200, 0.2, 'square', 0.08), 250);
      break;
    case 'upgrade':
      [0,80,160].forEach((d,i) =>
        setTimeout(() => playTone([600,800,1000][i], 0.12, 'sine', 0.1), d));
      break;
    case 'surge':
      playTone(200, 0.4, 'sawtooth', 0.06);
      setTimeout(() => playTone(400, 0.3, 'sawtooth', 0.08), 150);
      setTimeout(() => playTone(800, 0.2, 'sine', 0.1), 300);
      break;
    case 'pay':
      [0,50,100].forEach((d,i) =>
        setTimeout(() => playTone([1800,2000,1600][i], 0.04, 'sine', 0.06), d));
      break;
    case 'pcs':
      [0,40,80,120].forEach((d,i) =>
        setTimeout(() => playTone([400,500,450,550][i], 0.04, 'sine', 0.06), d));
      break;
    case 'demand':
      playTone(400, 0.15, 'square', 0.1);
      setTimeout(() => playTone(500, 0.2, 'square', 0.1), 170);
      break;
    case 'scoop':
      playTone(500, 0.15, 'sine', 0.1);
      setTimeout(() => playTone(400, 0.15, 'sine', 0.08), 150);
      setTimeout(() => playTone(300, 0.2, 'sine', 0.06), 300);
      setTimeout(() => playTone(200, 0.3, 'sine', 0.04), 450);
      break;
    case 'blocked':
      playTone(800, 0.08, 'square', 0.1);
      setTimeout(() => playTone(1200, 0.12, 'square', 0.08), 80);
      break;
    case 'property':
      playTone(600, 0.06, 'sine', 0.08);
      setTimeout(() => playTone(800, 0.08, 'sine', 0.1), 70);
      break;
    case 'error':
      playTone(200, 0.2, 'square', 0.08);
      break;
    case 'emote':
      playTone(700, 0.06, 'sine', 0.06);
      break;
    case 'alarm':
      // Loud 5-second warning alarm — pulsing high pitch
      [0,200,400,600,800].forEach((d,i) => {
        setTimeout(() => {
          playTone(1000, 0.15, 'square', 0.25);
          setTimeout(() => playTone(800, 0.1, 'square', 0.2), 100);
        }, d);
      });
      break;
    case 'siren':
      // Military air raid siren — rising/falling sweep
      if (_soundMuted) return;
      try {
        const ctx = getAudio();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(400, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 1.0);
        osc.frequency.linearRampToValueAtTime(400, ctx.currentTime + 2.0);
        osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 3.0);
        osc.frequency.linearRampToValueAtTime(400, ctx.currentTime + 4.0);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.setValueAtTime(0.2, ctx.currentTime + 3.5);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 4.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 4.5);
      } catch {}
      break;
  }
}

function toggleSound() {
  _soundMuted = !_soundMuted;
  const btn = $('btn-sound');
  if (btn) btn.classList.toggle('muted', _soundMuted);
  if (!_soundMuted) sfx('play');
}

/* ── Tab notification ────────────────────────────────────────────────── */

document.addEventListener('visibilitychange', () => {
  _tabFocused = !document.hidden;
  if (_tabFocused) stopTitleBlink();
});

function startTitleBlink() {
  if (_titleInterval) return;
  let on = true;
  _titleInterval = setInterval(() => {
    document.title = on ? '*** YOUR TURN ***' : _originalTitle;
    on = !on;
  }, 800);
}

function stopTitleBlink() {
  if (_titleInterval) { clearInterval(_titleInterval); _titleInterval = null; }
  document.title = _originalTitle;
}

/* ── Confetti ────────────────────────────────────────────────────────── */

function spawnConfetti() {
  const container = $('confetti');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#FFD700', '#00308F', '#DC143C', '#228B22', '#FF69B4', '#87CEEB', '#fff', '#FF8C00'];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = (Math.random() * 2) + 's';
    p.style.animationDuration = (2.5 + Math.random() * 3) + 's';
    p.style.setProperty('--drift', (Math.random() - 0.5) * 200 + 'px');
    p.style.setProperty('--rot', (360 + Math.random() * 720) + 'deg');
    p.style.width = (6 + Math.random() * 8) + 'px';
    p.style.height = (6 + Math.random() * 8) + 'px';
    container.appendChild(p);
  }
  setTimeout(() => container.innerHTML = '', 7000);
}

/* ── WebSocket ───────────────────────────────────────────────────────── */

function connect(onOpen) {
  if (_connecting) return;
  _connecting = true;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  updateConnStatus(false);
  ws.onopen = () => {
    _connecting = false;
    updateConnStatus(true);
    if (onOpen) onOpen();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'joined':
        myId = msg.playerId;
        myName = msg.name;
        roomCode = msg.code;
        try { sessionStorage.setItem('chud_pid', myId); sessionStorage.setItem('chud_room', roomCode); } catch {}
        if ($('lobby-error')) $('lobby-error').textContent = '';
        showLobbyWaiting();
        break;
      case 'state':
        handleState(msg);
        break;
      case 'error':
        toast(msg.message);
        sfx('error');
        if ($('lobby-error')) $('lobby-error').textContent = msg.message;
        if (msg.needDiscard) showDiscardModal(msg.excess);
        if (msg.needPayment) showPaymentModal(msg.amount);
        break;
      case 'need_payment':
        showPaymentModal(msg.amount);
        break;
      case 'kicked':
        myId = null; roomCode = '';
        try { sessionStorage.removeItem('chud_pid'); sessionStorage.removeItem('chud_room'); } catch {}
        toast('You were removed from the room');
        $('lobby-join').style.display = 'flex';
        $('lobby-waiting').style.display = 'none';
        $('game-screen').style.display = 'none';
        $('lobby-screen').style.display = 'flex';
        break;
      case 'emote':
        showFloatingEmote(msg.playerId, msg.name, msg.text);
        if (msg.playerId !== myId) sfx('emote');
        break;
      case 'chat': {
        const m = msg.msg;
        const scope = m.scope || 'room';
        _chatMsgs[scope].push(m);
        if (_chatMsgs[scope].length > 50) _chatMsgs[scope].shift();
        if (scope !== _chatScope || !isChatVisible()) _chatUnread[scope]++;
        renderAllChatContainers();
        if (m.pid !== myId) sfx('emote');
        break;
      }
      case 'chat_history': {
        const scope = msg.scope || 'room';
        _chatMsgs[scope] = msg.msgs || [];
        renderAllChatContainers();
        break;
      }
    }
  };
  ws.onerror = () => { _connecting = false; updateConnStatus(false); };
  ws.onclose = () => {
    _connecting = false;
    updateConnStatus(false);
    setTimeout(() => {
      const pid = myId || tryGet('chud_pid');
      const code = roomCode || tryGet('chud_room');
      if (pid && code) {
        connect(() => send({ type:'reconnect', playerId:pid, code }));
      } else {
        connect();
      }
    }, 2000);
  };
}

function updateConnStatus(connected) {
  const el = $('conn-status');
  if (!el) return;
  el.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
  el.title = connected ? 'Connected' : 'Reconnecting...';
}

function tryGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }

function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

/* ── Lobby ───────────────────────────────────────────────────────────── */

function createRoom() {
  const name = $('player-name').value.trim() || 'Maverick';
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  connect(() => {
    send({ type:'create_room', name });
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
  });
}

function joinRoom() {
  const name = $('player-name').value.trim() || 'Goose';
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!code) { toast('Enter a room code'); return; }
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  connect(() => {
    send({ type:'join_room', code, name });
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
  });
}

function startGame() {
  const timeout = parseInt($('turn-timeout')?.value) || 0;
  const responseTimeout = parseInt($('response-timeout')?.value) || 0;
  send({ type:'start_game', turnTimeout: timeout, responseTimeout: responseTimeout });
}

/* ── Bot Management ─────────────────────────────────────────────────── */

const BOT_MODES = {
  random:       { icon:'\uD83C\uDFB2', label:'Random',       desc:'Unpredictable plays',  color:'#9e9e9e' },
  conservative: { icon:'\uD83D\uDEE1\uFE0F',  label:'Conservative', desc:'Plays it safe',        color:'#42a5f5' },
  neutral:      { icon:'\u2696\uFE0F',  label:'Neutral',      desc:'Balanced strategy',    color:'#66bb6a' },
  aggressive:   { icon:'\u2694\uFE0F',  label:'Aggressive',   desc:'Relentless attacker',  color:'#ef5350' },
  chud:         { icon:'\uD83D\uDC80', label:'Chud',         desc:'Pure chaos',           color:'#ffd740' },
};

function showBotModePicker() {
  let body = '<p style="font-size:12px;color:#889;margin-bottom:8px">Choose bot personality:</p>';
  body += '<div class="bot-mode-grid">';
  for (const [mode, info] of Object.entries(BOT_MODES)) {
    body += `<button class="bot-mode-btn" onclick="addBot('${mode}')">
      <span class="mode-icon">${info.icon}</span>
      <span class="mode-label" style="color:${info.color}">${info.label}</span>
      <span class="mode-desc">${info.desc}</span>
    </button>`;
  }
  body += '</div>';
  showModal('Add Bot', body, [
    { label:'Cancel', cls:'btn-secondary', fn:closeModalDirect },
  ]);
}

function addBot(mode) {
  send({ type:'add_bot', mode });
  closeModalDirect();
}

function removeBot(targetId) {
  send({ type:'remove_bot', targetId });
}

function showLobbyWaiting() {
  $('lobby-join').style.display = 'none';
  $('lobby-waiting').style.display = 'flex';
  $('room-code-display').textContent = roomCode;
  const lc = $('lobby-chat');
  if (lc) lc.style.display = 'flex';
}

/* ── State handler ───────────────────────────────────────────────────── */

function handleState(msg) {
  const prevState = S;
  S = msg;

  if (S.game) {
    const isMyTurn = S.game.currentPlayerId === myId;

    // Detect turn change → sound + tab notification + popup
    if (isMyTurn && _lastTurnPlayerId !== myId) {
      sfx('turn');
      if (!_tabFocused) startTitleBlink();
      showTurnPopup();
    }
    if (_tabFocused && isMyTurn) stopTitleBlink();
    _lastTurnPlayerId = S.game.currentPlayerId;

    // Detect events from log changes for sound effects + toasts
    if (prevState.game && S.game.log.length > prevState.game.log.length) {
      const newLogs = S.game.log.slice(prevState.game.log.length);
      for (const l of newLogs) {
        if (l.includes('CHUD')) sfx('chud');
        else if (l.includes('plays OPSEC') || l.includes('counters OPSEC')) { sfx('opsec'); toast(l); }
        else if (l.includes('blocked by OPSEC')) { sfx('blocked'); toast(l); }
        else if (l.includes('charges') && l.includes('rent')) sfx('rent');
        else if (l.includes('drew')) {
          sfx('draw');
          // Detect draw count for deal-in animation
          const m = l.match(/drew (\d+)/);
          if (m) _dealInCount = parseInt(m[1]);
        }
        else if (l.includes('banked')) sfx('bank');
        else if (l.includes('wins with') || l.includes('wins —')) sfx('siren');
        else if (l.includes('requisitioned') || l.includes('commandeered')) { sfx('steal'); toast(l); }
        else if (l.includes('swapped')) sfx('swap');
        else if (l.includes('seized')) { sfx('seize'); toast(l); }
        else if (l.includes('upgraded') || l.includes('FOC')) sfx('upgrade');
        else if (l.includes('Surge Operations')) sfx('surge');
        else if (l.includes('paid')) sfx('pay');
        else if (l.includes('PCS Orders')) sfx('pcs');
        else if (l.includes('demands') || l.includes('Roll Call')) sfx('demand');
        else if (l.includes('scooped')) sfx('scoop');
        else if (l.includes('played') && l.includes(' on ')) sfx('property');
      }
    }

    // Detect bot takeover / human reclaim (using lobby player list which has isBot)
    if (S.players) {
      for (const p of S.players) {
        const wasBotBefore = _prevPlayerBotState[p.id];
        if (wasBotBefore === false && p.isBot) {
          toast(p.name + ' disconnected \u2014 bot taking over');
        } else if (wasBotBefore === true && !p.isBot && p.id !== myId) {
          toast(p.name + ' is back in control');
        }
        _prevPlayerBotState[p.id] = !!p.isBot;
      }
    }

    // Auto-draw when it's our turn (skip if eliminated)
    const meState = S.game.players.find(p => p.id === myId);
    if (isMyTurn && S.game.turnPhase === 'draw' && !meState?.eliminated) {
      if (!_autoDrawTimer) {
        _autoDrawTimer = setTimeout(() => {
          _autoDrawTimer = null;
          doDraw();
        }, 300);
      }
    } else {
      if (_autoDrawTimer) { clearTimeout(_autoDrawTimer); _autoDrawTimer = null; }
    }

    // Clear targeting when not our turn
    if (!isMyTurn) {
      clearTargeting();
      selectedHandCard = null;
    }
  }

  if (msg.phase === 'lobby') {
    renderLobby();
  } else if (msg.game) {
    $('lobby-screen').style.display = 'none';
    $('game-screen').style.display = 'flex';
    renderGame();
  }
}

function renderLobby() {
  const isHost = S.hostId === myId;
  const list = $('player-list');
  list.innerHTML = S.players.map(p => {
    const isBot = !!p.isBot;
    const badges = (p.id === myId ? '<span class="you">YOU</span>' : '')
      + (p.id === S.hostId ? '<span class="host-badge">HOST</span>' : '')
      + (isBot && p.botMode ? `<span class="bot-badge mode-${p.botMode}">${BOT_MODES[p.botMode]?.icon || '\u2699'} ${p.botMode}</span>` : '');
    const actionBtn = isHost && p.id !== myId
      ? (isBot
        ? `<button class="remove-bot-btn" onclick="removeBot('${p.id}')">Remove</button>`
        : `<button class="kick-btn" onclick="kickPlayer('${p.id}')">Kick</button>`)
      : '';
    return `<div class="player-item">
      <span class="dot ${isBot || p.connected ? '' : 'off'}"></span>
      ${isBot ? '<span class="bot-icon">\u2699</span>' : ''}
      <span class="player-name-text">${esc(p.name)}</span>
      ${badges}
      <span class="player-spacer"></span>
      ${actionBtn}
    </div>`;
  }).join('');
  $('btn-start').style.display = isHost ? 'block' : 'none';
  $('waiting-msg').style.display = isHost ? 'none' : 'block';
  const rs = $('room-settings');
  if (rs) rs.style.display = isHost ? 'block' : 'none';
  const bc = $('bot-controls');
  if (bc) bc.style.display = isHost && S.players.length < 5 ? 'block' : 'none';
}

function kickPlayer(targetId) { send({ type:'kick', targetId }); }

/* ── Game rendering ──────────────────────────────────────────────────── */

function renderGame() {
  const g = S.game;
  if (!g) return;
  const me = g.players.find(p => p.id === myId);
  if (!me) return;
  const isMyTurn = g.currentPlayerId === myId;
  const pa = g.pendingAction;
  const amResponder = pa?.responderId === myId
    || (pa?.type === 'payment_all' && pa?.pending?.includes(myId))
    || (pa?.type === 'payment_all' && pa?.opsecChains?.[myId]?.responderId === myId)
    || (pa?.type === 'payment_all' && pa?.sourceId === myId && Object.values(pa?.opsecChains || {}).some(c => c.responderId === myId));

  // Header
  $('hdr-room').textContent = 'ROOM ' + S.code;
  const cp = g.players.find(p => p.id === g.currentPlayerId);
  $('hdr-turn').textContent = cp ? (cp.id === myId ? 'YOUR TURN' : cp.name + "'s turn") : '';
  $('hdr-phase').textContent = g.turnPhase.replace('_',' ').toUpperCase();
  $('hdr-phase').className = 'hdr-badge' + (isMyTurn ? ' your-turn' : '');
  $('hdr-plays').textContent = isMyTurn ? g.playsRemaining + ' plays left' : '';
  $('hdr-deck').textContent = 'Deck: ' + g.deckCount;
  if (g.surgeOps && isMyTurn) $('hdr-plays').textContent += ' | SURGE OPS';

  // Turn timer — only show when no response timer active
  const timerEl = $('hdr-timer');
  if (S.responseTimer) {
    // Response timer takes priority
    timerEl.style.display = 'inline';
    updateResponseTimerDisplay();
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (!_responseTimerInterval) _responseTimerInterval = setInterval(updateResponseTimerDisplay, 500);
  } else if (S.turnTimer) {
    timerEl.style.display = 'inline';
    updateTimerDisplay();
    if (_responseTimerInterval) { clearInterval(_responseTimerInterval); _responseTimerInterval = null; }
    _responseAlarmPlayed = false;
    if (!_timerInterval) _timerInterval = setInterval(updateTimerDisplay, 1000);
  } else {
    timerEl.style.display = 'none';
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (_responseTimerInterval) { clearInterval(_responseTimerInterval); _responseTimerInterval = null; }
    _alarmPlayed = false;
    _responseAlarmPlayed = false;
  }

  // Buttons
  const drawBtn = $('btn-draw');
  if (drawBtn) drawBtn.style.display = (isMyTurn && g.turnPhase === 'draw' && !me.eliminated) ? '' : 'none';
  $('btn-end-turn').disabled = !(isMyTurn && g.turnPhase === 'play');
  const scoopBtn = $('btn-scoop');
  if (scoopBtn) scoopBtn.style.display = me.eliminated ? 'none' : '';

  // Hand area glow when it's your turn
  const handArea = $('hand-area');
  if (handArea) handArea.classList.toggle('my-turn', isMyTurn);

  // Card count
  $('hand-count').textContent = '(' + (me.hand || []).length + ')';

  // Targeting banner
  updateTargetingBanner();

  // Opponents
  const opps = g.players.filter(p => p.id !== myId);
  $('opponents').innerHTML = opps.map(p => {
    if (p.eliminated) {
      return `<div class="opp-card eliminated" data-pid="${p.id}">
        <div class="opp-name">${esc(p.name)} <span class="sets" style="color:#f44">SCOOPED</span></div>
      </div>`;
    }
    const isTurn = p.id === g.currentPlayerId;
    const isResp = g.pendingAction?.responderId === p.id || g.pendingAction?.pending?.includes(p.id);
    const nw = netWorth(p);
    // Targeting highlight/dim classes
    let targetCls = '';
    if (window._pendingSteal) {
      const action = window._pendingSteal.action;
      const hasProps = Object.values(p.properties).some(cards => cards && cards.length > 0);
      if (action === 'chud') {
        targetCls = hasProps ? 'target-highlight' : 'target-dimmed';
      } else {
        // midnight_requisition: only non-complete sets are valid
        const hasStealable = Object.entries(p.properties).some(([col, cards]) => {
          const info = COLORS[col];
          return info && cards && cards.length > 0 && cards.length < info.size;
        });
        targetCls = hasStealable ? 'target-highlight' : 'target-dimmed';
      }
    } else if (window._pendingSwap && window._pendingSwap.step === 'theirs') {
      const hasProps = Object.values(p.properties).some(cards => cards && cards.length > 0);
      targetCls = hasProps ? 'target-highlight' : 'target-dimmed';
    } else if (window._pendingIG) {
      const hasComplete = Object.entries(p.properties).some(([col, cards]) => {
        const info = COLORS[col];
        return info && cards && cards.length >= info.size;
      });
      targetCls = hasComplete ? 'target-highlight' : 'target-dimmed';
    }
    const pLobby = (S.players||[]).find(x => x.id === p.id);
    const pIsBot = pLobby?.isBot;
    const pBotMode = pLobby?.botMode;
    const botInfo = pIsBot && pBotMode && BOT_MODES[pBotMode]
      ? `<span class="opp-bot-indicator"><span class="bot-badge mode-${pBotMode}">${BOT_MODES[pBotMode].icon} ${pBotMode}</span></span>`
      : '';
    return `<div class="opp-card ${isTurn?'active-turn':''} ${isResp?'responding':''} ${targetCls}" data-pid="${p.id}" onclick="showOpponentDetail('${p.id}')">
      <div class="opp-name">${p.id===S.hostId?'<span class="opp-host" title="Host">&#9733;</span>':''}${pIsBot?'<span class="bot-icon">\u2699</span>':''}${esc(p.name)} <span class="sets">${p.completedSets}/3 sets</span>${botInfo}</div>
      <div class="opp-stats">
        <span>Hand: ${p.handCount}</span>
        <span>Bank: ${bankTotal(p)}M</span>
      </div>
      <div class="opp-props">${renderMiniProps(p)}</div>
      ${renderSetProgress(p)}
      <div class="opp-net-worth">Net worth: ${nw}M</div>
    </div>`;
  }).join('');

  // My bank
  $('my-bank-total').textContent = '(' + bankTotal(me) + 'M)';
  $('my-bank').innerHTML = me.bank.map(c => renderCard(c, 'bank')).join('');

  // My net worth
  const myNW = $('my-net-worth');
  if (myNW) myNW.textContent = 'Net Worth: ' + netWorth(me) + 'M | Sets: ' + (me.completedSets||0) + '/3';

  // My properties
  $('my-properties').innerHTML = renderPropertySets(me);

  // Discard pile
  renderDiscardPile(g.discardTop);

  // My hand
  const handCards = me.hand || [];
  const dealCount = _dealInCount;
  _dealInCount = 0;
  $('my-hand').innerHTML = handCards.map((c,i) => {
    let html = renderCard(c, 'hand', i);
    // Apply deal-in animation to the last N cards if we just drew
    if (dealCount > 0 && i >= handCards.length - dealCount) {
      const delay = (i - (handCards.length - dealCount)) * 0.1;
      html = html.replace('<div class="card', `<div style="animation-delay:${delay}s" class="card card-deal-in`);
    }
    return html;
  }).join('');

  // Log
  $('game-log').innerHTML = g.log.map(l => formatLogEntry(l)).join('');
  const logEl = $('game-log');
  logEl.scrollTop = logEl.scrollHeight;

  // Pending action — show response modal (only if not already open)
  if (amResponder && g.pendingAction && !_responseModalOpen) {
    _responseModalOpen = true;
    showResponseModal(g.pendingAction);
  }
  if (!amResponder) {
    _responseModalOpen = false;
  }

  // Winner
  if (g.winner) {
    const winner = g.players.find(p => p.id === g.winner);
    $('winner-name').textContent = winner ? winner.name : '???';
    $('winner-overlay').style.display = 'flex';
    spawnConfetti();
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (_responseTimerInterval) { clearInterval(_responseTimerInterval); _responseTimerInterval = null; }
    _alarmPlayed = false; _responseAlarmPlayed = false;
    $('hdr-timer').style.display = 'none';
  } else {
    $('winner-overlay').style.display = 'none';
  }
}

/* ── Discard pile ────────────────────────────────────────────────────── */

function renderDiscardPile(card) {
  const el = $('discard-pile');
  if (!el) return;
  const countEl = $('discard-count');
  const total = S.game?.discardPile?.length || 0;
  if (countEl) countEl.textContent = total > 0 ? '(' + total + ')' : '';
  if (!card) {
    el.innerHTML = '<div class="empty-discard">No cards played yet</div>';
    return;
  }
  el.innerHTML = '<div class="discard-top-hint">Tap to view all</div>' + renderCard(card, 'discard');
  el.style.cursor = 'pointer';
  el.onclick = showDiscardPileModal;
}

function showDiscardPileModal() {
  const g = S.game;
  if (!g?.discardPile || g.discardPile.length === 0) {
    showModal('Discard Pile', '<p style="color:#889">No cards in the discard pile.</p>', [
      { label:'Close', cls:'btn-secondary', fn:closeModalDirect }
    ]);
    return;
  }
  const body = '<div class="discard-grid">' +
    g.discardPile.map(c => renderCard(c, 'view')).join('') +
    '</div>';
  showModal('Discard Pile (' + g.discardPile.length + ' cards)', body, [
    { label:'Close', cls:'btn-secondary', fn:closeModalDirect }
  ]);
}

/* ── Card rendering ──────────────────────────────────────────────────── */

function colorLabel(colorKey) {
  if (colorKey === 'any') return '<span class="color-label">ANY <span class="color-dot" style="background:linear-gradient(135deg,#DC143C,#FFD700,#228B22,#00308F)"></span></span>';
  const info = COLORS[colorKey];
  if (!info) return esc(colorKey);
  return `<span class="color-label">${esc(info.name)} <span class="color-dot" style="background:${info.bg}"></span></span>`;
}

function formatLogEntry(text) {
  // Determine overall line class
  let cls = '';
  if (text.includes('CHUD')) cls = 'log-chud';
  else if (text.includes('plays OPSEC') || text.includes('counters OPSEC') || text.includes('OPSEC again')) cls = 'log-opsec';
  else if (text.includes('blocked by OPSEC')) cls = 'log-blocked';
  else if (text.includes('charges') && text.includes('rent')) cls = 'log-rent';
  else if (text.includes("'s turn")) cls = 'log-turn';
  else if (text.includes('banked')) cls = 'log-bank';
  else if (text.includes('drew')) cls = 'log-draw';
  else if (text.includes('requisitioned') || text.includes('commandeered')) cls = 'log-steal';
  else if (text.includes('seized')) cls = 'log-seize';
  else if (text.includes('swapped')) cls = 'log-swap';
  else if (text.includes('upgraded') || text.includes('FOC')) cls = 'log-upgrade';
  else if (text.includes('Surge Operations')) cls = 'log-surge';
  else if (text.includes('paid')) cls = 'log-pay';
  else if (text.includes('PCS Orders')) cls = 'log-pcs';
  else if (text.includes('demands') || text.includes('Roll Call')) cls = 'log-demand';
  else if (text.includes('scooped')) cls = 'log-scoop';
  else if (text.includes('wins with') || text.includes('wins —')) cls = 'log-win';
  else if (text.includes('played') && text.includes(' on ')) cls = 'log-property';

  // Escape the text first
  let safe = esc(text);

  // Highlight property color names with their actual color
  for (const [key, info] of Object.entries(COLORS)) {
    const name = info.name;
    const escaped = esc(name);
    if (safe.includes(escaped)) {
      safe = safe.replace(new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        `<span class="log-color-tag" style="color:${info.bg}">${escaped}</span>`);
    }
  }

  // Highlight money amounts (e.g., "5M", "10M")
  safe = safe.replace(/(\d+)M\b/g, '<span class="log-amount">$1M</span>');

  return `<div class="${cls}">${safe}</div>`;
}

function renderCard(card, context, handIndex) {
  const sel = context === 'hand' && selectedHandCard === handIndex ? ' selected' : '';
  let cls = 'card' + sel;
  let inner = '';

  if (card.type === 'property') {
    cls += ' prop-' + card.color;
    const info = COLORS[card.color];
    inner = `
      <div class="card-type" style="background:${info?.bg||'#444'};color:${info?.fg||'#fff'}">${info?.name||card.color}</div>
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-rent">Rent: ${info?.rent?.join('M / ')+'M' || '?'}</div>
      <div class="card-value">Value: ${card.value}M</div>`;
  } else if (card.type === 'wild_property') {
    cls += ' wild-card';
    const wildColors = card.colors[0]==='any' ? colorLabel('any') : card.colors.map(c => colorLabel(c)).join(' / ');
    inner = `
      <div class="card-type" style="background:#666">WILD</div>
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-desc">${wildColors}</div>
      <div class="card-value">Value: ${card.value}M</div>`;
  } else if (card.type === 'money') {
    cls += ' money';
    inner = `
      <div class="card-type" style="background:#2a5a2a">FUNDS</div>
      <div class="card-name">${card.value}M</div>`;
  } else if (card.type === 'rent') {
    cls += ' rent-card';
    const colorNames = card.colors.map(c => colorLabel(c)).join(' / ');
    inner = `
      <div class="card-type" style="background:#6a2a8a">RENT</div>
      <div class="card-name">Rent</div>
      <div class="card-desc">${colorNames}</div>
      <div class="card-value">Value: ${card.value}M</div>`;
  } else if (card.action === 'chud') {
    cls += ' chud-card';
    inner = `
      <div class="card-type">&#9733; CHUD</div>
      <div class="card-name">THE CHUD</div>
      <div class="card-desc">Steal ANY property<br>+ collect 2M</div>
      <div class="card-value">Value: ${card.value}M</div>`;
  } else if (card.type === 'action') {
    cls += ' action-card';
    inner = `
      <div class="card-type" style="background:#2a2a6a">ACTION</div>
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-desc">${esc(card.description||'')}</div>
      <div class="card-value">Value: ${card.value}M</div>`;
  }

  const onclick = context === 'hand' ? ` onclick="selectHandCard(${handIndex})"` : '';
  return `<div class="${cls}"${onclick}>${inner}</div>`;
}

function renderMiniProps(player) {
  let html = '';
  const inTargeting = window._pendingSteal || (window._pendingSwap && window._pendingSwap.step === 'theirs') || window._pendingIG;
  for (const [color, cards] of Object.entries(player.properties)) {
    const info = COLORS[color];
    if (!info || !cards || cards.length === 0) continue;
    const complete = cards.length >= info.size;
    // Determine if this set's mini-props should be dimmed
    let dimmed = false;
    if (window._pendingSteal && window._pendingSteal.action !== 'chud' && complete) dimmed = true;
    if (window._pendingIG && !complete) dimmed = true;
    for (const c of cards) {
      const dimCls = dimmed ? ' target-dimmed' : '';
      // During targeting, clicks open the detail modal instead of direct action
      const onclick = inTargeting
        ? `event.stopPropagation();showOpponentDetail('${player.id}')`
        : `event.stopPropagation();selectTargetProperty('${player.id}',${c.id},'${color}')`;
      html += `<div class="mini-prop ${complete?'complete':''}${dimCls}" style="background:${info.bg};color:${info.fg}"
        title="${esc(c.name)} (${info.name})"
        onclick="${onclick}">${complete ? '\u2605' : ''}</div>`;
    }
  }
  return html || '<span style="font-size:11px;color:#556">No properties</span>';
}

function renderSetProgress(player) {
  let html = '';
  for (const [color, cards] of Object.entries(player.properties)) {
    const info = COLORS[color];
    if (!info || !cards || cards.length === 0) continue;
    html += '<div class="set-progress">';
    for (let i = 0; i < info.size; i++) {
      html += `<div class="set-progress-seg ${i < cards.length ? 'filled' : ''}" style="${i < cards.length ? 'background:'+info.bg : ''}"></div>`;
    }
    html += '</div>';
  }
  return html;
}

window.showOpponentDetail = function(playerId) {
  const g = S.game;
  if (!g) return;
  const p = g.players.find(x => x.id === playerId);
  if (!p) return;

  // Determine picker mode
  const isSteal = !!window._pendingSteal;
  const isSwap = window._pendingSwap && window._pendingSwap.step === 'theirs';
  const isIG = !!window._pendingIG;
  const isPicker = isSteal || isSwap || isIG;

  let title = esc(p.name) + "'s Board";
  if (isSteal) {
    title = window._pendingSteal.action === 'chud'
      ? 'Commandeer from ' + esc(p.name)
      : 'Steal from ' + esc(p.name);
  } else if (isSwap) {
    title = 'Swap with ' + esc(p.name);
  } else if (isIG) {
    title = 'Seize Set from ' + esc(p.name);
  }

  let body = '';

  // Stats bar
  body += `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px;font-size:13px;color:#C0C0C0">
    <span>Sets: <strong>${p.completedSets}/3</strong></span>
    <span>Hand: <strong>${p.handCount}</strong></span>
    <span>Net Worth: <strong>${netWorth(p)}M</strong></span>
  </div>`;

  // Bank (hide in picker mode — can't steal from bank)
  if (!isPicker) {
    body += '<h4 style="color:#FFD700;font-size:12px;margin:8px 0 4px;letter-spacing:1px">BANK (' + bankTotal(p) + 'M)</h4>';
    if (p.bank.length > 0) {
      body += '<div class="discard-grid">' + p.bank.map(c => renderCard(c, 'view')).join('') + '</div>';
    } else {
      body += '<p style="font-size:12px;color:#556">No funds banked</p>';
    }
  }

  // Properties
  if (isPicker) {
    body += '<p style="font-size:12px;color:#C0C0C0;margin:4px 0 8px">';
    if (isSteal && window._pendingSteal.action !== 'chud') body += 'Select a property to steal (complete sets are protected):';
    else if (isSteal) body += 'Select any property to commandeer:';
    else if (isSwap) body += 'Select a property to swap with:';
    else if (isIG) body += 'Select a complete set to seize:';
    body += '</p>';
  } else {
    body += '<h4 style="color:#FFD700;font-size:12px;margin:12px 0 4px;letter-spacing:1px">PROPERTIES</h4>';
  }

  let propHTML = '';
  for (const [color, cards] of Object.entries(p.properties)) {
    const info = COLORS[color];
    if (!info || !cards || cards.length === 0) continue;
    const complete = cards.length >= info.size;
    const ups = p.upgrades?.[color] || [];
    const rentIdx = Math.min(cards.length, info.rent.length) - 1;
    const currentRent = rentIdx >= 0 ? info.rent[rentIdx] : 0;
    let rentExtra = 0;
    if (ups.includes('house')) rentExtra += 3;
    if (ups.includes('hotel')) rentExtra += 4;

    // Determine if this set is dimmed/non-selectable in picker mode
    let setDimmed = false;
    if (isSteal && window._pendingSteal.action !== 'chud' && complete) setDimmed = true;
    if (isIG && !complete) setDimmed = true;

    propHTML += `<div class="opp-detail-set ${complete?'complete':''} ${setDimmed?'pick-dimmed':''}">
      <div class="opp-detail-set-header">
        <span class="color-dot" style="background:${info.bg}"></span>
        <strong>${esc(info.name)}</strong>
        <span style="color:#889;font-size:11px">${cards.length}/${info.size}</span>
        ${complete?'<span style="color:#4caf50;font-size:10px;font-weight:700">COMPLETE</span>':''}
        ${setDimmed && isSteal ? '<span style="color:#f44;font-size:10px;margin-left:4px">PROTECTED</span>' : ''}
        ${ups.includes('house')?'<span style="color:#ff9800;font-size:10px">+UPG</span>':''}
        ${ups.includes('hotel')?'<span style="color:#f44336;font-size:10px">+FOC</span>':''}
      </div>`;

    if (!isPicker) {
      propHTML += `<div style="font-size:11px;color:#889;margin:2px 0 4px">
        Current rent: ${currentRent + rentExtra}M
        ${rentExtra > 0 ? ' (base ' + currentRent + 'M + ' + rentExtra + 'M upgrades)' : ''}
        &middot; Rent table: ${info.rent.map((r,i) => (i===rentIdx?'<strong>'+r+'M</strong>':r+'M')).join(' / ')}
      </div>
      <div class="discard-grid">${cards.map(c => renderCard(c, 'view')).join('')}</div>`;
    } else if (isIG && complete && !setDimmed) {
      // IG: show "Seize This Set" button for the whole set
      propHTML += `<div class="discard-grid">${cards.map(c => renderCard(c, 'view')).join('')}</div>`;
      propHTML += `<button class="pick-set-btn" onclick="window._pickIG('${playerId}','${color}')">Seize This Set</button>`;
    } else if (!setDimmed) {
      // Steal/CHUD/Swap: show individual card pick buttons
      cards.forEach(c => {
        propHTML += `<div class="pick-card-row">
          ${renderCard(c, 'view')}
          <button class="pick-btn" onclick="window._pickCard('${playerId}',${c.id},'${color}')">Select</button>
        </div>`;
      });
    } else {
      // Dimmed sets still show cards but no buttons
      propHTML += `<div class="discard-grid">${cards.map(c => renderCard(c, 'view')).join('')}</div>`;
    }

    propHTML += '</div>';
  }
  body += propHTML || '<p style="font-size:12px;color:#556">No properties yet</p>';

  // Set up picker callbacks
  if (isPicker) {
    window._pickCard = function(pid, cardId, color) {
      if (isSteal) {
        send({ type:'play_action', cardIndex:window._pendingSteal.handIndex, targetId:pid, targetCardId:cardId });
      } else if (isSwap) {
        send({ type:'play_action', cardIndex:window._pendingSwap.handIndex, targetId:pid, targetCardId:cardId, myCardId:window._pendingSwap.myCardId });
      }
      selectedHandCard = null;
      clearTargeting();
      closeModalDirect();
      renderGame();
    };
    window._pickIG = function(pid, color) {
      send({ type:'play_action', cardIndex:window._pendingIG.handIndex, targetId:pid, targetColor:color });
      selectedHandCard = null;
      clearTargeting();
      closeModalDirect();
      renderGame();
    };
  }

  const cancelLabel = isPicker ? 'Back' : 'Close';
  const cancelFn = isPicker ? () => { closeModalDirect(); } : closeModalDirect;

  showModal(title, body, [
    { label:cancelLabel, cls:'btn-secondary', fn:cancelFn }
  ]);
};

function renderPropertySets(player) {
  let html = '';
  const swapMine = window._pendingSwap && window._pendingSwap.step === 'mine';
  for (const [color, cards] of Object.entries(player.properties)) {
    const info = COLORS[color];
    if (!info || !cards || cards.length === 0) continue;
    const complete = cards.length >= info.size;
    const ups = player.upgrades?.[color] || [];
    const rentIdx = Math.min(cards.length, info.rent.length) - 1;
    const currentRent = rentIdx >= 0 ? info.rent[rentIdx] : 0;
    let rentExtra = 0;
    if (ups.includes('house')) rentExtra += 3;
    if (ups.includes('hotel')) rentExtra += 4;
    html += `<div class="prop-set ${complete?'complete':''} ${swapMine?'my-highlight':''}">
      <div class="prop-set-header">
        <div class="prop-color-dot" style="background:${info.bg}"></div>
        ${info.name}
        <span class="prop-set-count">${cards.length}/${info.size}</span>
        ${ups.includes('house')?'<span class="prop-set-upgrade">+UPG</span>':''}
        ${ups.includes('hotel')?'<span class="prop-set-upgrade">+FOC</span>':''}
      </div>
      <div class="prop-set-rent" style="font-size:10px;color:#889;margin:1px 0 3px">
        Rent: ${currentRent + rentExtra}M${rentExtra > 0 ? ' ('+currentRent+'M+'+rentExtra+'M)' : ''}
        <span style="color:#556">| ${info.rent.map((r,i) => (i===rentIdx?'<b>'+r+'</b>':r)).join('/')}</span>
      </div>
      <div class="prop-set-cards">
        ${cards.map(c => `<div class="prop-mini ${swapMine?'my-highlight':''}" onclick="selectMyProperty(${c.id},'${color}')">${esc(c.name)}</div>`).join('')}
      </div>
    </div>`;
  }
  return html || '<p style="font-size:12px;color:#556">No properties yet</p>';
}

/* ── Targeting (steal/swap) ──────────────────────────────────────────── */

function updateTargetingBanner() {
  const banner = $('targeting-banner');
  const msg = $('targeting-msg');
  if (window._pendingSteal) {
    banner.style.display = 'flex';
    const action = window._pendingSteal.action;
    msg.textContent = action === 'chud'
      ? 'CHUD CARD ACTIVE — Click an opponent to commandeer a property!'
      : 'STEAL MODE — Click an opponent to requisition a property!';
  } else if (window._pendingSwap) {
    banner.style.display = 'flex';
    msg.textContent = window._pendingSwap.step === 'mine'
      ? 'SWAP — Click one of YOUR properties first'
      : 'SWAP — Now click an opponent to swap with';
  } else if (window._pendingIG) {
    banner.style.display = 'flex';
    msg.textContent = 'INSPECTOR GENERAL — Click an opponent to seize a complete set!';
  } else {
    banner.style.display = 'none';
  }
}

function cancelTargeting() {
  clearTargeting();
  selectedHandCard = null;
  renderGame();
}

function clearTargeting() {
  delete window._pendingSteal;
  delete window._pendingSwap;
  delete window._pendingIG;
  const banner = $('targeting-banner');
  if (banner) banner.style.display = 'none';
}

/* ── Interactions ────────────────────────────────────────────────────── */

function selectHandCard(idx) {
  const g = S.game;
  if (!g) return;
  const isMyTurn = g.currentPlayerId === myId;
  if (!isMyTurn || g.turnPhase !== 'play' || g.playsRemaining <= 0) {
    toast('Cannot play cards right now');
    return;
  }

  selectedHandCard = selectedHandCard === idx ? null : idx;
  if (selectedHandCard === null) { renderGame(); return; }

  const me = g.players.find(p => p.id === myId);
  const card = me.hand[idx];
  if (!card) return;

  clearTargeting();
  renderGame();
  showCardActionModal(card, idx);
}

function showCardActionModal(card, handIndex) {
  const actions = [];

  // Properties can only be played as properties, not banked
  if (card.type !== 'property' && card.type !== 'wild_property') {
    actions.push({ label:'Bank as ' + card.value + 'M', cls:'btn-secondary', fn:() => {
      send({ type:'play_money', cardIndex:handIndex });
      selectedHandCard = null; closeModalDirect();
    }});
  }

  if (card.type === 'property') {
    actions.push({ label:'Play Property', cls:'btn-primary', fn:() => {
      send({ type:'play_property', cardIndex:handIndex });
      selectedHandCard = null; closeModalDirect();
    }});
  }

  if (card.type === 'wild_property') {
    actions.push({ label:'Play Wild Property', cls:'btn-primary', fn:() => {
      showColorPicker(card.colors, (color) => {
        send({ type:'play_property', cardIndex:handIndex, targetColor:color });
        selectedHandCard = null; closeModalDirect();
      });
    }});
  }

  if (card.type === 'action') {
    const a = card.action;
    if (a === 'pcs_orders') {
      actions.push({ label:'Draw 2 Cards', cls:'btn-primary', fn:() => {
        send({ type:'play_action', cardIndex:handIndex });
        selectedHandCard = null; closeModalDirect();
      }});
    } else if (a === 'finance_office') {
      actions.push({ label:'Collect 5M from...', cls:'btn-primary', fn:() => {
        showTargetPicker((tid) => {
          send({ type:'play_action', cardIndex:handIndex, targetId:tid });
          selectedHandCard = null; closeModalDirect();
        });
      }});
    } else if (a === 'roll_call') {
      actions.push({ label:'Everyone Pays 2M', cls:'btn-primary', fn:() => {
        send({ type:'play_action', cardIndex:handIndex });
        selectedHandCard = null; closeModalDirect();
      }});
    } else if (a === 'inspector_general') {
      actions.push({ label:'Seize Complete Set', cls:'btn-danger', fn:() => {
        closeModalDirect();
        window._pendingIG = { handIndex };
        updateTargetingBanner();
        renderGame();
        toast('Click an opponent to seize their complete set');
      }});
    } else if (a === 'midnight_requisition') {
      actions.push({ label:'Steal Property', cls:'btn-danger', fn:() => {
        closeModalDirect();
        window._pendingSteal = { handIndex, action:'midnight_requisition' };
        updateTargetingBanner();
        renderGame();
        toast('Click an opponent to steal a property');
      }});
    } else if (a === 'tdy_orders') {
      actions.push({ label:'Swap Properties', cls:'btn-primary', fn:() => {
        closeModalDirect();
        window._pendingSwap = { handIndex, step:'mine' };
        updateTargetingBanner();
        renderGame();
        toast('Click one of YOUR highlighted properties first');
      }});
    } else if (a === 'upgrade') {
      actions.push({ label:'Upgrade a Set', cls:'btn-primary', fn:() => {
        showMySetPicker(true, (color) => {
          send({ type:'play_action', cardIndex:handIndex, targetColor:color });
          selectedHandCard = null; closeModalDirect();
        });
      }});
    } else if (a === 'foc') {
      actions.push({ label:'FOC a Set', cls:'btn-primary', fn:() => {
        showMySetPicker(true, (color) => {
          send({ type:'play_action', cardIndex:handIndex, targetColor:color });
          selectedHandCard = null; closeModalDirect();
        });
      }});
    } else if (a === 'surge_ops') {
      actions.push({ label:'Activate Surge Ops', cls:'btn-primary', fn:() => {
        send({ type:'play_action', cardIndex:handIndex });
        selectedHandCard = null; closeModalDirect();
      }});
    } else if (a === 'chud') {
      actions.push({ label:'Play THE CHUD CARD', cls:'btn-gold', fn:() => {
        closeModalDirect();
        window._pendingSteal = { handIndex, action:'chud' };
        updateTargetingBanner();
        renderGame();
        toast('Click an opponent to commandeer a property!');
      }});
    } else if (a === 'opsec') {
      actions.push({ label:'(Can only counter actions)', cls:'btn-secondary', fn:() => closeModalDirect() });
    }
  }

  if (card.type === 'rent') {
    actions.push({ label:'Charge Rent', cls:'btn-primary', fn:() => {
      const validColors = card.colors[0] === 'any'
        ? Object.keys(S.game.players.find(p=>p.id===myId)?.properties||{}).filter(c =>
            (S.game.players.find(p=>p.id===myId)?.properties[c]||[]).length > 0)
        : card.colors;
      if (validColors.length === 0) {
        toast('You have no properties to charge rent on');
        return;
      }
      showColorPicker(validColors, (color) => {
        send({ type:'play_action', cardIndex:handIndex, targetColor:color });
        selectedHandCard = null; closeModalDirect();
      });
    }});
  }

  actions.push({ label:'Cancel', cls:'btn-secondary', fn:() => { selectedHandCard = null; closeModalDirect(); renderGame(); } });

  showModal(card.name, renderCard(card, 'preview'), actions);
}

/* ── Target property click handlers ──────────────────────────────────── */

window.selectTargetProperty = function(playerId, cardId, color) {
  // During targeting modes, open the detail modal instead of direct action
  if (window._pendingSteal || (window._pendingSwap && window._pendingSwap.step === 'theirs') || window._pendingIG) {
    showOpponentDetail(playerId);
    return;
  }
  if (window._pendingSwap && window._pendingSwap.step === 'mine') return;
};

window.selectMyProperty = function(cardId, color) {
  if (window._pendingSwap && window._pendingSwap.step === 'mine') {
    window._pendingSwap.myCardId = cardId;
    window._pendingSwap.step = 'theirs';
    updateTargetingBanner();
    renderGame();
    toast('Now click an opponent to swap with');
    return;
  }
  // Free rearrange: show move options for wild properties
  const g = S.game;
  if (!g || g.currentPlayerId !== myId || g.turnPhase !== 'play') return;
  const me = g.players.find(p => p.id === myId);
  if (!me) return;
  let card = null, fromColor = null;
  for (const [col, cards] of Object.entries(me.properties)) {
    const c = cards.find(c => c.id === cardId);
    if (c) { card = c; fromColor = col; break; }
  }
  if (!card || card.type !== 'wild_property') return;
  // Build valid target colors
  const validColors = card.colors[0] === 'any'
    ? Object.keys(COLORS).filter(c => c !== fromColor)
    : card.colors.filter(c => c !== fromColor);
  if (validColors.length === 0) return;
  showMoveWildModal(card, fromColor, validColors);
};

function showMoveWildModal(card, fromColor, validColors) {
  const fromInfo = COLORS[fromColor];
  let body = `<p style="font-size:13px;margin-bottom:8px">Move <b>${esc(card.name)}</b> from <span style="color:${fromInfo.bg};font-weight:700">${fromInfo.name}</span> to:</p>`;
  body += '<div class="color-picker">';
  for (const col of validColors) {
    const info = COLORS[col];
    body += `<button class="color-btn" style="background:${info.bg};color:${info.fg}" onclick="doMoveWild(${card.id},'${col}')">${info.name}</button>`;
  }
  body += '</div>';
  showModal('Move Wild Property', body, [
    { label:'Cancel', cls:'btn-secondary', fn:() => closeModalDirect() },
  ]);
}

window.doMoveWild = function(cardId, toColor) {
  send({ type:'move_property', cardId, toColor });
  closeModalDirect();
};

/* ── Emotes ──────────────────────────────────────────────────────────── */

function showEmotePicker() {
  let body = '<div class="emote-grid">';
  EMOTES.forEach(e => {
    body += `<button class="emote-btn" onclick="sendEmote('${e}')">${e}</button>`;
  });
  body += '</div>';
  showModal('Quick Comms', body, [
    { label:'Cancel', cls:'btn-secondary', fn:() => closeModalDirect() },
  ]);
}

function sendEmote(text) {
  send({ type:'emote', text });
  closeModalDirect();
}

function showFloatingEmote(playerId, name, text) {
  const container = $('emote-container');
  if (!container) return;

  // Position near the opponent card or center if it's us
  let x = window.innerWidth / 2, y = window.innerHeight / 3;
  if (playerId !== myId) {
    const oppCard = document.querySelector(`.opp-card[data-pid="${playerId}"]`);
    if (oppCard) {
      const rect = oppCard.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height;
    }
  }

  const el = document.createElement('div');
  el.className = 'floating-emote';
  el.textContent = name + ': ' + text;
  el.style.left = Math.max(10, Math.min(x - 60, window.innerWidth - 160)) + 'px';
  el.style.top = y + 'px';
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ── Response modal (OPSEC / pay / accept) ───────────────────────────── */

function showResponseModal(pa) {
  const g = S.game;
  const source = g.players.find(p => p.id === pa.sourceId);
  const me = g.players.find(p => p.id === myId);

  let title = 'Incoming Action!';
  let body = '';
  const actions = [];

  // Check if we're in an OPSEC chain for payment_all
  const myOpsecChain = pa.type === 'payment_all' && pa.opsecChains?.[myId];
  const amSourceInOpsec = pa.type === 'payment_all' && pa.sourceId === myId
    && Object.values(pa.opsecChains || {}).some(c => c.responderId === myId);

  if (myOpsecChain && myOpsecChain.responderId === myId) {
    // I played OPSEC but source countered — I need to accept or counter again
    const actionLabel = pa.action?.replace(/_/g,' ') || 'an action';
    title = 'OPSEC Countered!';
    body = `<p>${source?.name||'?'} countered your OPSEC! Their <strong>${actionLabel}</strong> will go through.</p>`;
    body += `<p style="color:#889;font-size:12px;margin-top:6px">Accept to pay, or play another OPSEC to block it again.</p>`;
    actions.push({ label:'Accept', cls:'btn-secondary', fn:() => {
      send({ type:'respond', response:'accept' });
      _responseModalOpen = false;
      closeModalDirect();
    }});
  } else if (amSourceInOpsec) {
    // I'm the source and someone played OPSEC against me
    const blockerIds = Object.entries(pa.opsecChains || {}).filter(([pid, c]) => c.responderId === myId).map(([pid]) => pid);
    const blocker = g.players.find(p => p.id === blockerIds[0]);
    const actionLabel = pa.action?.replace(/_/g,' ') || 'an action';
    title = 'Your Action Was Blocked!';
    body = `<p>${blocker?.name||'?'} played <strong>OPSEC</strong> to block your <strong>${actionLabel}</strong>.</p>`;
    body += `<p style="color:#889;font-size:12px;margin-top:6px">Accept to let it be blocked for them, or play your own OPSEC to counter.</p>`;
    actions.push({ label:'Accept', cls:'btn-secondary', fn:() => {
      send({ type:'respond', response:'accept' });
      _responseModalOpen = false;
      closeModalDirect();
    }});
  } else if ((pa.type === 'payment' || pa.type === 'payment_all') && (pa.pending?.includes(myId) || pa.responderId === myId)) {
    // Normal payment flow — I need to pay
    title = 'Pay ' + pa.amount + 'M to ' + (source?.name||'?');
    body = '<p>Select cards from your bank and properties to pay with.</p>';
    body += '<div class="pay-total" id="pay-total">Selected: 0M / ' + pa.amount + 'M</div>';
    body += '<div class="card-row">' + me.bank.map(c =>
      `<div class="card money" style="width:80px;min-height:60px" onclick="togglePayCard(this,${c.id},${c.value})">
        <div class="card-name" style="font-size:16px">${c.value}M</div>
      </div>`).join('') + '</div>';
    for (const [color, cards] of Object.entries(me.properties)) {
      const info = COLORS[color];
      if (!info || !cards || cards.length === 0) continue;
      body += `<div style="margin-top:8px"><span style="display:inline-flex;align-items:center;gap:4px;margin-bottom:4px"><span style="width:10px;height:10px;border-radius:3px;background:${info.bg};display:inline-block;flex-shrink:0"></span><small style="color:${info.bg};font-weight:700">${info.name}</small></span><div style="display:flex;flex-wrap:wrap;gap:4px">`;
      body += cards.map(c =>
        `<span class="prop-mini" style="border-left:3px solid ${info.bg}" onclick="togglePayCard(this,${c.id},${c.value})">${esc(c.name)} (${c.value}M)</span>`
      ).join('');
      body += '</div></div>';
    }
    window._paySelection = [];
    window._payTotal = 0;
    window._payRequired = pa.amount;
    actions.push({ label:'Pay', cls:'btn-primary', fn:() => {
      send({ type:'respond', response:'accept', paymentCards:window._paySelection });
      _responseModalOpen = false;
      closeModalDirect();
    }});
  } else {
    // Non-payment actions (steal, swap, etc.) — original logic
    const actionLabel = pa.action?.replace(/_/g,' ') || 'an action';
    const opsecChain = pa._opsecChain || 0;
    if (opsecChain > 0 && pa.responderId === pa.sourceId) {
      title = 'Your Action Was Blocked!';
      body = `<p>Your opponent played <strong>OPSEC</strong> to block your <strong>${actionLabel}</strong>.</p>`;
      body += `<p style="color:#889;font-size:12px;margin-top:6px">Accept to let it be blocked, or play your own OPSEC to counter back.</p>`;
    } else if (opsecChain > 0) {
      title = 'OPSEC Countered!';
      body = `<p>${source?.name||'?'} countered your OPSEC! Their <strong>${actionLabel}</strong> will go through.</p>`;
      body += `<p style="color:#889;font-size:12px;margin-top:6px">Accept to let it happen, or play another OPSEC to block it again.</p>`;
    } else {
      body = `<p>${source?.name||'?'} is targeting you with <strong>${actionLabel}</strong>!</p>`;
    }
    actions.push({ label:'Accept', cls:'btn-secondary', fn:() => {
      send({ type:'respond', response:'accept' });
      _responseModalOpen = false;
      closeModalDirect();
    }});
  }

  const hasOpsec = (me.hand||[]).some(c => c.action === 'opsec');
  if (hasOpsec) {
    actions.unshift({ label:'Play OPSEC!', cls:'btn-danger', fn:() => {
      send({ type:'respond', response:'opsec' });
      _responseModalOpen = false;
      closeModalDirect();
    }});
  }

  // Add response timer bar if active
  if (S.responseTimer) {
    body = `<div class="response-timer-modal" id="response-timer-modal">
      <div class="response-timer-label">Response time: <span id="response-countdown"></span></div>
      <div class="response-timer-track"><div class="response-timer-bar-fill" id="response-bar-fill"></div></div>
    </div>` + body;
  }

  showModal(title, body, actions);
  // Hide X button — response modals must be answered
  const closeBtn = document.querySelector('.modal-close');
  if (closeBtn) closeBtn.style.display = 'none';

  // Update the in-modal countdown
  if (S.responseTimer) updateModalResponseTimer();
}

window.togglePayCard = function(el, cardId, value) {
  if (!window._paySelection) window._paySelection = [];
  const idx = window._paySelection.indexOf(cardId);
  if (idx >= 0) {
    window._paySelection.splice(idx, 1);
    el.classList.remove('selected');
    window._payTotal = (window._payTotal || 0) - (value || 0);
  } else {
    window._paySelection.push(cardId);
    el.classList.add('selected');
    window._payTotal = (window._payTotal || 0) + (value || 0);
  }
  const totalEl = $('pay-total');
  if (totalEl) {
    const t = window._payTotal || 0;
    const req = window._payRequired || 0;
    const color = t >= req ? '#4caf50' : 'var(--af-gold)';
    totalEl.innerHTML = `Selected: <span style="color:${color}">${t}M</span> / ${req}M`;
  }
};

function showPaymentModal(amount) {
  const g = S.game;
  const pa = g.pendingAction;
  if (!pa) return;
  _responseModalOpen = true;
  showResponseModal(pa);
}

function showDiscardModal(excess) {
  const g = S.game;
  const me = g.players.find(p => p.id === myId);
  window._discardSelection = [];
  window._discardNeeded = excess;

  let body = `<p>You have too many cards. Discard ${excess} card(s).</p>`;
  body += `<div class="pay-total" id="discard-sel-count">Selected: 0 / ${excess}</div>`;
  body += '<div class="card-row">' + (me.hand||[]).map(c =>
    `<div class="card action-card" style="width:90px;min-height:80px" onclick="toggleDiscard(this,${c.id})">
      <div class="card-name" style="font-size:11px">${esc(c.name)}</div>
      <div class="card-value">${c.value}M</div>
    </div>`
  ).join('') + '</div>';

  showModal('Discard Cards', body, [
    { label:'Discard Selected', cls:'btn-primary', fn:() => {
      send({ type:'end_turn', discardIds:window._discardSelection });
      closeModalDirect();
    }},
  ]);
}

window.toggleDiscard = function(el, cardId) {
  if (!window._discardSelection) window._discardSelection = [];
  const idx = window._discardSelection.indexOf(cardId);
  if (idx >= 0) { window._discardSelection.splice(idx, 1); el.classList.remove('selected'); }
  else { window._discardSelection.push(cardId); el.classList.add('selected'); }
  const selEl = $('discard-sel-count');
  if (selEl) {
    const n = window._discardSelection.length;
    const need = window._discardNeeded || 0;
    const color = n >= need ? '#4caf50' : 'var(--af-gold)';
    selEl.innerHTML = `Selected: <span style="color:${color}">${n}</span> / ${need}`;
  }
};

/* ── Pickers ─────────────────────────────────────────────────────────── */

function showTargetPicker(callback) {
  const opps = S.game.players.filter(p => p.id !== myId && !p.eliminated);
  let body = '<div class="target-list">' + opps.map(p =>
    `<button class="target-btn" onclick="window._pickerCb('${p.id}')">${esc(p.name)} (Bank: ${bankTotal(p)}M, Worth: ${netWorth(p)}M)</button>`
  ).join('') + '</div>';
  window._pickerCb = (id) => { callback(id); closeModalDirect(); };
  showModal('Choose Target', body, [
    { label:'Cancel', cls:'btn-secondary', fn:() => { selectedHandCard=null; closeModalDirect(); renderGame(); } },
  ]);
}

function showTargetSetPicker(callback) {
  const opps = S.game.players.filter(p => p.id !== myId);
  let body = '';
  opps.forEach(p => {
    for (const [color, cards] of Object.entries(p.properties)) {
      const info = COLORS[color];
      if (!info || !cards) continue;
      if (cards.length >= info.size) {
        body += `<button class="target-btn" onclick="window._pickerCb('${p.id}','${color}')">
          ${esc(p.name)}'s ${info.name} (${cards.length}/${info.size}) \u2605 COMPLETE</button>`;
      }
    }
  });
  if (!body) body = '<p style="color:#889">No opponents have complete sets.</p>';
  window._pickerCb = (id, color) => { callback(id, color); closeModalDirect(); };
  showModal('Choose a Complete Set to Seize', body, [
    { label:'Cancel', cls:'btn-secondary', fn:() => { selectedHandCard=null; closeModalDirect(); renderGame(); } },
  ]);
}

function showColorPicker(validColors, callback) {
  const allColors = validColors[0] === 'any'
    ? Object.keys(COLORS)
    : validColors;
  let body = '<div style="display:flex;flex-wrap:wrap;gap:4px">';
  allColors.forEach(c => {
    const info = COLORS[c];
    if (info) {
      body += `<span class="color-btn" style="background:${info.bg};color:${info.fg}"
        onclick="window._colorCb('${c}')">${info.name}</span>`;
    }
  });
  body += '</div>';
  window._colorCb = (c) => { callback(c); closeModalDirect(); };
  showModal('Choose Color', body, [
    { label:'Cancel', cls:'btn-secondary', fn:() => { selectedHandCard=null; closeModalDirect(); renderGame(); } },
  ]);
}

function showMySetPicker(requireComplete, callback) {
  const me = S.game.players.find(p => p.id === myId);
  let body = '';
  for (const [color, cards] of Object.entries(me.properties)) {
    const info = COLORS[color];
    if (!info || !cards || cards.length === 0) continue;
    const complete = cards.length >= info.size;
    if (requireComplete && !complete) continue;
    body += `<button class="target-btn" onclick="window._pickerCb('${color}')">
      ${info.name} (${cards.length}/${info.size}) ${complete?'\u2605 COMPLETE':''}</button>`;
  }
  if (!body) body = '<p style="color:#889">No eligible sets.</p>';
  window._pickerCb = (c) => { callback(c); closeModalDirect(); };
  showModal('Choose Your Set', body, [
    { label:'Cancel', cls:'btn-secondary', fn:() => { selectedHandCard=null; closeModalDirect(); renderGame(); } },
  ]);
}

/* ── Game actions ────────────────────────────────────────────────────── */

function doDraw() { send({ type:'draw' }); }

function doEndTurn() {
  const g = S.game;
  if (!g) return;
  // Confirm if plays remain
  if (g.playsRemaining > 0 && g.turnPhase === 'play') {
    showModal('End Turn?', `<p>You still have <strong>${g.playsRemaining}</strong> play(s) remaining. End turn anyway?</p>`, [
      { label:'End Turn', cls:'btn-primary', fn:() => { send({ type:'end_turn' }); closeModalDirect(); } },
      { label:'Keep Playing', cls:'btn-secondary', fn:() => closeModalDirect() },
    ]);
    return;
  }
  send({ type:'end_turn' });
}

/* ── Help / Rules ────────────────────────────────────────────────────── */

function showHelpModal() {
  const body = `<div class="help-content">
    <h4>OBJECTIVE</h4>
    <p>Be the first to collect <strong>3 complete property sets</strong>.</p>

    <h4>YOUR TURN</h4>
    <p>1. <strong>Draw</strong> 2 cards (5 if your hand is empty)</p>
    <p>2. Play up to <strong>3 cards</strong> — properties, money to bank, or actions</p>
    <p>3. <strong>End turn</strong> — discard down to 7 cards if needed</p>
    <p>Any card can be banked as money (face value).</p>

    <h4>CARD TYPES</h4>
    <p><span class="help-card-type" style="background:#2a5a2a;color:#fff">FUNDS</span> Money — goes straight to your bank</p>
    <p><span class="help-card-type" style="background:#8B4513;color:#fff">PROPERTY</span> Collect sets to win. Set sizes vary (2-4 cards).</p>
    <p><span class="help-card-type" style="background:#666;color:#fff">WILD</span> Wild property — place on any matching color set</p>
    <p><span class="help-card-type" style="background:#6a2a8a;color:#fff">RENT</span> Charge all players rent based on your properties</p>
    <p><span class="help-card-type" style="background:#2a2a6a;color:#fff">ACTION</span> Special actions (see below)</p>
    <p><span class="help-card-type" style="background:#FFD700;color:#000">CHUD</span> Steal ANY property + collect 2M!</p>

    <h4>ACTION CARDS</h4>
    <p><strong>PCS Orders</strong> — Draw 2 extra cards</p>
    <p><strong>Finance Office</strong> — Collect 5M from one player</p>
    <p><strong>Roll Call</strong> — All others pay you 2M each</p>
    <p><strong>Midnight Requisition</strong> — Steal 1 property (not from complete set)</p>
    <p><strong>TDY Orders</strong> — Swap a property with another player</p>
    <p><strong>Inspector General</strong> — Seize an entire complete set!</p>
    <p><strong>Upgrade / FOC</strong> — Add +3M / +4M rent to a complete set</p>
    <p><strong>Surge Ops</strong> — Double your next rent charge</p>
    <p><strong>OPSEC</strong> — Counter ANY action played against you</p>

    <h4>THE CHUD CARD</h4>
    <p>Commandeer Hardware Under Directive — steal ANY property (even from complete sets) and collect 2M. Can be countered with OPSEC.</p>
  </div>`;
  showModal('Rules — Quick Reference', body, [
    { label:'Got It', cls:'btn-primary', fn:() => closeModalDirect() },
  ]);
}

/* ── Modal system ────────────────────────────────────────────────────── */

function showModal(title, bodyHTML, actions) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHTML;
  const actEl = $('modal-actions');
  actEl.innerHTML = '';
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.className = a.cls || 'btn-secondary';
    btn.onclick = a.fn;
    actEl.appendChild(btn);
  });
  // Restore X button visibility (response modals hide it separately)
  const closeBtn = document.querySelector('.modal-close');
  if (closeBtn) closeBtn.style.display = '';
  $('modal-overlay').style.display = 'flex';
}

function closeModal(e) {
  if (e && e.target !== $('modal-overlay')) return;
  // Don't allow closing response modals by clicking outside
  if (S.game?.pendingAction?.responderId === myId) return;
  closeModalDirect();
}

function closeModalDirect() {
  $('modal-overlay').style.display = 'none';
  _responseModalOpen = false;
}

/* ── Utilities ───────────────────────────────────────────────────────── */

function $(id) { return document.getElementById(id); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

function bankTotal(player) {
  return (player.bank||[]).reduce((s,c) => s + c.value, 0);
}

function netWorth(player) {
  let total = bankTotal(player);
  for (const cards of Object.values(player.properties || {})) {
    if (cards) cards.forEach(c => total += c.value);
  }
  return total;
}

function updateTimerDisplay() {
  const el = $('hdr-timer');
  if (!el || !S.turnTimer) { if (el) el.style.display = 'none'; return; }
  const elapsed = (Date.now() - S.turnTimer.startedAt) / 1000;
  const remaining = Math.max(0, Math.ceil(S.turnTimer.timeout - elapsed));
  el.textContent = remaining + 's';
  el.classList.toggle('warning', remaining <= 10);
  el.classList.remove('response-active');
  if (remaining <= 5 && remaining > 0 && !_alarmPlayed) {
    _alarmPlayed = true;
    sfx('alarm');
  }
  if (remaining <= 0) { el.textContent = '0s'; }
  if (remaining > 5) _alarmPlayed = false;
}

function updateResponseTimerDisplay() {
  const el = $('hdr-timer');
  if (!el || !S.responseTimer) { if (el) el.style.display = 'none'; return; }
  const elapsed = (Date.now() - S.responseTimer.startedAt) / 1000;
  const remaining = Math.max(0, Math.ceil(S.responseTimer.timeout - elapsed));
  el.textContent = '\u23F1 ' + remaining + 's';
  el.classList.toggle('warning', remaining <= 10);
  el.classList.add('response-active');
  if (remaining <= 5 && remaining > 0 && !_responseAlarmPlayed) {
    _responseAlarmPlayed = true;
    sfx('alarm');
  }
  if (remaining <= 0) { el.textContent = '\u23F1 0s'; }
  if (remaining > 5) _responseAlarmPlayed = false;
}

function updateModalResponseTimer() {
  const countdown = $('response-countdown');
  const barFill = $('response-bar-fill');
  if (!countdown || !barFill || !S.responseTimer) return;
  const update = () => {
    if (!S.responseTimer) return;
    const elapsed = (Date.now() - S.responseTimer.startedAt) / 1000;
    const remaining = Math.max(0, Math.ceil(S.responseTimer.timeout - elapsed));
    const pct = Math.max(0, (1 - elapsed / S.responseTimer.timeout) * 100);
    countdown.textContent = remaining + 's';
    countdown.style.color = remaining <= 5 ? '#f44' : '#ff9800';
    barFill.style.width = pct + '%';
    barFill.style.background = remaining <= 5 ? '#f44' : '#ff9800';
  };
  update();
  const iv = setInterval(() => {
    if (!$('response-countdown')) { clearInterval(iv); return; }
    update();
  }, 500);
}

function showTurnPopup() {
  const el = $('turn-popup');
  if (!el) return;
  const sub = $('turn-popup-sub');
  if (sub) sub.textContent = 'Commander ' + myName;
  el.style.display = 'flex';
  el.style.animation = 'none';
  el.offsetHeight; // force reflow
  el.style.animation = 'turnPopIn 0.3s ease-out, turnPopOut 0.4s ease-in 1.8s forwards';
  setTimeout(() => { el.style.display = 'none'; }, 2200);
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Leave / Home ───────────────────────────────────────────────────── */

function confirmScoop() {
  showModal('Scoop?', '<p>This will discard ALL your cards (hand, bank, and properties) and remove you from the game. This cannot be undone!</p>', [
    { label:'Scoop — I\'m Out', cls:'btn-danger', fn:() => { send({ type:'scoop' }); closeModalDirect(); } },
    { label:'Cancel', cls:'btn-secondary', fn:closeModalDirect },
  ]);
}

function leaveGame() {
  // Don't allow leaving while you need to respond to an action
  if (S.game?.pendingAction?.responderId === myId) {
    toast('Respond to the action first');
    return;
  }
  const inGame = S.phase === 'playing';
  if (inGame) {
    showModal('Leave Game?', '<p>You can rejoin with the same name and room code.</p>', [
      { label:'Leave', cls:'btn-danger', fn:doLeave },
      { label:'Cancel', cls:'btn-secondary', fn:closeModalDirect },
    ]);
  } else {
    doLeave();
  }
}

function leaveLobby() { doLeave(); }

function doLeave() {
  closeModalDirect();
  send({ type:'leave_room' });
  // Close old WebSocket without triggering auto-reconnect
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
  try { sessionStorage.removeItem('chud_pid'); sessionStorage.removeItem('chud_room'); } catch {}
  // Pre-fill name input for easy rejoin
  const nameInput = $('player-name');
  if (nameInput && myName) nameInput.value = myName;
  myId = null; roomCode = ''; myName = ''; S = {};
  _chatMsgs = { room:[], global:[] }; _chatUnread = { room:0, global:0 };
  _lastTurnPlayerId = null; selectedHandCard = null;
  _responseModalOpen = false;
  _prevPlayerBotState = {};
  _alarmPlayed = false; _responseAlarmPlayed = false;
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  if (_responseTimerInterval) { clearInterval(_responseTimerInterval); _responseTimerInterval = null; }
  if (_chatDrawerOpen) toggleChatDrawer();
  $('game-screen').style.display = 'none';
  $('lobby-screen').style.display = 'flex';
  $('lobby-join').style.display = 'flex';
  $('lobby-waiting').style.display = 'none';
  $('winner-overlay').style.display = 'none';
  stopTitleBlink();
}

/* ── GIF Picker ─────────────────────────────────────────────────────── */

let _gifSearchTimer = null;

function fetchConfig() {
  fetch('/api/config').then(r => r.json()).then(cfg => {
    _giphyKey = cfg.giphyKey || '';
    if (_giphyKey) {
      document.querySelectorAll('.btn-gif').forEach(b => b.style.display = '');
    }
  }).catch(() => {});
}

function showGifPicker(from) {
  if (!_giphyKey) { toast('GIF search not configured'); return; }
  _gifPickerFrom = from;
  const body = '<input type="text" id="gif-search-input" class="gif-search-input" placeholder="Search GIFs..." autocomplete="off" oninput="onGifSearch()">' +
    '<div id="gif-grid" class="gif-grid"><p style="color:#889;text-align:center;padding:20px">Loading trending...</p></div>';
  showModal('GIF Search', body, [
    { label:'Cancel', cls:'btn-secondary', fn:closeModalDirect }
  ]);
  searchGifs('');
  setTimeout(() => $('gif-search-input')?.focus(), 100);
}

window.onGifSearch = function() {
  clearTimeout(_gifSearchTimer);
  const q = $('gif-search-input')?.value?.trim() || '';
  _gifSearchTimer = setTimeout(() => searchGifs(q), 400);
};

function searchGifs(query) {
  const endpoint = query
    ? 'https://api.giphy.com/v1/gifs/search?api_key=' + _giphyKey + '&q=' + encodeURIComponent(query) + '&limit=20&rating=pg-13'
    : 'https://api.giphy.com/v1/gifs/trending?api_key=' + _giphyKey + '&limit=20&rating=pg-13';
  const grid = $('gif-grid');
  if (grid) grid.innerHTML = '<p style="color:#889;text-align:center;padding:20px">Searching...</p>';
  fetch(endpoint).then(r => r.json()).then(data => {
    if (!grid) return;
    if (!data.data || data.data.length === 0) {
      grid.innerHTML = '<p style="color:#889;text-align:center;padding:20px">No GIFs found</p>';
      return;
    }
    grid.innerHTML = data.data.map(g => {
      const preview = g.images?.fixed_height_small?.url || g.images?.fixed_height?.url || '';
      const full = g.images?.fixed_height?.url || preview;
      return '<img class="gif-item" src="' + esc(preview) + '" alt="' + esc(g.title||'gif') + '" loading="lazy" onclick="selectGif(\'' + esc(full) + '\')">';
    }).join('');
  }).catch(() => {
    if (grid) grid.innerHTML = '<p style="color:#889;text-align:center;padding:20px">Failed to load GIFs</p>';
  });
}

window.selectGif = function(url) {
  closeModalDirect();
  send({ type:'chat', text:url, scope:_chatScope });
};

/* ── Chat ───────────────────────────────────────────────────────────── */

const IMG_RE = /https?:\/\/\S+\.(?:gif|png|jpg|jpeg|webp)(?:\?\S*)?/gi;
const MEDIA_RE = /https?:\/\/(?:media\d*\.)?(?:tenor|giphy)\.com\/\S+/gi;

function chatHTML(text) {
  let safe = esc(text);
  // Replace image URLs with inline img tags
  safe = safe.replace(IMG_RE, url =>
    '<a href="' + url + '" target="_blank" rel="noopener"><img class="chat-img" src="' + url + '" loading="lazy" onerror="this.style.display=\'none\'" alt="image"></a>'
  );
  // Tenor/Giphy CDN links that may lack file extension
  safe = safe.replace(MEDIA_RE, url => {
    if (/\.(?:gif|png|jpg|jpeg|webp)/i.test(url)) return url; // already handled
    return '<a href="' + url + '" target="_blank" rel="noopener"><img class="chat-img" src="' + url + '" loading="lazy" onerror="this.parentNode.replaceChild(document.createTextNode(\'' + url + '\'),this)" alt="gif"></a>';
  });
  return safe;
}

function renderChatMsgs(containerId) {
  const el = $(containerId);
  if (!el) return;
  const msgs = _chatMsgs[_chatScope] || [];
  el.innerHTML = msgs.map(m => {
    const time = new Date(m.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const me = m.pid === myId ? ' chat-me' : '';
    return '<div class="chat-msg' + me + '">' +
      '<span class="chat-time">' + time + '</span>' +
      '<span class="chat-name">' + esc(m.name) + '</span>' +
      '<span class="chat-text">' + chatHTML(m.text) + '</span>' +
    '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function renderAllChatContainers() {
  renderChatMsgs('lobby-chat-msgs');
  renderChatMsgs('game-chat-msgs');
  renderChatMsgs('drawer-chat-msgs');
  updateChatUnread();
}

function switchChatTab(scope) {
  _chatScope = scope;
  _chatUnread[scope] = 0;
  document.querySelectorAll('.chat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.scope === scope);
  });
  renderAllChatContainers();
}

function sendChat(from) {
  const inputId = from === 'lobby' ? 'lobby-chat-input'
    : from === 'drawer' ? 'drawer-chat-input'
    : 'game-chat-input';
  const input = $(inputId);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  send({ type:'chat', text, scope:_chatScope });
  input.value = '';
  input.focus();
}

function toggleChatDrawer() {
  _chatDrawerOpen = !_chatDrawerOpen;
  const el = $('chat-drawer');
  if (!el) return;
  el.style.display = _chatDrawerOpen ? 'flex' : 'none';
  if (!_chatDrawerOpen) el.style.bottom = '0';
  if (_chatDrawerOpen) {
    _chatUnread[_chatScope] = 0;
    renderChatMsgs('drawer-chat-msgs');
    updateChatUnread();
    const inp = $('drawer-chat-input');
    if (inp) inp.focus();
  }
}

function updateChatUnread() {
  const badges = [
    ['lobby-unread-global', _chatUnread.global],
    ['game-unread-room', _chatUnread.room],
    ['game-unread-global', _chatUnread.global],
    ['drawer-unread-room', _chatUnread.room],
    ['drawer-unread-global', _chatUnread.global],
  ];
  badges.forEach(([id, count]) => {
    const el = $(id);
    if (!el) return;
    el.textContent = count > 99 ? '99+' : count;
    el.style.display = count > 0 ? 'inline-block' : 'none';
  });
  const total = _chatUnread.room + _chatUnread.global;
  const badge = $('chat-badge');
  if (badge) {
    badge.textContent = total > 99 ? '99+' : total;
    badge.style.display = total > 0 ? 'inline-block' : 'none';
  }
}

function isChatVisible() {
  if (_chatDrawerOpen) return true;
  const gc = $('game-chat-msgs');
  const lc = $('lobby-chat-msgs');
  if (gc && gc.offsetParent !== null) return true;
  if (lc && lc.offsetParent !== null) return true;
  return false;
}

/* ── Init ────────────────────────────────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (_chatDrawerOpen) { toggleChatDrawer(); return; }
    if (window._pendingSteal || window._pendingSwap || window._pendingIG) {
      cancelTargeting();
    } else if (!(S.game?.pendingAction?.responderId === myId)) {
      closeModalDirect();
    }
  }
});

// Resume AudioContext on first interaction (browser requirement)
document.addEventListener('click', () => {
  if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
}, { once: true });

// Auto-focus name input + fetch config
window.addEventListener('load', () => {
  $('player-name')?.focus();
  fetchConfig();
});

// Mobile keyboard: adjust chat drawer position when virtual keyboard opens
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const drawer = $('chat-drawer');
    const lobbyChat = $('lobby-chat');
    const kbOffset = window.innerHeight - window.visualViewport.height;
    if (drawer && drawer.style.display !== 'none') {
      drawer.style.bottom = kbOffset + 'px';
    }
    if (lobbyChat && lobbyChat.style.display !== 'none') {
      lobbyChat.style.paddingBottom = kbOffset > 0 ? kbOffset + 'px' : '';
    }
  });
}
