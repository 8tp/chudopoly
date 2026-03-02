// js/network.js — WebSocket connection management

var ws;
var _connecting = false;

function connect(onOpen) {
  if (_connecting) return;
  _connecting = true;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  updateConnStatus(false);
  ws.onopen = () => {
    _connecting = false;
    updateConnStatus(true);
    if (onOpen) onOpen();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'joined':
        myId = msg.playerId;
        myName = msg.name;
        roomCode = msg.code;
        try { sessionStorage.setItem('chud_pid', myId); sessionStorage.setItem('chud_room', roomCode); } catch {}
        if ($('lobby-error')) $('lobby-error').textContent = '';
        showLobbyWaiting();
        break;
      case 'state':
        handleState(msg);
        break;
      case 'error':
        toast(msg.message);
        sfx('error');
        if ($('lobby-error')) $('lobby-error').textContent = msg.message;
        if (msg.needDiscard) showDiscardModal(msg.excess);
        if (msg.needPayment) showPaymentModal(msg.amount);
        break;
      case 'need_payment':
        showPaymentModal(msg.amount);
        break;
      case 'kicked':
        myId = null; roomCode = '';
        try { sessionStorage.removeItem('chud_pid'); sessionStorage.removeItem('chud_room'); } catch {}
        toast('You were removed from the room');
        $('lobby-join').style.display = 'flex';
        $('lobby-waiting').style.display = 'none';
        $('game-screen').style.display = 'none';
        $('lobby-screen').style.display = 'flex';
        break;
      case 'emote':
        showFloatingEmote(msg.playerId, msg.name, msg.text);
        if (msg.playerId !== myId) sfx('emote');
        break;
      case 'chat': {
        const m = msg.msg;
        const scope = m.scope || 'room';
        _chatMsgs[scope].push(m);
        if (_chatMsgs[scope].length > 50) _chatMsgs[scope].shift();
        if (scope !== _chatScope || !isChatVisible()) _chatUnread[scope]++;
        renderAllChatContainers();
        if (m.pid !== myId) sfx('emote');
        break;
      }
      case 'chat_history': {
        const scope = msg.scope || 'room';
        _chatMsgs[scope] = msg.msgs || [];
        renderAllChatContainers();
        break;
      }
    }
  };
  ws.onerror = () => { _connecting = false; updateConnStatus(false); };
  ws.onclose = () => {
    _connecting = false;
    updateConnStatus(false);
    setTimeout(() => {
      const pid = myId || tryGet('chud_pid');
      const code = roomCode || tryGet('chud_room');
      if (pid && code) {
        connect(() => send({ type:'reconnect', playerId:pid, code }));
      } else {
        connect();
      }
    }, 2000);
  };
}

function updateConnStatus(connected) {
  const el = $('conn-status');
  if (!el) return;
  el.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
  el.title = connected ? 'Connected' : 'Reconnecting...';
}

function tryGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }

function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }
