// ui/lobby.js — seats, bots, timers, launch, invite link.

import { $, el, clear, setText, setHidden, setAttr } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import { toast } from './screens.js';
import {
  PRESETS, PRESET_ORDER, PRESET_COPY, SETS_TO_WIN_CHOICES, WIN_RULES,
  WIN_RULE_NAMES, WIN_RULE_LINE, TOGGLE_COPY,
  matchPreset, presetLabel, normalizeRules, rulesPayload,
  loadHostRules, saveHostRules, winRuleSummary,
} from './ruleset.js';

/* ── who you are actually sitting down with (§P7.19) ───────────────────────
 *
 * The lobby offered five bare labels and no way to know what any of them meant.
 * Every line below is read off bot.js: the OPSEC policy in
 * shouldPlayOpsecDecision(), the break-a-final-approach appetite in
 * BREAK_URGENCY, the payment ordering in the selectPaymentCards() switch, and
 * the think-time in DELAYS.
 *
 * The wire value `chud` is the engine's and cannot move, but its LABEL could:
 * "CHUD" collided head-on with THE CHUD CARD, so a player reading "CHUD bot"
 * reasonably concluded it was the bot that plays the CHUD card. It is the
 * chaos personality, so it is labelled that way.
 */
const BOT_LABEL = {
  random: 'RANDOM', conservative: 'CAUTIOUS', neutral: 'NEUTRAL',
  aggressive: 'AGGRESSIVE', chud: 'WILDCARD',
};

const BOT_BLURB = {
  // decideRandom + BREAK_URGENCY.random 0.2 + OPSEC case 'random'.
  random: 'Plays almost anything and blocks almost nothing. Barely reacts to a final '
    + 'approach. The easiest seat at the table.',
  // BREAK_URGENCY 0.85, ARMED_BANK_BIAS 0.9, OPSEC case 'conservative'.
  conservative: 'Banks early, hoards OPSEC for Inspector General and CHUD, and pays with its '
    + 'cheapest cards first. Slow, and hard to break.',
  // BREAK_URGENCY 0.9, OPSEC case 'neutral' (blocks IG, CHUD, Finance Office, rent ≥ 4M).
  neutral: 'The balanced default. Blocks the big hits, waves the small ones through, and '
    + 'builds steadily.',
  // BREAK_URGENCY 1, OPSEC case 'aggressive' (guards only near-complete sets).
  aggressive: 'Attacks first and spends fast. Only guards sets it has nearly finished, so it '
    + 'is the quickest to shoot down a final approach — and the easiest to rob.',
  // DELAYS.chud is the fastest bank; OPSEC case 'chud' blocks small, lets big land;
  // decideChud ends turns early ~20%; discards at random.
  chud: 'Chaos, at speed. Blocks the small stuff, lets the big stuff land, discards at random '
    + 'and sometimes just stops mid-turn. (Nothing to do with THE CHUD CARD.)',
};

/**
 * public/index.html is architect-owned (§1) and ships the five <option> labels;
 * the meaning is added here rather than by editing the shell.
 */
function describeBots() {
  const select = $('bot-mode');
  if (!select) return;
  for (const option of select.options) {
    if (BOT_LABEL[option.value]) option.textContent = BOT_LABEL[option.value];
  }
  let blurb = $('bot-blurb');
  if (!blurb) {
    blurb = el('p', {
      class: 'hint bot-blurb',
      attrs: { id: 'bot-blurb', 'aria-live': 'polite' },
    });
    select.closest('.row')?.after(blurb);
    select.addEventListener('change', () => setText(blurb, BOT_BLURB[select.value] || ''));
  }
  setText(blurb, BOT_BLURB[select.value] || '');
}

