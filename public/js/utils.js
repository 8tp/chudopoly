// js/utils.js — Constants and utility functions

const COLORS = {
  brown:{name:'Drone Ops',bg:'#8B4513',fg:'#fff',size:2,rent:[1,2]},
  lightblue:{name:'Training',bg:'#87CEEB',fg:'#000',size:3,rent:[1,2,3]},
  pink:{name:'Space Force',bg:'#FF69B4',fg:'#000',size:3,rent:[1,2,4]},
  orange:{name:'Test & Eval',bg:'#FF8C00',fg:'#000',size:3,rent:[1,3,5]},
  red:{name:'Fighters',bg:'#DC143C',fg:'#fff',size:3,rent:[2,3,6]},
  yellow:{name:'Mobility',bg:'#FFD700',fg:'#000',size:3,rent:[2,4,6]},
  green:{name:'Elite Programs',bg:'#228B22',fg:'#fff',size:3,rent:[2,4,7]},
  darkblue:{name:'Command',bg:'#00308F',fg:'#fff',size:2,rent:[3,8]},
  base:{name:'Overseas Bases',bg:'#2F4F4F',fg:'#fff',size:4,rent:[1,2,3,4]},
  intel:{name:'Intelligence',bg:'#708090',fg:'#fff',size:2,rent:[1,2]},
};

const EMOTES = [
  'Bravo Zulu', 'Check Six!', 'Send It',
  'Roger That', 'TYFYS', 'FUBAR',
];

const BOT_MODES = {
  random:       { icon:'\uD83C\uDFB2', label:'Random',       desc:'Unpredictable plays',  color:'#9e9e9e' },
  conservative: { icon:'\uD83D\uDEE1\uFE0F',  label:'Conservative', desc:'Plays it safe',        color:'#42a5f5' },
  neutral:      { icon:'\u2696\uFE0F',  label:'Neutral',      desc:'Balanced strategy',    color:'#66bb6a' },
  aggressive:   { icon:'\u2694\uFE0F',  label:'Aggressive',   desc:'Relentless attacker',  color:'#ef5350' },
  chud:         { icon:'\uD83D\uDC80', label:'Chud',         desc:'Pure chaos',           color:'#ffd740' },
};

function $(id) { return document.getElementById(id); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

function bankTotal(player) {
  return (player.bank||[]).reduce((s,c) => s + c.value, 0);
}

function netWorth(player) {
  let total = bankTotal(player);
  for (const cards of Object.values(player.properties || {})) {
    if (cards) cards.forEach(c => total += c.value);
  }
  return total;
}

var toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
