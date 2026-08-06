// audio/engine.js — the WebAudio engine, policy and dispatch. Owner: audio/ (§1).
//
// ── AUTOPLAY POLICY (§7, §10) ───────────────────────────────────────────────
// This is the thing that most often ships broken, so it is structural rather
// than careful:
//   1. No module in audio/ constructs an AudioContext at import time. dsp.js and
//      sfx.js are pure; this file builds nothing until init().
//   2. init() is called from main.js's first real `pointerdown` and from nowhere
//      else (main.js:103). The offline render below injects its own
//      OfflineAudioContext, which is a separate path and needs no gesture.
//   3. Every entry point is a silent no-op while `graph` is null, so a page that
//      never receives a gesture produces ZERO console output and zero exceptions.
//      tools/playtest.mjs drives a whole game headlessly and goes red on one
//      console error.
//   4. Anything that can throw at context-creation time (no Web Audio, no output
//      device, a policy we cannot satisfy) is swallowed into `status`.
//
// ── THE MIX ─────────────────────────────────────────────────────────────────
//   sfx voices ─┐
//   ui voices ──┼→ preMaster → compressor → softClip → master → destination
//   bed ────────┘        ↖ send → convolver(0.55s room) → HP400 → return ┘
//
// The compressor catches a five-card payment landing under a klaxon; the
// WaveShaper is the GUARANTEE, because it clamps its input to [-1,1] before the
// table lookup, so the output is mathematically bounded by the curve maximum
// (0.933 at knee 0.7 = -0.6 dBFS). "No clipping" is therefore an invariant of
// the graph, not a mixing opinion — tools/audiotest.mjs renders every sound
// through this exact chain and asserts it.
//
// ── WHICH CHANNEL SOUNDS WHAT ───────────────────────────────────────────────
// Two channels reach this file and the split is: CUES SOUND THE CARD, EVENTS
// SOUND THE GAME.
//
//   FX_CUE (anim/cues.js, one per PHYSICAL BEAT, carries {kind, mine, big, at})
//     drives the tactile layer only: slide, snap, flip, riffle, pickup, denial,
//     sheet tick. These are the sounds that must land on the frame the card
//     lands, and the cue is the only thing that knows a card moved at all.
//
//   CHOREO_SFX (anim/choreographer.js, one per ENGINE EVENT, carries the event)
//     drives every situational sting: chips, the ladder, sour, OPSEC, CHUD, the
//     klaxon, the fanfare. These need to know WHO — paying and being paid are
//     the same physical beat and opposite emotions — and only the event has that.
//
// The cue kinds that duplicate an event (set_completed, steal_landed, payment_done,
// opsec_clash, action_blocked, turn_start, final_approach, approach_broken, win,
// stalemate) are mapped to null below and are fx/'s alone. Doubling them would
// play the same moment twice, 0–2ms apart, at 2x amplitude — which is how a mix
// clips even with a limiter on it.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { CUE } from '../anim/cues.js';
import * as clock from '../core/clock.js';
import { makeRng } from '../core/rng.js';
import { store } from '../state/store.js';
import { completeSetsOf } from '../state/selectors.js';
import {
  makeImpulseResponse, softClipCurve, softClipCeiling, fillNoise, dbToGain, clamp,
} from './dsp.js';
import { BANK, NAMES } from './sfx.js';

/* ── budget ─────────────────────────────────────────────────────────────── */

/**
 * Hard ceiling on concurrent weighted voices. A "voice" is one envelope, not one
 * node: `chud` weighs 6 because it is ~14 nodes and 640ms long, `card_flip`
 * weighs 1 because it is 6 nodes and 70ms.
 *
 * 32 (§P5 brief). The worst beat a real game produces is a 5-card payment
 * caravan landing while a set completes and the deck reshuffles — see the peak
 * figure reported by __CHUD.audio.stats().peakVoices.
 */
const MAX_VOICES = 32;

/**
 * Priority voices (the once-per-event stings) bypass MAX_VOICES, because a win
 * fanfare dropped for budget reasons is a bug the player cannot un-hear. They do
 * NOT bypass this. Measured: firing all 30 bank entries 12ms apart — which no
 * game can produce; the busiest real 6s window claims 10 — reached a weighted
 * load of 67 before this ceiling existed.
 */
