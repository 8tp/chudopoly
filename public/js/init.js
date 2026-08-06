// js/init.js — Event listeners and initialization

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (['card-detail', 'show-opponent', 'select-target-property', 'select-my-property'].includes(action)) e.stopPropagation();
  switch (action) {
    case 'create-room': createRoom(); break;
    case 'quick-play': quickPlay(); break;
    case 'join-room': joinRoom(); break;
    case 'share-room': shareRoom(); break;
    case 'show-bot-picker': showBotModePicker(); break;
    case 'add-bot': addBot(target.dataset.mode); break;
    case 'remove-bot': removeBot(target.dataset.playerId); break;
    case 'kick-player': kickPlayer(target.dataset.playerId); break;
    case 'start-game': startGame(); break;
    case 'leave-lobby': leaveLobby(); break;
    case 'leave-game': leaveGame(); break;
    case 'leave-now': doLeave(); break;
    case 'rematch': requestRematch(); break;
    case 'switch-chat': switchChatTab(target.dataset.scope); break;
    case 'send-chat': sendChat(target.dataset.from); break;
    case 'show-gif': showGifPicker(target.dataset.from); break;
    case 'toggle-chat': toggleChatDrawer(); break;
    case 'show-emotes': showEmotePicker(); break;
    case 'show-help': showHelpModal(); break;
    case 'toggle-sound': toggleSound(); break;
    case 'cancel-targeting': cancelTargeting(); break;
    case 'draw': doDraw(); break;
    case 'end-turn': doEndTurn(); break;
    case 'confirm-scoop': confirmScoop(); break;
    case 'close-modal': closeModalDirect(); break;
    case 'select-hand': selectHandCard(Number(target.dataset.handIndex)); break;
    case 'card-detail': showCardDetailById(Number(target.dataset.cardId)); break;
    case 'show-opponent': showOpponentDetail(target.dataset.playerId); break;
    case 'select-target-property': selectTargetProperty(target.dataset.playerId, Number(target.dataset.cardId), target.dataset.color); break;
    case 'select-my-property': selectMyProperty(Number(target.dataset.cardId), target.dataset.color); break;
    case 'toggle-pay': togglePayCard(target, Number(target.dataset.cardId), Number(target.dataset.value)); break;
    case 'toggle-discard': toggleDiscard(target, Number(target.dataset.cardId)); break;
    case 'pick-card': window._pickCard?.(target.dataset.playerId, Number(target.dataset.cardId), target.dataset.color); break;
    case 'pick-ig': window._pickIG?.(target.dataset.playerId, target.dataset.color); break;
    case 'picker': window._pickerCb?.(target.dataset.value, target.dataset.valueTwo); break;
    case 'pick-color': window._colorCb?.(target.dataset.color); break;
    case 'move-wild': doMoveWild(Number(target.dataset.cardId), target.dataset.color); break;
    case 'send-emote': sendEmote(target.dataset.text); break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'gif-search-input') window.onGifSearch();
});

$('modal-overlay').addEventListener('click', closeModal);

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) {
    e.preventDefault();
    e.target.click();
    return;
  }
  if (e.key === 'Enter' && e.target.matches('[data-chat-from]')) {
    e.preventDefault();
    sendChat(e.target.dataset.chatFrom);
    return;
  }
  const overlay = $('modal-overlay');
  if (e.key === 'Tab' && overlay?.style.display !== 'none') {
    const focusable = [...overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
    if (focusable.length) {
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
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
  const inviteCode = new URLSearchParams(location.search).get('room');
  if (inviteCode && /^[A-HJ-NP-Z2-9]{4}$/i.test(inviteCode)) $('room-code-input').value = inviteCode.toUpperCase();
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
