// js/state.js — Game state globals, state handler, tab notifications, leave/reset

var S = {};
var myId = null;
var myName = '';
var roomCode = '';
var _lastTurnPlayerId = null;
var _tabFocused = true;
var _titleInterval = null;
var _originalTitle = document.title;
var _dealInCount = 0;
var _prevPlayerBotState = {};

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

/* ── State handler ───────────────────────────────────────────────────── */

function handleState(msg) {
  const prevState = S;
  S = msg;

  if (S.game) {
    const isMyTurn = S.game.currentPlayerId === myId;

    if (isMyTurn && _lastTurnPlayerId !== myId) {
      sfx('turn');
      if (!_tabFocused) startTitleBlink();
      showTurnPopup();
    }
    if (_tabFocused && isMyTurn) stopTitleBlink();
    _lastTurnPlayerId = S.game.currentPlayerId;

    if (prevState.game && S.game.log.length > prevState.game.log.length) {
      const newLogs = S.game.log.slice(prevState.game.log.length);
      for (const l of newLogs) {
        if (l.includes('CHUD')) sfx('chud');
        else if (l.includes('plays OPSEC') || l.includes('counters OPSEC')) { sfx('opsec'); toast(l); }
        else if (l.includes('blocked by OPSEC')) { sfx('blocked'); toast(l); }
        else if (l.includes('charges') && l.includes('rent')) sfx('rent');
        else if (l.includes('drew')) {
          sfx('draw');
          const m = l.match(/drew (\d+)/);
          if (m) _dealInCount = parseInt(m[1]);
        }
        else if (l.includes('banked')) sfx('bank');
        else if (l.includes('wins with') || l.includes('wins \u2014')) sfx('siren');
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

    const meState = S.game.players.find(p => p.id === myId);
    if (isMyTurn && S.game.turnPhase === 'draw' && !meState?.eliminated) {
      setTimeout(() => doDraw(), 300);
    }

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

/* ── Leave / Home ───────────────────────────────────────────────────── */

function confirmScoop() {
  showModal('Scoop?', '<p>This will discard ALL your cards (hand, bank, and properties) and remove you from the game. This cannot be undone!</p>', [
    { label:'Scoop \u2014 I\'m Out', cls:'btn-danger', fn:() => { send({ type:'scoop' }); closeModalDirect(); } },
    { label:'Cancel', cls:'btn-secondary', fn:closeModalDirect },
  ]);
}

function leaveGame() {
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
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
  try { sessionStorage.removeItem('chud_pid'); sessionStorage.removeItem('chud_room'); } catch {}
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