const MAX_VOICES_PRIORITY = 64;

/** name → [tail seconds, weight, priority]. Priority bypasses the cap for
 *  once-per-event stings that must never be dropped. */
const VOICE = {
  shuffle_riffle: [0.58, 4, true],
  card_slide: [0.14, 1, false],
  card_snap: [0.17, 2, false],
  card_flip: [0.07, 1, false],
  deal_done: [0.22, 2, true],
  deal_start: [0.30, 2, true],
  card_pickup: [0.10, 1, false],
  ui_tick: [0.06, 1, false],
  denied: [0.25, 2, true],
  chip: [0.16, 2, false],
  chip_pay: [0.30, 3, true],
  set_progress_0: [0.50, 3, true],
  set_progress_1: [0.56, 3, true],
  set_progress_2: [0.62, 3, true],
  set_progress_3: [0.70, 3, true],
  upgrade: [0.40, 2, true],
  sour: [0.58, 3, true],
  steal: [0.36, 3, true],
  demand: [0.30, 3, true],
  opsec: [0.40, 4, true],
  blocked: [0.24, 3, true],
  chud: [0.68, 6, true],
  scoop: [0.55, 4, true],
  turn_mine: [0.26, 2, true],
  turn_other: [0.10, 1, false],
  timer_warn: [0.24, 2, true],
  timer_critical: [0.26, 2, true],
  klaxon: [1.15, 6, true],
  tension_tick: [0.08, 1, false],
  approach_broken: [0.44, 3, true],
  fanfare: [1.60, 8, true],
  stalemate: [1.10, 4, true],
};

/**
 * §7/§P5: never more than one instance of the same sound per 80ms. That is the
 * default and it is a real limit, not a formality — two identical voices 8ms
 * apart are one voice to a listener and 2x the amplitude to the mix.
 *
 * Three exceptions, all on the card layer: anim/choreographer.js deals at a
 * 70ms stagger (STAGGER.deal) and draws at 60ms, so an 80ms floor silences
 * every second card of a hand — a five-card deal that plays three cards reads
 * as a stutter, not as a deal. The floors below sit just under those staggers.
 */
const RATE_DEFAULT = 0.08;
const RATE_LIMIT = {
  card_slide: 0.055,
  card_snap: 0.055,
  card_flip: 0.045,
  tension_tick: 0.30,
};

/** Other players' sounds: -6dB, off-centre, 5.2kHz lowpass (§7). */
const THEIRS_DB = -6;
const THEIRS_PAN = 0.34;
const THEIRS_DETUNE = 0.994;          // ≈ -10 cents

/* ── module state ───────────────────────────────────────────────────────── */

let graph = null;                     // null until a gesture — see the header
let status = 'idle';                  // idle|ready|suspended|unsupported|failed
let enabled = true;
let volume = 0.8;
let urlMuted = false;                 // ?mute=1 — a HARNESS flag, never persisted
let recorder = null;

const lastAt = Object.create(null);   // name → last play time, for RATE_LIMIT
const voiceEnd = [];
const voiceWeight = [];
let voiceLoad = 0;
let peakVoiceLoad = 0;
let droppedVoices = 0;
const played = Object.create(null);   // name → count, for the report

/** The event the CHOREO_SFX relay in main.js is about to ask us to play. */
const cur = { ev: null, mine: false };

const rng = makeRng('chudopoly-audio');

/* ── preferences ────────────────────────────────────────────────────────── */

const LS_KEY = 'chud.audio';

function readFlags() {
  try {
    urlMuted = new URLSearchParams(location.search).get('mute') === '1';
  } catch { urlMuted = false; }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (typeof s.enabled === 'boolean') enabled = s.enabled;
    if (typeof s.volume === 'number') volume = clamp(s.volume, 0, 1);
  } catch { /* a corrupt or unavailable store is a default-settings store */ }
}

/**
 * `?mute=1` must never round-trip into the player's profile. In gatecrash it
 * did, and every tool run silently wrote "muted" into the save — after which
 * the offline render produced pure zeroes for every cue.
 */