/* ── the ruleset picker (§P8) ──────────────────────────────────────────────
 *
 * Real tables negotiate a handful of rules before anyone deals, and they do it
 * by NAME — "normal", "quick game" — not by enumerating four switches. So the
 * four presets are the whole choice, one tap each, and the switches live behind
 * a disclosure for the table that actually wants to argue about them.
 *
 * WHY THE HOST'S CHOICE IS LOCAL, AND WHAT NON-HOSTS SEE.
 * The lobby broadcast (server/broadcast.js broadcastRoom) carries code, phase,
 * players, hostId, game and the two timers. There is NO ruleset field before a
 * game exists — `game` is null in a lobby — so a pending choice has nowhere to
 * travel and no other seat can read it. server/ is frozen (§1) and not ours, so
 * the picker is host-local and every other seat is told the truth: the host is
 * choosing, and the ruleset is stated on the table and in How to play from the
 * first broadcast onward (ui/ruleset.js activeRules → ui/help.js ruleBadge).
 * The alternative — showing non-hosts the DEFAULT ruleset as though it were the
 * pending one — is a label that lies four times out of five. The one-message
 * server change that would fix it properly is in this agent's report.
 *
 * PERSISTENCE: ui/ruleset.js loadHostRules/saveHostRules. A host who picked
 * Blitz last night gets Blitz selected tonight, in a new room, without asking.
 */

/** The host's pending toggle set. Server-authoritative from `start_game` on. */
let pending = normalizeRules(null);
let pickerRoot = null;

/** name → the four inputs that must reflect `pending`, cached at build time. */
const inputs = { preset: [], winRule: [], setsToWin: [], flags: {} };

function radio(name, value, checked) {
  return el('input', {
    class: 'rule-input',
    attrs: { type: 'radio', name, value, ...(checked ? { checked: true } : {}) },
  });
}

function presetTile(id) {
  const copy = PRESET_COPY[id];
  const input = radio('chud-preset', id, id === matchPreset(pending));
  inputs.preset.push(input);
  return el('label', { class: 'preset' }, [
    input,
    el('span', { class: 'preset-body' }, [
      el('span', { class: 'preset-top' }, [
        el('span', { class: 'preset-name', text: copy.name }),
        el('span', { class: 'preset-tag', text: copy.tag }),
        el('span', { class: 'preset-turns', text: copy.turns }),
      ]),
      el('span', { class: 'preset-line', text: copy.line }),
    ]),
  ]);
}

function winRuleRow(id) {
  const input = radio('chud-winrule', id, pending.winRule === id);
  inputs.winRule.push(input);
  return el('label', { class: 'rule-row' }, [
    input,
    el('span', { class: 'rule-body' }, [
      el('span', { class: 'rule-name', text: WIN_RULE_NAMES[id] }),
      el('span', { class: 'rule-line', text: WIN_RULE_LINE[id] }),
    ]),
  ]);
}

function setsRow() {
  return el('div', { class: 'rule-seg', attrs: { role: 'radiogroup', 'aria-label': 'Sets to win' } },
    SETS_TO_WIN_CHOICES.map((n) => {
      const input = radio('chud-sets', String(n), pending.setsToWin === n);
      inputs.setsToWin.push(input);
      return el('label', { class: 'seg' }, [input, el('span', { class: 'seg-face', text: String(n) })]);
    }));
}

function flagRow(key, name) {
  const copy = TOGGLE_COPY[key];
  const input = el('input', {
    class: 'rule-input',
    attrs: { type: 'checkbox', name, ...(pending[key] ? { checked: true } : {}) },
  });
  inputs.flags[key] = input;
  return el('label', { class: 'rule-row' }, [
    input,
    el('span', { class: 'rule-body' }, [
      el('span', { class: 'rule-name', text: copy.label }),
      el('span', { class: 'rule-line', text: copy.line }),
    ]),
  ]);
}

