// js/lobby.js — Lobby, room creation, bot management

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

function quickPlay() {
  const name = $('player-name').value.trim() || 'Maverick';
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  $('btn-quick-play').disabled = true;
  connect(() => {
    send({ type:'quick_play', name });
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
    $('btn-quick-play').disabled = false;
  });
}

function joinRoom() {
  const name = $('player-name').value.trim() || 'Goose';
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!code) { toast('Enter a room code'); return; }
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  connect(() => {
    const savedCode = tryGet('chud_room');
    const savedPlayerId = tryGet('chud_pid');
    const savedResumeToken = tryGet('chud_resume');
    const credentials = savedCode === code && savedPlayerId && savedResumeToken
      ? { playerId:savedPlayerId, resumeToken:savedResumeToken }
      : {};
    send({ type:'join_room', code, name, ...credentials });
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
  });
}

function shareRoom() {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  const text = url.toString();
  if (navigator.share) {
    navigator.share({ title:'Join Chudopoly GO', text:'Join my Chudopoly room ' + roomCode, url:text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('Invite link copied')).catch(() => toast(text));
  } else {
    toast(text);
  }
}

function requestRematch() { send({ type:'rematch' }); }

function startGame() {
  const timeout = parseInt($('turn-timeout')?.value) || 0;
  const responseTimeout = parseInt($('response-timeout')?.value) || 0;
  send({ type:'start_game', turnTimeout: timeout, responseTimeout: responseTimeout });
}

function showBotModePicker() {
  let body = '<p style="font-size:12px;color:#889;margin-bottom:8px">Choose bot personality:</p>';
  body += '<div class="bot-mode-grid">';
  for (const [mode, info] of Object.entries(BOT_MODES)) {
    body += `<button class="bot-mode-btn" data-action="add-bot" data-mode="${mode}">
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

function kickPlayer(targetId) { send({ type:'kick', targetId }); }

function showLobbyWaiting() {
  $('lobby-join').style.display = 'none';
  $('lobby-waiting').style.display = 'flex';
  $('room-code-display').textContent = roomCode;
  const lc = $('lobby-chat');
  if (lc) lc.style.display = 'flex';
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
        ? `<button class="remove-bot-btn" data-action="remove-bot" data-player-id="${p.id}">Remove</button>`
        : `<button class="kick-btn" data-action="kick-player" data-player-id="${p.id}">Kick</button>`)
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
