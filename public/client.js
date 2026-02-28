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

let ws, S = {}, myId = null, myName = '', roomCode = '';
let selectedHandCard = null;
let modalCallback = null;

/* ── WebSocket ───────────────────────────────────────────────────────── */

function connect() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = () => resolve();
    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      reject(err);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'joined':
          myId = msg.playerId;
          myName = msg.name;
          roomCode = msg.code;
          showLobbyWaiting();
          break;
        case 'state':
          handleState(msg);
          break;
        case 'error':
          toast(msg.message);
          if (msg.needDiscard) showDiscardModal(msg.excess);
          if (msg.needPayment) showPaymentModal(msg.amount);
          break;
        case 'need_payment':
          showPaymentModal(msg.amount);
          break;
      }
    };
    ws.onclose = () => {
      if (myId) setTimeout(() => connect().catch(() => {}), 2000);
    };
  });
}

function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

/* ── Lobby ───────────────────────────────────────────────────────────── */

function createRoom() {
  const name = $('player-name').value.trim() || 'Maverick';
  connect().then(() => {
    send({ type:'create_room', name });
  }).catch(() => {
    toast('Failed to connect to server. Try again.');
  });
}

function joinRoom() {
  const name = $('player-name').value.trim() || 'Goose';
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!code) { toast('Enter a room code'); return; }
  connect().then(() => {
    send({ type:'join_room', code, name });
  }).catch(() => {
    toast('Failed to connect to server. Try again.');
  });
}

function startGame() { send({ type:'start_game' }); }

function showLobbyWaiting() {
  $('lobby-join').style.display = 'none';
  $('lobby-waiting').style.display = 'flex';
  $('room-code-display').textContent = roomCode;
}

/* ── State handler ───────────────────────────────────────────────────── */

function handleState(msg) {
  S = msg;
  if (msg.phase === 'lobby') {
    renderLobby();
  } else if (msg.game) {
    $('lobby-screen').style.display = 'none';
    $('game-screen').style.display = 'flex';
    renderGame();
  }
}

function renderLobby() {
  const list = $('player-list');
  list.innerHTML = S.players.map(p =>
    `<div class="player-item">
      <span class="dot ${p.connected?'':'off'}"></span>
      <span>${esc(p.name)}</span>
      ${p.id===myId?'<span class="you">YOU</span>':''}
    </div>`
  ).join('');
  $('btn-start').style.display = S.hostId === myId ? 'block' : 'none';
  $('waiting-msg').style.display = S.hostId === myId ? 'none' : 'block';
}

/* ── Game rendering ──────────────────────────────────────────────────── */

function renderGame() {
  const g = S.game;
  if (!g) return;
  const me = g.players.find(p => p.id === myId);
  const isMyTurn = g.currentPlayerId === myId;
  const amResponder = g.pendingAction?.responderId === myId;

  // Header
  $('hdr-room').textContent = 'ROOM ' + S.code;
  const cp = g.players.find(p => p.id === g.currentPlayerId);
  $('hdr-turn').textContent = cp ? (cp.id === myId ? 'YOUR TURN' : cp.name + "'s turn") : '';
  $('hdr-phase').textContent = g.turnPhase.replace('_',' ').toUpperCase();
  $('hdr-plays').textContent = isMyTurn ? g.playsRemaining + ' plays left' : '';
  $('hdr-deck').textContent = 'Deck: ' + g.deckCount;
  if (g.surgeOps && isMyTurn) $('hdr-plays').textContent += ' | SURGE OPS ACTIVE';

  // Buttons
  $('btn-draw').disabled = !(isMyTurn && g.turnPhase === 'draw');
  $('btn-end-turn').disabled = !(isMyTurn && g.turnPhase === 'play');

  // Opponents
  const opps = g.players.filter(p => p.id !== myId);
  $('opponents').innerHTML = opps.map(p => {
    const isTurn = p.id === g.currentPlayerId;
    const isResp = g.pendingAction?.responderId === p.id;
    return `<div class="opp-card ${isTurn?'active-turn':''} ${isResp?'responding':''}">
      <div class="opp-name">${esc(p.name)} <span class="sets">${p.completedSets}/3 sets</span></div>
      <div class="opp-stats">
        <span>Hand: ${p.handCount}</span>
        <span>Bank: ${bankTotal(p)}M</span>
      </div>
      <div class="opp-props">${renderMiniProps(p)}</div>
    </div>`;
  }).join('');

  // My bank
  $('my-bank-total').textContent = '(' + bankTotal(me) + 'M)';
  $('my-bank').innerHTML = me.bank.map(c => renderCard(c, 'bank')).join('');

  // My properties
  $('my-properties').innerHTML = renderPropertySets(me);

  // My hand
  $('my-hand').innerHTML = (me.hand || []).map((c,i) => renderCard(c, 'hand', i)).join('');

  // Log
  $('game-log').innerHTML = g.log.map(l => {
    const cls = l.includes('CHUD') ? 'log-chud' : '';
    return `<div class="${cls}">${esc(l)}</div>`;
  }).join('');
  const logEl = $('game-log');
  logEl.scrollTop = logEl.scrollHeight;

  // Pending action — show response modal
  if (amResponder && g.pendingAction && !document.querySelector('.modal-overlay[style*="flex"]')) {
    showResponseModal(g.pendingAction);
  }

  // Winner
  if (g.winner) {
    const winner = g.players.find(p => p.id === g.winner);
    $('winner-name').textContent = winner ? winner.name : '???';
    $('winner-overlay').style.display = 'flex';
  }
}

/* ── Card rendering ──────────────────────────────────────────────────── */

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
    inner = `
      <div class="card-type" style="background:#666">WILD</div>
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-desc">${card.colors[0]==='any'?'Any color':card.colors.join(' / ')}</div>
      <div class="card-value">Value: ${card.value}M</div>`;
  } else if (card.type === 'money') {
    cls += ' money';
    inner = `
      <div class="card-type" style="background:#2a5a2a">FUNDS</div>
      <div class="card-name">${card.value}M</div>`;
  } else if (card.type === 'rent') {
    cls += ' rent-card';
    const colorNames = card.colors.map(c => c === 'any' ? 'ANY' : (COLORS[c]?.name||c)).join(' / ');
    inner = `
      <div class="card-type" style="background:#6a2a8a">RENT</div>
      <div class="card-name">Rent</div>
      <div class="card-desc">${colorNames}</div>
      <div class="card-value">Value: ${card.value}M</div>`;
  } else if (card.action === 'chud') {
    cls += ' chud-card';
    inner = `
      <div class="card-type">&#9733; SPECIAL</div>
      <div class="card-name">THE CHUD CARD</div>
      <div class="card-desc">Commandeer Hardware Under Directive<br><br>Steal ANY property + collect 2M</div>
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
  for (const [color, cards] of Object.entries(player.properties)) {
    const info = COLORS[color];
    if (!info || cards.length === 0) continue;
    const complete = cards.length >= info.size;
    for (const c of cards) {
      html += `<div class="mini-prop ${complete?'complete':''}" style="background:${info.bg};color:${info.fg}"
        title="${esc(c.name)} (${info.name})"
        onclick="selectTargetProperty('${player.id}',${c.id},'${color}')">${cards.length >= info.size ? '★' : ''}</div>`;
    }
  }
  return html || '<span style="font-size:11px;color:#556">No properties</span>';
}

function renderPropertySets(player) {
  let html = '';
  for (const [color, cards] of Object.entries(player.properties)) {
    const info = COLORS[color];
    if (!info || cards.length === 0) continue;
    const complete = cards.length >= info.size;
    const ups = player.upgrades?.[color] || [];
    html += `<div class="prop-set ${complete?'complete':''}">
      <div class="prop-set-header">
        <div class="prop-color-dot" style="background:${info.bg}"></div>
        ${info.name}
        <span class="prop-set-count">${cards.length}/${info.size}</span>
        ${ups.includes('house')?'<span class="prop-set-upgrade">+UPG</span>':''}
        ${ups.includes('hotel')?'<span class="prop-set-upgrade">+FOC</span>':''}
      </div>
      <div class="prop-set-cards">
        ${cards.map(c => `<div class="prop-mini" onclick="selectMyProperty(${c.id},'${color}')">${esc(c.name)}</div>`).join('')}
      </div>
    </div>`;
  }
  return html || '<p style="font-size:12px;color:#556">No properties yet</p>';
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

  renderGame();  // re-render with selection highlight

  // Show action options for selected card
  showCardActionModal(card, idx);
}

function showCardActionModal(card, handIndex) {
  const actions = [];

  // Always can bank any card
  actions.push({ label:'Bank as ' + card.value + 'M', cls:'btn-secondary', fn:() => {
    send({ type:'play_money', cardIndex:handIndex });
    selectedHandCard = null; closeModalDirect();
  }});

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
        showTargetSetPicker((tid, color) => {
          send({ type:'play_action', cardIndex:handIndex, targetId:tid, targetColor:color });
          selectedHandCard = null; closeModalDirect();
        });
      }});
    } else if (a === 'midnight_requisition') {
      actions.push({ label:'Steal Property', cls:'btn-danger', fn:() => {
        toast('Click a property on an opponent to steal it');
        closeModalDirect();
        window._pendingSteal = { handIndex, action:'midnight_requisition' };
      }});
    } else if (a === 'tdy_orders') {
      actions.push({ label:'Swap Properties', cls:'btn-primary', fn:() => {
        toast('Click one of YOUR properties, then an opponent\'s');
        closeModalDirect();
        window._pendingSwap = { handIndex, step:'mine' };
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
        toast('Click ANY property on an opponent to commandeer it!');
        closeModalDirect();
        window._pendingSteal = { handIndex, action:'chud' };
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
  if (window._pendingSteal) {
    const ps = window._pendingSteal;
    send({ type:'play_action', cardIndex:ps.handIndex, targetId:playerId, targetCardId:cardId });
    selectedHandCard = null;
    delete window._pendingSteal;
    return;
  }
  if (window._pendingSwap) {
    const ps = window._pendingSwap;
    if (ps.step === 'mine') return; // wrong target
    send({ type:'play_action', cardIndex:ps.handIndex, targetId:playerId, targetCardId:cardId, myCardId:ps.myCardId });
    selectedHandCard = null;
    delete window._pendingSwap;
    return;
  }
};

window.selectMyProperty = function(cardId, color) {
  if (window._pendingSwap && window._pendingSwap.step === 'mine') {
    window._pendingSwap.myCardId = cardId;
    window._pendingSwap.step = 'theirs';
    toast('Now click an opponent\'s property to swap with');
    return;
  }
};

/* ── Response modal (OPSEC / pay / accept) ───────────────────────────── */

function showResponseModal(pa) {
  const g = S.game;
  const source = g.players.find(p => p.id === pa.sourceId);
  const me = g.players.find(p => p.id === myId);

  let title = 'Incoming Action!';
  let body = '';
  const actions = [];

  if (pa.type === 'payment' || pa.type === 'payment_all') {
    title = 'Pay ' + pa.amount + 'M to ' + (source?.name||'?');
    body = '<p>Select cards from your bank and properties to pay with.</p>';
    body += '<div class="card-row">' + me.bank.map(c =>
      `<div class="card money" style="width:80px;min-height:60px" onclick="togglePayCard(this,${c.id})">
        <div class="card-name" style="font-size:16px">${c.value}M</div>
      </div>`).join('') + '</div>';
    // Also show properties
    for (const [color, cards] of Object.entries(me.properties)) {
      const info = COLORS[color];
      if (!info || cards.length === 0) continue;
      body += `<div style="margin-top:6px"><small style="color:#889">${info.name}:</small> `;
      body += cards.map(c =>
        `<span class="prop-mini" onclick="togglePayCard(this,${c.id})">${esc(c.name)} (${c.value}M)</span>`
      ).join(' ');
      body += '</div>';
    }
    window._paySelection = [];
    actions.push({ label:'Pay', cls:'btn-primary', fn:() => {
      send({ type:'respond', response:'accept', paymentCards:window._paySelection });
      closeModalDirect();
    }});
  } else {
    body = `<p>${source?.name||'?'} is targeting you with <strong>${pa.action?.replace(/_/g,' ')}</strong>!</p>`;
    actions.push({ label:'Accept', cls:'btn-secondary', fn:() => {
      if (pa.type === 'payment' || pa.type === 'payment_all') {
        // Need to show payment UI
        send({ type:'respond', response:'accept', paymentCards:[] });
      } else {
        send({ type:'respond', response:'accept' });
      }
      closeModalDirect();
    }});
  }

  // OPSEC option
  const hasOpsec = (me.hand||[]).some(c => c.action === 'opsec');
  if (hasOpsec) {
    actions.unshift({ label:'Play OPSEC!', cls:'btn-danger', fn:() => {
      send({ type:'respond', response:'opsec' });
      closeModalDirect();
    }});
  }

  showModal(title, body, actions);
}

window.togglePayCard = function(el, cardId) {
  if (!window._paySelection) window._paySelection = [];
  const idx = window._paySelection.indexOf(cardId);
  if (idx >= 0) {
    window._paySelection.splice(idx, 1);
    el.classList.remove('selected');
  } else {
    window._paySelection.push(cardId);
    el.classList.add('selected');
  }
};

function showPaymentModal(amount) {
  const g = S.game;
  const me = g.players.find(p => p.id === myId);
  const pa = g.pendingAction;
  if (!pa) return;
  const source = g.players.find(p => p.id === pa.sourceId);
  showResponseModal(pa);
}

function showDiscardModal(excess) {
  const g = S.game;
  const me = g.players.find(p => p.id === myId);
  window._discardSelection = [];

  let body = `<p>You have too many cards. Discard ${excess} card(s).</p>`;
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
};

/* ── Pickers ─────────────────────────────────────────────────────────── */

function showTargetPicker(callback) {
  const opps = S.game.players.filter(p => p.id !== myId);
  let body = '<div class="target-list">' + opps.map(p =>
    `<button class="target-btn" onclick="window._pickerCb('${p.id}')">${esc(p.name)} (Bank: ${bankTotal(p)}M)</button>`
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
      if (!info) continue;
      if (cards.length >= info.size) {
        body += `<button class="target-btn" onclick="window._pickerCb('${p.id}','${color}')">
          ${esc(p.name)}'s ${info.name} (${cards.length}/${info.size}) ★ COMPLETE</button>`;
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
    if (!info || cards.length === 0) continue;
    const complete = cards.length >= info.size;
    if (requireComplete && !complete) continue;
    body += `<button class="target-btn" onclick="window._pickerCb('${color}')">
      ${info.name} (${cards.length}/${info.size}) ${complete?'★ COMPLETE':''}</button>`;
  }
  if (!body) body = '<p style="color:#889">No eligible sets.</p>';
  window._pickerCb = (c) => { callback(c); closeModalDirect(); };
  showModal('Choose Your Set', body, [
    { label:'Cancel', cls:'btn-secondary', fn:() => { selectedHandCard=null; closeModalDirect(); renderGame(); } },
  ]);
}

/* ── Game actions ────────────────────────────────────────────────────── */

function doDraw() { send({ type:'draw' }); }
function doEndTurn() { send({ type:'end_turn' }); }

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
  $('modal-overlay').style.display = 'flex';
}

function closeModal(e) {
  if (e && e.target !== $('modal-overlay')) return;
  closeModalDirect();
}

function closeModalDirect() {
  $('modal-overlay').style.display = 'none';
}

/* ── Utilities ───────────────────────────────────────────────────────── */

function $(id) { return document.getElementById(id); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

function bankTotal(player) {
  return (player.bank||[]).reduce((s,c) => s + c.value, 0);
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Init ────────────────────────────────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModalDirect();
});

// Auto-focus name input
window.addEventListener('load', () => $('player-name')?.focus());