/** Fold one changed control back into `pending`, persist, repaint the label. */
function onPick(e) {
  const t = e.target;
  if (!t || t.tagName !== 'INPUT') return;
  switch (t.name) {
    // A preset REPLACES the toggle set — that is what picking one means.
    case 'chud-preset': pending = { ...PRESETS[t.value] }; break;
    case 'chud-winrule': pending = { ...pending, winRule: t.value }; break;
    case 'chud-sets': pending = { ...pending, setsToWin: Number(t.value) }; break;
    case 'chud-pure': pending = { ...pending, pureSetRequired: t.checked }; break;
    case 'chud-pcs': pending = { ...pending, passGoRestartsTurn: t.checked }; break;
    default: return;
  }
  pending = normalizeRules(pending);
  saveHostRules(pending);
  syncPicker();
}

/**
 * Push `pending` back into every control and repaint the summary. Runs after a
 * pick AND on every lobby render, so a picker built from a stale localStorage
 * read can never disagree with the object that is actually sent.
 */
function syncPicker() {
  if (!pickerRoot) return;
  const preset = matchPreset(pending);
  for (const input of inputs.preset) input.checked = input.value === preset;
  for (const input of inputs.winRule) input.checked = input.value === pending.winRule;
  for (const input of inputs.setsToWin) input.checked = Number(input.value) === pending.setsToWin;
  inputs.flags.pureSetRequired.checked = pending.pureSetRequired;
  inputs.flags.passGoRestartsTurn.checked = pending.passGoRestartsTurn;

  // The label the host reads is computed the same way the server computes the
  // one the table will read (game.js resolveRules), so flipping a toggle off a
  // preset says "Custom" here exactly when the broadcast will say 'custom'.
  const bits = [`${WIN_RULE_NAMES[pending.winRule]}`, `${pending.setsToWin} sets`];
  if (pending.pureSetRequired) bits.push('no all-wild sets');
  if (pending.passGoRestartsTurn) bits.push('PCS Orders restarts');
  setText($('ruleset-name'), presetLabel(preset));
  setText($('ruleset-bits'), bits.join(' · '));
  setText($('ruleset-win'), winRuleSummary(pending));
  setAttr($('ruleset'), 'data-preset', preset);
}

/**
 * index.html is architect-owned (§1) and ships no picker, so it is built here —
 * once, then only mutated. Inserted before Launch Mission because the ruleset
 * is a decision you make BEFORE you launch, not a footnote under the button.
 */
function ensurePicker() {
  if (pickerRoot) return;
  const hostBox = $('lobby-host');
  const start = $('btn-start');
  if (!hostBox || !start) return;

  pending = loadHostRules();

  pickerRoot = el('section', {
    class: 'ruleset',
    attrs: { id: 'ruleset', 'aria-labelledby': 'ruleset-head' },
  }, [
    el('div', { class: 'ruleset-head' }, [
      el('h3', { class: 'ruleset-title', attrs: { id: 'ruleset-head' }, text: 'Rules' }),
      el('span', { class: 'ruleset-now', attrs: { 'aria-live': 'polite' } }, [
        el('span', { class: 'ruleset-name', attrs: { id: 'ruleset-name' } }),
        el('span', { class: 'ruleset-bits', attrs: { id: 'ruleset-bits' } }),
      ]),
    ]),
    el('div', {
      class: 'preset-grid',
      attrs: { role: 'radiogroup', 'aria-label': 'Ruleset preset' },
    }, PRESET_ORDER.map(presetTile)),
    el('p', { class: 'ruleset-win hint', attrs: { id: 'ruleset-win' } }),
    el('details', { class: 'ruleset-adv' }, [
      el('summary', { class: 'ruleset-summary' }, [
        el('span', { class: 'ruleset-summary-text', text: 'Change individual rules' }),
        el('span', { class: 'ruleset-caret', attrs: { 'aria-hidden': 'true' }, text: '▸' }),
      ]),
      el('div', { class: 'adv-body' }, [
        el('fieldset', { class: 'adv-group' }, [
          el('legend', { class: 'adv-legend', text: 'When you win' }),
          ...WIN_RULES.map(winRuleRow),
        ]),
        el('fieldset', { class: 'adv-group adv-group-inline' }, [
          el('legend', { class: 'adv-legend', text: 'Sets to win' }),
          setsRow(),
        ]),
        el('fieldset', { class: 'adv-group' }, [
          el('legend', { class: 'adv-legend', text: 'House rules' }),
          flagRow('pureSetRequired', 'chud-pure'),
          flagRow('passGoRestartsTurn', 'chud-pcs'),
        ]),
      ]),
    ]),
  ]);

  pickerRoot.addEventListener('change', onPick);
  hostBox.insertBefore(pickerRoot, start);
  syncPicker();
}

