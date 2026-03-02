// js/game-actions.js — Hand card selection, targeting, game actions, help

var selectedHandCard = null;

/* ── Targeting ───────────────────────────────────────────────────────── */

function updateTargetingBanner() {
  const banner = $('targeting-banner');
  const msg = $('targeting-msg');
  if (window._pendingSteal) {
    banner.style.display = 'flex';
    const action = window._pendingSteal.action;
    msg.textContent = action === 'chud'
      ? 'CHUD CARD ACTIVE \u2014 Click an opponent to commandeer a property!'
      : 'STEAL MODE \u2014 Click an opponent to requisition a property!';
  } else if (window._pendingSwap) {
    banner.style.display = 'flex';
    msg.textContent = window._pendingSwap.step === 'mine'
      ? 'SWAP \u2014 Click one of YOUR properties first'
      : 'SWAP \u2014 Now click an opponent to swap with';
  } else if (window._pendingIG) {
    banner.style.display = 'flex';
    msg.textContent = 'INSPECTOR GENERAL \u2014 Click an opponent to seize a complete set!';
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

/* ── Hand card selection ─────────────────────────────────────────────── */

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

/* ── Game actions ────────────────────────────────────────────────────── */

function doDraw() { send({ type:'draw' }); }

function doEndTurn() {
  const g = S.game;
  if (!g) return;
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
    <p>2. Play up to <strong>3 cards</strong> \u2014 properties, money to bank, or actions</p>
    <p>3. <strong>End turn</strong> \u2014 discard down to 7 cards if needed</p>
    <p>Any card can be banked as money (face value).</p>

    <h4>CARD TYPES</h4>
    <p><span class="help-card-type" style="background:#2a5a2a;color:#fff">FUNDS</span> Money \u2014 goes straight to your bank</p>
    <p><span class="help-card-type" style="background:#8B4513;color:#fff">PROPERTY</span> Collect sets to win. Set sizes vary (2-4 cards).</p>
    <p><span class="help-card-type" style="background:#666;color:#fff">WILD</span> Wild property \u2014 place on any matching color set</p>
    <p><span class="help-card-type" style="background:#6a2a8a;color:#fff">RENT</span> Charge all players rent based on your properties</p>
    <p><span class="help-card-type" style="background:#2a2a6a;color:#fff">ACTION</span> Special actions (see below)</p>
    <p><span class="help-card-type" style="background:#FFD700;color:#000">CHUD</span> Steal ANY property + collect 2M!</p>

    <h4>ACTION CARDS</h4>
    <p><strong>PCS Orders</strong> \u2014 Draw 2 extra cards</p>
    <p><strong>Finance Office</strong> \u2014 Collect 5M from one player</p>
    <p><strong>Roll Call</strong> \u2014 All others pay you 2M each</p>
    <p><strong>Midnight Requisition</strong> \u2014 Steal 1 property (not from complete set)</p>
    <p><strong>TDY Orders</strong> \u2014 Swap a property with another player</p>
    <p><strong>Inspector General</strong> \u2014 Seize an entire complete set!</p>
    <p><strong>Upgrade / FOC</strong> \u2014 Add +3M / +4M rent to a complete set</p>
    <p><strong>Surge Ops</strong> \u2014 Double your next rent charge</p>
    <p><strong>OPSEC</strong> \u2014 Counter ANY action played against you</p>

    <h4>THE CHUD CARD</h4>
    <p>Commandeer Hardware Under Directive \u2014 steal ANY property (even from complete sets) and collect 2M. Can be countered with OPSEC.</p>
  </div>`;
  showModal('Rules \u2014 Quick Reference', body, [
    { label:'Got It', cls:'btn-primary', fn:() => closeModalDirect() },
  ]);
}
