// js/sound.js — Web Audio API sound engine

var _audioCtx;
var _soundMuted = false;

function getAudio() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function playTone(freq, dur, type, vol) {
  if (_soundMuted) return;
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.value = vol || 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.stop(ctx.currentTime + dur);
  } catch {}
}

function sfx(name) {
  if (_soundMuted) return;
  switch (name) {
    case 'turn':
      playTone(440, 0.12, 'sine', 0.12);
      setTimeout(() => playTone(660, 0.15, 'sine', 0.15), 130);
      break;
    case 'play':
      playTone(880, 0.08, 'sine', 0.1);
      break;
    case 'bank':
      playTone(1200, 0.06, 'sine', 0.08);
      setTimeout(() => playTone(1400, 0.08, 'sine', 0.08), 70);
      break;
    case 'chud':
      playTone(220, 0.3, 'sawtooth', 0.1);
      setTimeout(() => playTone(165, 0.4, 'sawtooth', 0.12), 300);
      break;
    case 'win':
      [0,100,200,300,400].forEach((d,i) =>
        setTimeout(() => playTone([523,659,784,1047,1319][i], 0.3, 'sine', 0.12), d));
      break;
    case 'opsec':
      playTone(600, 0.15, 'square', 0.08);
      setTimeout(() => playTone(800, 0.15, 'square', 0.08), 160);
      break;
    case 'rent':
      playTone(500, 0.1, 'triangle', 0.1);
      setTimeout(() => playTone(400, 0.15, 'triangle', 0.1), 120);
      break;
    case 'draw':
      playTone(300, 0.05, 'sine', 0.06);
      setTimeout(() => playTone(350, 0.05, 'sine', 0.06), 60);
      break;
    case 'steal':
      playTone(500, 0.15, 'sawtooth', 0.08);
      setTimeout(() => playTone(350, 0.2, 'sawtooth', 0.1), 150);
      break;
    case 'swap':
      playTone(600, 0.1, 'triangle', 0.08);
      setTimeout(() => playTone(500, 0.1, 'triangle', 0.08), 120);
      setTimeout(() => playTone(600, 0.1, 'triangle', 0.08), 240);
      break;
    case 'seize':
      playTone(150, 0.3, 'sawtooth', 0.1);
      setTimeout(() => playTone(120, 0.35, 'sawtooth', 0.12), 100);
      setTimeout(() => playTone(200, 0.2, 'square', 0.08), 250);
      break;
    case 'upgrade':
      [0,80,160].forEach((d,i) =>
        setTimeout(() => playTone([600,800,1000][i], 0.12, 'sine', 0.1), d));
      break;
    case 'surge':
      playTone(200, 0.4, 'sawtooth', 0.06);
      setTimeout(() => playTone(400, 0.3, 'sawtooth', 0.08), 150);
      setTimeout(() => playTone(800, 0.2, 'sine', 0.1), 300);
      break;
    case 'pay':
      [0,50,100].forEach((d,i) =>
        setTimeout(() => playTone([1800,2000,1600][i], 0.04, 'sine', 0.06), d));
      break;
    case 'pcs':
      [0,40,80,120].forEach((d,i) =>
        setTimeout(() => playTone([400,500,450,550][i], 0.04, 'sine', 0.06), d));
      break;
    case 'demand':
      playTone(400, 0.15, 'square', 0.1);
      setTimeout(() => playTone(500, 0.2, 'square', 0.1), 170);
      break;
    case 'scoop':
      playTone(500, 0.15, 'sine', 0.1);
      setTimeout(() => playTone(400, 0.15, 'sine', 0.08), 150);
      setTimeout(() => playTone(300, 0.2, 'sine', 0.06), 300);
      setTimeout(() => playTone(200, 0.3, 'sine', 0.04), 450);
      break;
    case 'blocked':
      playTone(800, 0.08, 'square', 0.1);
      setTimeout(() => playTone(1200, 0.12, 'square', 0.08), 80);
      break;
    case 'property':
      playTone(600, 0.06, 'sine', 0.08);
      setTimeout(() => playTone(800, 0.08, 'sine', 0.1), 70);
      break;
    case 'error':
      playTone(200, 0.2, 'square', 0.08);
      break;
    case 'emote':
      playTone(700, 0.06, 'sine', 0.06);
      break;
    case 'alarm':
      // Loud 5-second warning alarm — pulsing high pitch
      [0,200,400,600,800].forEach((d,i) => {
        setTimeout(() => {
          playTone(1000, 0.15, 'square', 0.25);
          setTimeout(() => playTone(800, 0.1, 'square', 0.2), 100);
        }, d);
      });
      break;
    case 'siren':
      // Military air raid siren — rising/falling sweep
      if (_soundMuted) return;
      try {
        const ctx = getAudio();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(400, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 1.0);
        osc.frequency.linearRampToValueAtTime(400, ctx.currentTime + 2.0);
        osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 3.0);
        osc.frequency.linearRampToValueAtTime(400, ctx.currentTime + 4.0);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.setValueAtTime(0.2, ctx.currentTime + 3.5);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 4.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 4.5);
      } catch {}
      break;
  }
}

function toggleSound() {
  _soundMuted = !_soundMuted;
  const btn = $('btn-sound');
  if (btn) btn.classList.toggle('muted', _soundMuted);
  if (!_soundMuted) sfx('play');
}