/**
 * What a seat that is NOT the host sees. Not a picker and not a guess at one:
 * a statement of who decides and where the answer will appear.
 */
function ensureGuestNote() {
  if ($('ruleset-guest')) return;
  const hint = $('lobby-hint');
  if (!hint) return;
  hint.parentNode.insertBefore(el('p', {
    class: 'ruleset-guest hint',
    attrs: { id: 'ruleset-guest', hidden: true },
    text: 'The host is choosing the ruleset. Whatever they pick, the table and How to play '
      + 'describe the game you are actually in, from the first hand.',
  }), hint);
}

function inviteUrl() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = store.room.code ? `?room=${store.room.code}` : '';
  return url.toString();
}

function render() {
  if (store.screen !== 'lobby') return;
  setText($('lobby-code'), store.room.code || '----');

  const host = store.room.hostId === store.self.id;
  setHidden($('lobby-host'), !host);
  ensureGuestNote();
  setHidden($('ruleset-guest'), host);
  if (host) { describeBots(); ensurePicker(); syncPicker(); }
  setText($('lobby-hint'), host
    ? (store.room.players.length < 2 ? 'Add a bot or invite a squadmate — 2 players minimum.' : 'Ready when you are.')
    : 'Waiting for the host to launch…');

  const list = $('lobby-players');
  if (!list) return;
  clear(list);
  for (const player of store.room.players) {
    const row = el('div', { class: 'lobby-row' }, [
      el('span', { class: 'lobby-seat-name', text: player.name }),
      el('span', {
        class: 'lobby-seat-tag',
        text: player.isBot ? `BOT · ${BOT_LABEL[player.botMode] || 'BOT'}`
          : (player.id === store.room.hostId ? 'HOST' : (player.connected ? '' : 'OFFLINE')),
      }),
    ]);
    if (host && player.id !== store.self.id) {
      row.appendChild(el('button', {
        class: 'btn btn-ghost btn-small',
        text: player.isBot ? 'Remove' : 'Kick',
        attrs: {
          'data-action': player.isBot ? 'remove-bot' : 'kick',
          'data-target': player.id,
        },
      }));
    }
    list.appendChild(row);
  }
}

export function mount() {
  pointer.registerActions({
    'add-bot': () => send.addBot($('bot-mode')?.value || 'neutral'),
    'remove-bot': (el2) => send.removeBot(el2.dataset.target),
    'kick': (el2) => send.kick(el2.dataset.target),
    // rulesPayload() sends a NAME when the toggles are a named preset and the
    // four toggles when they are not — 'custom' is not a wire value
    // (server/protocol.js rejects it) and resolveRules() reaches the identical
    // ruleset either way. Absent fields would mean Chudopoly, so this is never
    // empty by accident.
    'start-game': () => send.startGame(
      Number($('turn-timeout')?.value || 60),
      Number($('response-timeout')?.value || 30),
      rulesPayload(pending)
    ),
    'copy-invite': async () => {
      const url = inviteUrl();
      try {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      } catch {
        toast(url);
      }
    },
  });

  bus.on(EVENTS.STATE_APPLIED, render);
  bus.on(EVENTS.STATE_SCREEN, render);
}
