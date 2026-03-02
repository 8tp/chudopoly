// js/modals.js — Modal system, response/payment/discard modals, opponent detail, pickers

var _responseModalOpen = false;
var modalCallback = null;

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

/* ── Opponent detail ─────────────────────────────────────────────────── */

window.showOpponentDetail = function(playerId) {
  const g = S.game;
  if (!g) return;
  const p = g.players.find(x => x.id === playerId);
  if (!p) return;

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

  body += `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px;font-size:13px;color:#C0C0C0">
    <span>Sets: <strong>${p.completedSets}/3</strong></span>
    <span>Hand: <strong>${p.handCount}</strong></span>
    <span>Net Worth: <strong>${netWorth(p)}M</strong></span>
  </div>`;

  if (!isPicker) {
    body += '<h4 style="color:#FFD700;font-size:12px;margin:8px 0 4px;letter-spacing:1px">BANK (' + bankTotal(p) + 'M)</h4>';
    if (p.bank.length > 0) {
      body += '<div class="discard-grid">' + p.bank.map(c => renderCard(c, 'view')).join('') + '</div>';
    } else {
      body += '<p style="font-size:12px;color:#556">No funds banked</p>';
    }
  }

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
      propHTML += `<div class="discard-grid">${cards.map(c => renderCard(c, 'view')).join('')}</div>`;
      propHTML += `<button class="pick-set-btn" onclick="window._pickIG('${playerId}','${color}')">Seize This Set</button>`;
    } else if (!setDimmed) {
      cards.forEach(c => {
        propHTML += `<div class="pick-card-row">
          ${renderCard(c, 'view')}
          <button class="pick-btn" onclick="window._pickCard('${playerId}',${c.id},'${color}')">Select</button>
        </div>`;
      });
    } else {
      propHTML += `<div class="discard-grid">${cards.map(c => renderCard(c, 'view')).join('')}</div>`;
    }

    propHTML += '</div>';
  }
  body += propHTML || '<p style="font-size:12px;color:#556">No properties yet</p>';

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
