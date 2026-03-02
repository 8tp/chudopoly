// js/chat.js — Chat, GIF picker, emotes

var _chatMsgs = { room:[], global:[] };
var _chatScope = 'room';
var _chatUnread = { room:0, global:0 };
var _chatDrawerOpen = false;
var _giphyKey = '';
var _gifPickerFrom = '';
var _gifSearchTimer = null;

/* ── Chat rendering ──────────────────────────────────────────────────── */

const IMG_RE = /https?:\/\/\S+\.(?:gif|png|jpg|jpeg|webp)(?:\?\S*)?/gi;
const MEDIA_RE = /https?:\/\/(?:media\d*\.)?(?:tenor|giphy)\.com\/\S+/gi;

function chatHTML(text) {
  let safe = esc(text);
  safe = safe.replace(IMG_RE, url =>
    '<a href="' + url + '" target="_blank" rel="noopener"><img class="chat-img" src="' + url + '" loading="lazy" onerror="this.style.display=\'none\'" alt="image"></a>'
  );
  safe = safe.replace(MEDIA_RE, url => {
    if (/\.(?:gif|png|jpg|jpeg|webp)/i.test(url)) return url;
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