function savePrefs() {
  if (urlMuted) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify({ enabled, volume })); } catch { /* private mode */ }
}

readFlags();

/* ── the graph ──────────────────────────────────────────────────────────── */

/**
 * Noise buffer contents, cached per (kind, length, sampleRate). Filling three
 * 1.2s buffers is ~173k seeded rng draws; tools/audiotest.mjs builds a fresh
 * graph per bank entry and the cache turns all but the first into a memcpy.
 */
const noiseCache = new Map();

function noiseBuffer(ctx, kind, seconds) {
  const n = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const key = `${kind}:${n}:${ctx.sampleRate}`;
  let data = noiseCache.get(key);
  if (!data) {
    data = fillNoise(new Float32Array(n), makeRng(key), kind);
    noiseCache.set(key, data);
  }
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  buf.getChannelData(0).set(data);
  return buf;
}

/** Same cache for the room impulse — 0.55s stereo is ~53k draws per build. */
const irCache = new Map();

function irBuffer(ctx) {
  const key = `ir:${ctx.sampleRate}`;
  let data = irCache.get(key);
  if (!data) {
    const src = makeImpulseResponse(ctx, makeRng('chudopoly-audio-ir'));
    data = [Float32Array.from(src.getChannelData(0)), Float32Array.from(src.getChannelData(1))];
    irCache.set(key, data);
    return src;
  }
  const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
  buf.getChannelData(0).set(data[0]);
  buf.getChannelData(1).set(data[1]);
  return buf;
}

/**
 * Build the whole chain into `ctx`. Used for the live context and, unchanged,
 * for every OfflineAudioContext render — there is one graph implementation, so
 * the offline test cannot measure a mix the player never hears.
 */
function buildGraph(ctx, masterGain) {
  const g = { ctx, rng: makeRng('chudopoly-audio-voices') };

  g.master = ctx.createGain();
  g.master.gain.value = masterGain;
  g.master.connect(ctx.destination);

  g.softClip = ctx.createWaveShaper();
  g.softClip.curve = softClipCurve(2048, 0.7);
  // MUST stay 'none': oversampling filters ring, and ringing overshoots the
  // table maximum, which is the only thing making the ceiling a bound.
  g.softClip.oversample = 'none';
  g.softClip.connect(g.master);

  g.comp = ctx.createDynamicsCompressor();
  g.comp.threshold.value = -14;                 // §7
  g.comp.knee.value = 6;
  g.comp.ratio.value = 12;                      // §7
  g.comp.attack.value = 0.004;
  g.comp.release.value = 0.16;
  g.comp.connect(g.softClip);

  g.preMaster = ctx.createGain();
  g.preMaster.gain.value = 1;
  g.preMaster.connect(g.comp);

  // A card table, not a hangar: 0.55s, highpassed at 400Hz so the low tail does
  // not eat the headroom a snap-down needs, returned at -9dB.
  g.reverb = ctx.createConvolver();
  g.reverb.buffer = irBuffer(ctx);
  g.reverbHp = ctx.createBiquadFilter();
  g.reverbHp.type = 'highpass';
  g.reverbHp.frequency.value = 400;
  g.reverbReturn = ctx.createGain();
  g.reverbReturn.gain.value = dbToGain(-9);
  g.reverb.connect(g.reverbHp);
  g.reverbHp.connect(g.reverbReturn);
  g.reverbReturn.connect(g.preMaster);

  g.sfxBus = ctx.createGain();
  g.sfxBus.gain.value = dbToGain(-3);
  g.sfxBus.connect(g.preMaster);

  g.uiBus = ctx.createGain();
  g.uiBus.gain.value = dbToGain(-8);
  g.uiBus.connect(g.preMaster);

  // §7: the final-approach bed stays at or below -20dB. -22 here, and the bed
  // voices are quiet on their own, so the ceiling holds without a limiter.
  g.bedBus = ctx.createGain();
  g.bedBus.gain.value = dbToGain(-22);
  g.bedBus.connect(g.preMaster);

  g.noise = {
    white: noiseBuffer(ctx, 'white', 1.2),
    pink: noiseBuffer(ctx, 'pink', 1.2),
    brown: noiseBuffer(ctx, 'brown', 1.2),
  };
  return g;
}

