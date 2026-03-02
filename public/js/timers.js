// js/timers.js — Timer display and turn popup

var _timerInterval = null;
var _responseTimerInterval = null;
var _alarmPlayed = false;
var _responseAlarmPlayed = false;

function updateTimerDisplay() {
  const el = $('hdr-timer');
  if (!el || !S.turnTimer) { if (el) el.style.display = 'none'; return; }
  const elapsed = (Date.now() - S.turnTimer.startedAt) / 1000;
  const remaining = Math.max(0, Math.ceil(S.turnTimer.timeout - elapsed));
  el.textContent = remaining + 's';
  el.classList.toggle('warning', remaining <= 10);
  el.classList.remove('response-active');
  if (remaining <= 5 && remaining > 0 && !_alarmPlayed) {
    _alarmPlayed = true;
    sfx('alarm');
  }
  if (remaining <= 0) { el.textContent = '0s'; }
  if (remaining > 5) _alarmPlayed = false;
}

function updateResponseTimerDisplay() {
  const el = $('hdr-timer');
  if (!el || !S.responseTimer) { if (el) el.style.display = 'none'; return; }
  const elapsed = (Date.now() - S.responseTimer.startedAt) / 1000;
  const remaining = Math.max(0, Math.ceil(S.responseTimer.timeout - elapsed));
  el.textContent = '\u23F1 ' + remaining + 's';
  el.classList.toggle('warning', remaining <= 10);
  el.classList.add('response-active');
  if (remaining <= 5 && remaining > 0 && !_responseAlarmPlayed) {
    _responseAlarmPlayed = true;
    sfx('alarm');
  }
  if (remaining <= 0) { el.textContent = '\u23F1 0s'; }
  if (remaining > 5) _responseAlarmPlayed = false;
}

function updateModalResponseTimer() {
  const countdown = $('response-countdown');
  const barFill = $('response-bar-fill');
  if (!countdown || !barFill || !S.responseTimer) return;
  const update = () => {
    if (!S.responseTimer) return;
    const elapsed = (Date.now() - S.responseTimer.startedAt) / 1000;
    const remaining = Math.max(0, Math.ceil(S.responseTimer.timeout - elapsed));
    const pct = Math.max(0, (1 - elapsed / S.responseTimer.timeout) * 100);
    countdown.textContent = remaining + 's';
    countdown.style.color = remaining <= 5 ? '#f44' : '#ff9800';
    barFill.style.width = pct + '%';
    barFill.style.background = remaining <= 5 ? '#f44' : '#ff9800';
  };
  update();
  const iv = setInterval(() => {
    if (!$('response-countdown')) { clearInterval(iv); return; }
    update();
  }, 500);
}

function showTurnPopup() {
  const el = $('turn-popup');
  if (!el) return;
  const sub = $('turn-popup-sub');
  if (sub) sub.textContent = 'Commander ' + myName;
  el.style.display = 'flex';
  el.style.animation = 'none';
  el.offsetHeight; // force reflow
  el.style.animation = 'turnPopIn 0.3s ease-out, turnPopOut 0.4s ease-in 1.8s forwards';
  setTimeout(() => { el.style.display = 'none'; }, 2200);
}
