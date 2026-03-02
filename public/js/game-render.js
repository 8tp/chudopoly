// js/game-render.js — Game rendering, card rendering, property display

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
    let targetCls = '';
    if (window._pendingSteal) {
      const action = window._pendingSteal.action;
      const hasProps = Object.values(p.properties).some(cards => cards && cards.length > 0);
      if (action === 'chud') {
        targetCls = hasProps ? 'target-highlight' : 'target-dimmed';
      } else {
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

  // Pending action — show response modal
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

  let safe = esc(text);

  for (const [key, info] of Object.entries(COLORS)) {
    const name = info.name;
    const escaped = esc(name);
    if (safe.includes(escaped)) {
      safe = safe.replace(new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        `<span class="log-color-tag" style="color:${info.bg}">${escaped}</span>`);
    }
  }

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
    let dimmed = false;
    if (window._pendingSteal && window._pendingSteal.action !== 'chud' && complete) dimmed = true;
    if (window._pendingIG && !complete) dimmed = true;
    for (const c of cards) {
      const dimCls = dimmed ? ' target-dimmed' : '';
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
