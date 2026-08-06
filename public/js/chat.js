// js/chat.js — Chat, GIF picker, emotes

var _chatMsgs = { room:[], global:[] };
var _chatScope = 'room';
var _chatUnread = { room:0, global:0 };
var _chatDrawerOpen = false;
var _giphyKey = '';
var _gifPickerFrom = '';
var _gifSearchTimer = null;

/* ── Chat rendering ──────────────────────────────────────────────────── */

function safeMediaURL(text) {
  if (typeof text !== 'string' || text.trim() !== text || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const imagePath = /\.(?:gif|png|jpg|jpeg|webp)$/i.test(url.pathname);
    const mediaHost = url.hostname === 'tenor.com' || url.hostname.endsWith('.tenor.com')
      || url.hostname === 'giphy.com' || url.hostname.endsWith('.giphy.com');
    return imagePath || mediaHost ? url.href : null;
  } catch { return null; }
}

function renderChatMsgs(containerId) {
  const el = $(containerId);
  if (!el) return;
  const msgs = _chatMsgs[_chatScope] || [];
  el.replaceChildren();
  msgs.forEach(m => {
    const time = new Date(m.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const row = document.createElement('div');
    row.className = 'chat-msg' + (m.pid === myId ? ' chat-me' : '');
    const timeEl = document.createElement('span');
    timeEl.className = 'chat-time';
    timeEl.textContent = time;
    const nameEl = document.createElement('span');
    nameEl.className = 'chat-name';
    nameEl.textContent = String(m.name || 'Anon');
    const textEl = document.createElement('span');
    textEl.className = 'chat-text';
    textEl.textContent = String(m.text || '');
    row.append(timeEl, nameEl, textEl);
    const mediaURL = safeMediaURL(m.text);
    if (mediaURL) {
      const link = document.createElement('a');
      link.href = mediaURL;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.className = 'chat-img';
      img.src = mediaURL;
      img.loading = 'lazy';
      img.alt = 'Shared image';
      img.addEventListener('error', () => link.remove(), { once: true });
      link.appendChild(img);
      row.appendChild(link);
    }
    el.appendChild(row);
  });
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

/* ── GIF Picker ─────────────────────────────────────────────────────── */

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
  const body = '<input type="text" id="gif-search-input" class="gif-search-input" placeholder="Search GIFs..." autocomplete="off">' +
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
    grid.replaceChildren();
    data.data.forEach(g => {
      const preview = g.images?.fixed_height_small?.url || g.images?.fixed_height?.url || '';
      const full = g.images?.fixed_height?.url || preview;
      const img = document.createElement('img');
      img.className = 'gif-item';
      img.src = preview;
      img.alt = g.title || 'gif';
      img.loading = 'lazy';
      img.addEventListener('click', () => window.selectGif(full));
      grid.appendChild(img);
    });
  }).catch(() => {
    if (grid) grid.innerHTML = '<p style="color:#889;text-align:center;padding:20px">Failed to load GIFs</p>';
  });
}

window.selectGif = function(url) {
  closeModalDirect();
  send({ type:'chat', text:url, scope:_chatScope });
};
