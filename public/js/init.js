// js/init.js — Event listeners and initialization

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