/* ── public surface ─────────────────────────────────────────────────────── */

export function setRecorder(fn) {
  recorder = fn;
  attachBridge(0);
}

export function setEnabled(on) {
  enabled = !!on;
  savePrefs();
  if (!graph) return;
  if (!enabled) stopBed();
  rampMaster();
}

export function isEnabled() { return enabled; }
export function isReady() { return !!graph; }

/** 0..1. Exported for the settings UI (§P6 — no control exists yet). */
export function setVolume(v) {
  volume = clamp(Number(v) || 0, 0, 1);
  savePrefs();
  rampMaster();
}

export function getVolume() { return volume; }

function rampMaster() {
  if (!graph) return;
  const t = graph.ctx.currentTime;
  const want = enabled && !urlMuted ? volume : 0;
  const p = graph.master.gain;
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(want, t + 0.06);
}

/**
 * Build the graph. MUST be called from a user gesture; main.js does that on the
 * first pointerdown. Idempotent, and a no-op under the harness recorder — a
 * headless tool must never create an AudioContext (§10).
 */
export function init() {
  if (graph || recorder) return graph;
  const Ctor = typeof window !== 'undefined'
    ? window.AudioContext || window.webkitAudioContext : null;
  if (!Ctor) { status = 'unsupported'; return null; }
  let ctx;
  try {
    ctx = new Ctor({ latencyHint: 'interactive' });
  } catch {
    // No output device, a hostile embedder, or a policy we cannot satisfy.
    // Silence is a fine outcome; a thrown error in the console is not.
    status = 'failed';
    return null;
  }
  try {
    graph = buildGraph(ctx, enabled && !urlMuted ? volume : 0);
  } catch {
    status = 'failed';
    graph = null;
    try { ctx.close(); } catch { /* nothing to close */ }
    return null;
  }
  // resume() rejects if the gesture was not trusted. Swallow it: the graph is
  // built and starts on the next gesture that is.
  if (typeof ctx.resume === 'function') {
    const p = ctx.resume();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
  status = ctx.state === 'running' ? 'ready' : 'suspended';
  if (armed.size) startBed();
  return graph;
}

export function suspend() { try { graph?.ctx.suspend(); } catch { /* ignore */ } }
export function resume() { try { graph?.ctx.resume(); } catch { /* ignore */ } }

/**
 * The event-channel entry point. main.js relays CHOREO_SFX through here:
 *   audio.play(audio.SFX_FOR_EVENT[name] || name, { mine })
 * so `name` is either a bank name, one of the virtual families resolved below,
 * or a raw event type this bank does not sound (which drops silently).
 *
 * @param {string} name
 * @param {{gain?:number, mine?:boolean, big?:boolean}} [opts]
 */
export function play(name, opts = {}) {
  const resolved = resolve(name);
  if (!resolved || !BANK[resolved]) return;
  const mine = SELF_VOICE.has(resolved) ? true : mineFor(cur.ev, !!opts.mine);
  emit(resolved, mine, !!opts.big, opts.gain);
}

/**
 * Sounds that are about the viewing player by definition and must never get the
 * "somebody else" treatment. ui/hud.js:55 plays the timer cues with no options
 * at all, and a -6dB off-centre "your turn ends in 5 seconds" is a bug.
 */
const SELF_VOICE = new Set(['timer_warn', 'timer_critical', 'ui_tick', 'card_pickup', 'denied']);

/** The cue-channel entry point — see the header for the split. */
function emit(name, mine, big, gainMul) {
  if (!BANK[name]) return;
  played[name] = (played[name] || 0) + 1;
  if (recorder) {
    // Recording is observation, not playback: it stays on even under ?mute=1,
    // or a muted harness run would report an empty mix and prove nothing.
    //
    // The rate limit and the voice budget deliberately do NOT apply here. Both
    // are functions of REAL time, and the harness runs the choreographer in
    // instant mode (harness.js:84), where a whole job's events land in the same
    // millisecond — gating the log there would silence beats that are seconds
    // apart in a played game. The log records what was dispatched and to whom;
    // the graph below decides what is audible.
    recorder(name, { mine, big });
    return;
  }
  if (!enabled || urlMuted || !graph) return;
  const t0 = graph.ctx.currentTime + 0.004;
  if (!gate(name, t0)) return;
  fire(graph, name, t0, voiceOpts(mine, big, gainMul), true);
}

/** Build the per-voice options §7's mine/theirs treatment reads. */
function voiceOpts(mine, big, gainMul) {
  const m = !!mine;
  return {
    mine: m,
    big: !!big,
    gain: (m ? 1 : dbToGain(THEIRS_DB)) * (gainMul == null ? 1 : gainMul),
    pan: m ? 0 : (rng() < 0.5 ? -THEIRS_PAN : THEIRS_PAN),
    pitch: m ? 1 : THEIRS_DETUNE,
  };
}

/** Claim the budget and run the bank function. `budget` is false offline. */
function fire(g, name, t0, o, budget) {
  const spec = VOICE[name] || [0.3, 2, false];
  if (budget && !take(t0 + spec[0], spec[1], spec[2])) { droppedVoices++; return false; }
  try {
    BANK[name](g, t0, o);
  } catch (err) {
    bus.reportError(err);
    return false;
  }
  return true;
}

/* ── budget + rate limiting ─────────────────────────────────────────────── */

/**
 * Reaped by SCHEDULED END TIME rather than `onended`, because `onended` fires on
 * the main thread after an OfflineAudioContext has finished rendering — using it
 * would let the offline measurement believe in a budget the live game lacks.
 */
function take(endTime, weight, priority) {
  reap();
  const cap = priority ? MAX_VOICES_PRIORITY : MAX_VOICES;
  if (voiceLoad + weight > cap) return false;
  voiceEnd.push(endTime);
  voiceWeight.push(weight);
  voiceLoad += weight;
  if (voiceLoad > peakVoiceLoad) peakVoiceLoad = voiceLoad;
  return true;
}

function reap() {
  const now = graph ? graph.ctx.currentTime : 0;
  let write = 0;
  for (let i = 0; i < voiceEnd.length; i++) {
    if (voiceEnd[i] > now) {
      voiceEnd[write] = voiceEnd[i];
      voiceWeight[write] = voiceWeight[i];
      write++;
    } else voiceLoad -= voiceWeight[i];
  }
  voiceEnd.length = write;
  voiceWeight.length = write;
  if (voiceLoad < 0) voiceLoad = 0;
}

function gate(name, now) {
  const min = RATE_LIMIT[name] == null ? RATE_DEFAULT : RATE_LIMIT[name];
  const last = lastAt[name];
  if (last !== undefined && now - last < min) return false;
  lastAt[name] = now;
  return true;
}

/* ── event → sound ──────────────────────────────────────────────────────── */

/**
 * Engine event (§4) → sound name. Owned by audio/; the keys are the engine's.
 *
 * `null` means "this event's sound arrives on the FX_CUE channel instead"
 * (main.js falls back to the raw event type, which is not in the bank and drops
 * silently). Three values are VIRTUAL FAMILIES resolved against the live event
 * in `resolve()` below, because `mine` alone cannot tell paying from being paid:
 *   'action'       → chud, or nothing
 *   'set_progress' → set_progress_0..3, by how many sets the actor now holds
 *   'chip_pay' / 'steal' → 'sour' when the viewing player is the one losing
 */
export const SFX_FOR_EVENT = Object.freeze({
  game_start: 'deal_start',
  deal: null,                    // cue: per-card flight + landing
  turn_start: 'turn',            // virtual → turn_mine | turn_other
  draw: null,                    // cue
  shuffle: null,                 // cue: CUE.SHUFFLE
  play_money: 'chip',
  play_property: null,           // cue
  play_action: 'action',         // virtual → chud only; the card's snap is a cue
  rent_charged: 'demand',
  demand: 'demand',
  opsec: 'opsec',
  action_blocked: 'blocked',
  payment: 'chip_pay',           // virtual → sour when I am the payer
  insolvent: 'sour',
  steal: 'steal',                // virtual → sour when I am the victim
  set_stolen: 'steal',
  swap: 'steal',
  upgrade: 'upgrade',
  move_property: null,           // cue
  set_completed: 'set_progress', // virtual → the ladder rung
  discard: null,                 // cue
  turn_end: null,                // turn_start of the next player is the beat
  scoop: 'scoop',
  win: 'fanfare',
  stalemate: 'stalemate',
  final_approach: 'klaxon',
  final_approach_broken: 'approach_broken',
});

/** FX_CUE kind → sound name. null = fx/'s alone; see the header. */
const SFX_FOR_CUE = Object.freeze({
  [CUE.FLIGHT_START]: 'card_slide',
  [CUE.LANDED]: 'card_snap',
  [CUE.FLIP]: 'card_flip',
  [CUE.DEAL_DONE]: 'deal_done',
  [CUE.SHUFFLE]: 'shuffle_riffle',
  [CUE.PICKUP]: 'card_pickup',
  [CUE.DENIED]: 'denied',
  [CUE.DETAILS]: 'ui_tick',
  [CUE.SET_COMPLETED]: null,
  [CUE.STEAL_LANDED]: null,
  [CUE.OPSEC_CLASH]: null,
  [CUE.ACTION_BLOCKED]: null,
  [CUE.PAYMENT_DONE]: null,
  [CUE.TURN_START]: null,
  [CUE.FINAL_APPROACH]: null,
  [CUE.APPROACH_BROKEN]: null,
  [CUE.WIN]: null,
  [CUE.STALEMATE]: null,
});

function selfId() { return store.self.id; }

/** The player who LOSES something in this event, if any. */
function victimOf(ev) {
  if (!ev) return null;
  return ev.from != null ? ev.from : (ev.target != null ? ev.target : null);
}

/**
 * §7: "events happening to you are louder/centred". The relay only knows
 * `ev.actor === selfId`, which is false for every event that happens TO you —
 * a payment you make, a set stolen off your board, a rent aimed at you.
 */
function mineFor(ev, fallback) {
  const me = selfId();
  if (!ev || !me) return fallback;
  if (ev.actor === me || ev.to === me || ev.from === me || ev.target === me) return true;
  if (ev.winner === me || ev.against === me || ev.by === me) return true;
  if (Array.isArray(ev.targets) && ev.targets.indexOf(me) >= 0) return true;
  return fallback;
}

function resolve(name) {
  const ev = cur.ev;
  switch (name) {
    case 'action':
      return ev && ev.action === 'chud' ? 'chud' : null;
    case 'turn':
      return ev && ev.actor === selfId() ? 'turn_mine' : 'turn_other';
    case 'chip_pay':
      return victimOf(ev) === selfId() ? 'sour' : 'chip_pay';
    case 'steal':
      return victimOf(ev) === selfId() ? 'sour' : 'steal';
    case 'set_progress': {
      // The rung is the actor's set count AFTER this completion. store.snapshot
      // is already the new one when the choreographer runs (state/store.js
      // replaces it before enqueue), so this is a read, not a tally we could
      // drift on when a set breaks and re-forms.
      const n = ev && ev.actor ? completeSetsOf(ev.actor).length : 1;
      return `set_progress_${clamp(n - 1, 0, 3) | 0}`;
    }
    default:
      return name;
  }
}

/* ── the final-approach bed (§3.10, §7) ─────────────────────────────────── */

/** Player ids currently armed. More than one can be armed at a time (§3.10). */
const armed = new Set();

let bedDrone = null;
let bedSubOsc = null;
let bedGain = null;
let bedNext = 0;
let bedSub = null;
let bedTicks = 0;

const BED_INTERVAL = 0.62;      // one tick per 620ms — a slow clock, not a pulse
const BED_LOOKAHEAD = 0.25;

function startBed() {
  if (!graph || bedSub || !enabled || urlMuted) return;
  const ctx = graph.ctx;
  bedGain = ctx.createGain();
  bedGain.gain.value = 0.0001;
  bedGain.connect(graph.bedBus);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 110;
  lp.Q.value = 0.8;
  lp.connect(bedGain);

  bedDrone = ctx.createBufferSource();
  bedDrone.buffer = graph.noise.brown;
  bedDrone.loop = true;
  bedDrone.connect(lp);
  bedDrone.start(ctx.currentTime);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 41.2;                 // E1 — under everything else
  const sg = ctx.createGain();
  sg.gain.value = 0.28;
  sub.connect(sg); sg.connect(bedGain);
  sub.start(ctx.currentTime);
  bedSubOsc = sub;

  bedGain.gain.setValueAtTime(0.0001, ctx.currentTime);
  bedGain.gain.exponentialRampToValueAtTime(0.55, ctx.currentTime + 0.8);

  bedNext = ctx.currentTime + 0.3;
  bedSub = clock.subscribe(pumpBed);
}

function stopBed() {
  if (bedSub) { bedSub(); bedSub = null; }
  const g = bedGain;
  const d = bedDrone;
  const s = bedSubOsc;
  bedGain = null;
  bedDrone = null;
  bedSubOsc = null;
  if (!graph || !g) return;
  const t = graph.ctx.currentTime;
  try {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    if (d) d.stop(t + 0.5);
    if (s) s.stop(t + 0.5);
  } catch { /* a node already stopped is the state we wanted */ }
}

/**
 * Schedules the bed's ticks ahead of the audio clock. Runs on core/clock.js
 * (§0.6, one clock) rather than setInterval, so it stops with the rest of the
 * client when the tab is hidden and cannot dump a backlog on return.
 */
function pumpBed() {
  if (!graph || !bedGain) return;
  const now = graph.ctx.currentTime;
  if (bedNext < now) bedNext = now + 0.02;
  let guard = 0;
  while (bedNext < now + BED_LOOKAHEAD && guard++ < 6) {
    // mine:true here means "centred and unfiltered", not "yours" — a bed has no
    // owner, and bedBus already holds it at -22dB.
    if (fire(graph, 'tension_tick', bedNext, voiceOpts(true, false, 1), true)) bedTicks++;
    bedNext += BED_INTERVAL;
  }
}

function arm(id) {
  if (id == null) return;
  armed.add(id);
  startBed();
}

function disarm(id) {
  if (id != null) armed.delete(id);
  else armed.clear();
  if (!armed.size) stopBed();
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

// Registered at module-eval time, which is before main.js's boot() installs the
// relay that calls play(). bus.js dispatches in registration order, so `cur.ev`
// is always the event play() is about to be asked to sound — that ordering is
// what lets `resolve()` tell paying from being paid without the relay changing.
bus.on(EVENTS.CHOREO_SFX, (msg) => {
  const ev = (msg && msg.ev) || null;
  cur.ev = ev;
  cur.mine = !!(msg && msg.mine);
  if (!ev) return;
  if (ev.t === 'final_approach') arm(ev.actor);
  else if (ev.t === 'final_approach_broken') disarm(ev.actor);
  else if (ev.t === 'win' || ev.t === 'stalemate' || ev.t === 'game_start') disarm(null);
});

// The relay has run by now (choreographer emits CHOREO_SFX, then CHOREO_EVENT),
// so drop the event: a later audio.play() from ui/ or interact/ must not inherit
// somebody else's steal as its context.
bus.on(EVENTS.CHOREO_EVENT, () => { cur.ev = null; cur.mine = false; });

bus.on(EVENTS.FX_CUE, (c) => {
  if (!c) return;
  const name = SFX_FOR_CUE[c.kind];
  if (!name) return;
  emit(name, !!c.mine, !!c.big, 1);
});

// A game that ended, a fixture injection or a reconnect must never leave the
// alarm running under a lobby screen.
bus.on(EVENTS.STATE_APPLIED, (p) => {
  const snap = p && p.snapshot;
  if (!snap || snap.phase !== 'playing') disarm(null);
});

/* ── harness bridge (§9) ────────────────────────────────────────────────── */

/** Every sound in the bank. tools/audiotest.mjs renders each of these. */
export function list() { return NAMES.slice(); }

/**
 * Render ONE sound through the real chain in an OfflineAudioContext.
 *
 * `mine:true, big:true` is the worst case for level, which is the case the
 * peak assertion wants; master gain is unity rather than the player's volume so
 * the measurement is of the GRAPH's ceiling (softClipCeiling ≈ 0.933) and not of
 * whatever the settings happen to say. `?mute=1` cannot zero it — that flag was
 * how gatecrash's offline render once produced silence and passed.
 *
 * @returns {Promise<{channels: Float32Array[], sampleRate: number, peak: number}>}
 */
export async function renderOffline(name, seconds = 1.5) {
  const g = await renderInto(seconds, (gr) => {
    if (!BANK[name]) return;
    fire(gr, name, 0.005, { mine: true, big: true, gain: 1, pan: 0, pitch: 1 }, false);
  });
  return g;
}

/**
 * Render a whole recorded sfxLog through the real chain — the summed worst case
 * §7 cares about. Feed it `__CHUD.sfxLog` from a finished playtest.
 *
 * @param {Array<{name:string, t:number, mine?:boolean, big?:boolean}>} entries
 *        `t` in ms, relative to the first entry.
 */
export async function renderMix(entries, seconds = 8) {
  const list0 = Array.isArray(entries) ? entries : [];
  const t0 = list0.length ? list0[0].t : 0;
  let claimed = 0;
  let dropped = 0;
  let peak = 0;
  const out = await renderInto(seconds, (gr) => {
    // A local budget, so the measurement is this sequence's and the live
    // engine's counters are left alone.
    const ends = [];
    for (const e of list0) {
      const at = (e.t - t0) / 1000;
      if (at < 0 || at > seconds) continue;
      const spec = VOICE[e.name] || [0.3, 2, false];
      // Replay the live budget rule offline: reap by scheduled end, then claim.
      let load = 0;
      for (let i = ends.length - 1; i >= 0; i--) {
        if (ends[i][0] <= at) ends.splice(i, 1); else load += ends[i][1];
      }
      if (load > peak) peak = load;
      if (!spec[2] && load + spec[1] > MAX_VOICES) { dropped++; continue; }
      ends.push([at + spec[0], spec[1]]);
      claimed++;
      if (BANK[e.name]) {
        fire(gr, e.name, at + 0.002, voiceOpts(!!e.mine, !!e.big, 1), false);
      }
    }
  });
  out.voices = { peak, claimed, dropped, cap: MAX_VOICES };
  return out;
}

async function renderInto(seconds, schedule) {
  const OC = typeof window !== 'undefined'
    ? window.OfflineAudioContext || window.webkitOfflineAudioContext : null;
  if (!OC) throw new Error('OfflineAudioContext unavailable');
  const sr = 48000;
  const ctx = new OC(2, Math.max(1, Math.ceil(seconds * sr)), sr);
  const g = buildGraph(ctx, 1);
  schedule(g);
  const buf = await ctx.startRendering();
  const channels = [buf.getChannelData(0), buf.getChannelData(1)];
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i];
      if (a > peak) peak = a;
    }
  }
  return { channels, sampleRate: buf.sampleRate, peak };
}

export function stats() {
  return {
    status,
    started: !!graph,
    enabled,
    urlMuted,
    volume,
    voices: voiceLoad,
    peakVoices: peakVoiceLoad,
    maxVoices: MAX_VOICES,
    dropped: droppedVoices,
    ceiling: softClipCeiling(0.7),
    armed: armed.size,
    bed: !!bedGain,
    bedTicks,
    sampleRate: graph ? graph.ctx.sampleRate : 0,
    counts: { ...played },
  };
}

/** The §9 contract the P2 harness asked for. */
export function harnessApi() {
  return { list, renderOffline, renderMix, stats };
}

/**
 * harness.js builds its bridge object, calls setRecorder(), and only then
 * assigns window.__CHUD (harness.js:86 → :100). A microtask therefore lands
 * after the assignment in the same task, with no polling and no timer.
 *
 * HOOKUP REQUEST (architect): one line in harness.js — `bridge.audio =
 * audio.harnessApi();` — retires this.
 */
function attachBridge(tries) {
  if (typeof window === 'undefined' || !recorder) return;
  if (window.__CHUD) { window.__CHUD.audio = harnessApi(); return; }
  if (tries > 8) return;
  queueMicrotask(() => attachBridge(tries + 1));
}
