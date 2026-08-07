// audio/music.js — generative score. Owner: audio/ (§1).
//
// Synthesized, like everything else in this directory: §0.3 forbids a binary
// asset anywhere in the repo and that includes a music file. There is no loop
// to load, so there is no loop to recognise — every bar is scheduled from a
// seeded rng against a fixed harmonic plan, which is also the answer to "does a
// bed grate by turn 10" (see THE MATCH BED below).
//
// ── AUTOPLAY (§7, §10) ─────────────────────────────────────────────────────
// This module builds nothing at import time and holds no AudioContext. It is
// handed the graph by engine.js AFTER engine.init() has run from a real
// pointerdown, and every entry point is a no-op until then. Under the harness
// recorder it never starts at all — a headless tool must not create a context.
//
// ── ONE KEY, TWO BEDS, ONE PEDAL ───────────────────────────────────────────
// Everything is A natural minor, and that is not a taste decision: the
// final-approach tension bed in engine.js runs a 41.2Hz sub, E1 — the DOMINANT
// of A minor. So when §3.10 arms, the score does not have to stop and get out
// of the way; the match bed drops its root and leaves the fifth, the tension
// bed's E1 reinforces it, and the harmony sits on an unresolved dominant pedal
// for exactly as long as the final approach lasts. The alarm IS the harmony.
//
//   menu   Am | F | G | Am, 66bpm, pad + sparse bugle + brushed backbeat
//   match  a two-note drone (A1 + E2) and nothing else
//   armed  match root fades, E pedal remains, engine.js's tension clock enters
//
// ── SONIC IDENTITY ─────────────────────────────────────────────────────────
// §6's "night flight line": crisp, physical, a little military-formal. The
// instruments are the SAME primitives as the card sounds — the brass is the
// fanfare's trick (a lowpass tracking the envelope over a sawtooth stack), the
// backbeat is the same brushed noise burst as a card sliding on felt, the pad
// is the sour cue's oscillator pair with the tritone taken out. Nothing here is
// a synth patch that could not also be a card landing.

import * as clock from '../core/clock.js';
import { makeRng } from '../core/rng.js';
import { dbToGain, clamp, EPS, perc, swell, glide } from './dsp.js';

/* ── the plan ───────────────────────────────────────────────────────────── */

const A2 = 110.0;                       // tonic. Everything is a ratio of this.
const SEMI = Math.pow(2, 1 / 12);
function st(n) { return Math.pow(SEMI, n); }

/** A natural minor scale degrees, in semitones from A. */
const MINOR = [0, 2, 3, 5, 7, 8, 10];

const BPM = 66;                         // a walk, not a march
const BEAT = 60 / BPM;                  // 0.909s
const BAR = BEAT * 4;                   // 3.636s

/**
 * Am | F | G | Am — Aeolian, with the bVI–bVII approach that reads ceremonial
 * rather than sad. Each entry is [root semitones from A, third, fifth]; the
 * voicing drops the third out of the pad and keeps open fifths, which is what
 * stops a sustained pad from sounding like a pop chord.
 */
const PROGRESSION = [
  [0, 3, 7],      // Am
  [-4, 4, 7],     // F
  [-2, 4, 7],     // G
  [0, 3, 7],      // Am
];

/**
 * Five bugle shapes, in scale degrees. The scheduler picks one per phrase and
 * transposes it into the current chord, so a 4-bar phrase is 14.5s and the
 * shape sequence does not repeat for 5 phrases (72s) — long enough that the
 * menu has no audible loop point at the time anyone spends on it (measured
 * median time on the home screen in tools/playtest.mjs: 4.1s).
 */
const MOTIFS = [
  [[0, 0], [4, 1.0]],
  [[4, 0], [2, 0.75], [0, 1.5]],
  [[0, 0], [2, 0.5], [4, 1.0]],
  [[7, 0], [4, 1.25]],
  [[0, 0], [-3, 1.0], [0, 1.75]],
];

/* ── module state ───────────────────────────────────────────────────────── */

let g = null;                           // the engine's graph handle, or null
let out = null;                         // user volume
let duck = null;                        // sidechain from the sfx stings
let sub = null;                         // clock subscription
let rng = makeRng('chudopoly-music');

let mode = 'off';                       // off | menu | match
let want = 'off';                       // what the app asked for, even if muted
let enabled = true;
let level = 0.7;
let tension = false;

let nextBar = 0;                        // absolute context time of the next bar
let bar = 0;                            // bar counter since start
let motif = 0;
let nextAir = 0;                        // next hangar-air swell

// Persistent nodes of the match drone, so arming can fade one voice out without
// rebuilding anything.
let drone = null;

// CPU accounting, reported by stats().
let nodesMade = 0;
let pumps = 0;
let pumpMs = 0;

const LOOKAHEAD = 0.45;                 // schedule this far ahead of the clock
const FADE = 0.9;                       // bed crossfades

/* ── plumbing ───────────────────────────────────────────────────────────── */

/** Called by engine.js once the graph exists. Idempotent. */
export function attach(graph) {
  if (!graph || g === graph) return;
  detach();
  g = graph;
  out = graph.ctx.createGain();
  out.gain.value = 0.0001;
  duck = graph.ctx.createGain();
  duck.gain.value = 1;
  out.connect(duck);
  duck.connect(graph.musicBus);
  if (want !== 'off') start(want);
}

export function detach() {
  stopAll(0);
  if (sub) { sub(); sub = null; }
  out = null;
  duck = null;
  g = null;
  mode = 'off';
}

export function setEnabled(on) {
  enabled = !!on;
  if (!enabled) stopAll(0.5);
  else if (want !== 'off') start(want);
}

export function isEnabled() { return enabled; }

export function setVolume(v) {
  level = clamp(Number(v) || 0, 0, 1);
  rampOut();
}

export function getVolume() { return level; }

/**
 * What the app wants playing: 'menu' on home/lobby, 'match' in a game, 'off'
 * when the tab is hidden or sound is off. Safe to call every state broadcast —
 * a request for the mode already playing does nothing.
 */
export function set(which) {
  want = which;
  if (which === 'off') { stopAll(FADE); return; }
  start(which);
}

/** §3.10 armed/disarmed. The match bed answers by dropping its root (see head). */
export function setTension(on) {
  const t = !!on;
  if (t === tension) return;
  tension = t;
  if (!g || !drone) return;
  const now = g.ctx.currentTime;
  // The root goes; the fifth (E) stays and becomes the pedal the tension bed's
  // 41.2Hz sub reinforces an octave down.
  const p = drone.rootGain.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, EPS), now);
  p.exponentialRampToValueAtTime(t ? EPS : 0.5, now + 1.2);
  // ...and the filter closes, so what is left is darker as well as unresolved.
  glide(drone.lp.frequency, now, drone.lp.frequency.value, t ? 130 : 240, 1.2);
}

/**
 * Duck the score under a sting. engine.js calls this for every PRIORITY voice
 * (the tier 0/1 moments), which is the whole reason a bed can exist under a
 * card game at all: for the 40% of wall-clock that a real game is making noise
 * the music steps back 7dB, and for the 60% it is silent (measured over a full
 * seeded game: 17 gaps over 1.5s, 89.9s of 150s) the music is the only thing
 * there. It fills the silence and never competes with a consequence.
 */
export function dip(weight) {
  if (!duck || !g || mode === 'off') return;
  const now = g.ctx.currentTime;
  const depth = weight >= 6 ? 0.34 : weight >= 4 ? 0.45 : 0.55;
  const p = duck.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, EPS), now);
  p.linearRampToValueAtTime(depth, now + 0.025);
  p.exponentialRampToValueAtTime(1, now + 0.025 + (weight >= 6 ? 0.6 : 0.28));
}

export function stats() {
  return {
    mode, enabled, level, tension,
    nodes: nodesMade,
    pumps,
    // Mean cost of the scheduler callback, in ms per frame. The bed is a
    // lookahead scheduler on core/clock.js (§0.6), so the steady-state frame
    // cost is one float compare; the mean below includes the bars where it
    // actually builds nodes.
    pumpMsMean: pumps ? pumpMs / pumps : 0,
  };
}

/* ── transport ──────────────────────────────────────────────────────────── */

function rampOut() {
  if (!g || !out) return;
  const now = g.ctx.currentTime;
  const target = enabled && mode !== 'off' ? Math.max(level, 0.0001) : 0.0001;
  const p = out.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, EPS), now);
  p.exponentialRampToValueAtTime(target, now + FADE);
}

function start(which) {
  if (!g || !out || !enabled) return;
  if (mode === which) return;
  stopAll(0.4);
  mode = which;
  rng = makeRng(`chudopoly-music-${which}`);
  bar = 0;
  motif = 0;
  const now = g.ctx.currentTime;
  nextBar = now + 0.12;
  nextAir = now + 6 + rng() * 8;
  if (which === 'match') startDrone();
  if (!sub) sub = clock.subscribe(pump);
  rampOut();
}

function stopAll(fade) {
  const wasMode = mode;
  mode = 'off';
  tension = false;
  if (!g || !out) { drone = null; return; }
  const now = g.ctx.currentTime;
  const p = out.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, EPS), now);
  p.exponentialRampToValueAtTime(0.0001, now + Math.max(fade, 0.05));
  stopDrone(now + Math.max(fade, 0.05) + 0.1);
  if (wasMode !== 'off' && sub) { sub(); sub = null; }
}

/**
 * The lookahead scheduler. Runs on core/clock.js rather than setInterval (§0.6,
 * one clock), so it stops with the rest of the client when the tab is hidden
 * and cannot dump a backlog of bars on return — `nextBar` is snapped forward
 * instead of caught up.
 */
function pump() {
  if (!g || mode === 'off') return;
  const t0 = performance.now();
  const now = g.ctx.currentTime;
  if (nextBar < now - 1) { nextBar = now + 0.05; bar = 0; }   // returned from hidden
  let guard = 0;
  while (nextBar < now + LOOKAHEAD && guard++ < 4) {
    if (mode === 'menu') scheduleMenuBar(nextBar, bar);
    nextBar += BAR;
    bar++;
  }
  if (nextAir && now + LOOKAHEAD > nextAir) {
    air(nextAir);
    nextAir += (mode === 'menu' ? 14 : 15) + rng() * 8;
  }
  pumps++;
  pumpMs += performance.now() - t0;
}

/* ── voices ─────────────────────────────────────────────────────────────── */

function gain(v) { nodesMade++; const n = g.ctx.createGain(); n.gain.value = v; return n; }

function osc(type, hz, t0, tEnd) {
  nodesMade++;
  const o = g.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(hz, 0.01), t0);
  o.start(t0);
  if (tEnd) o.stop(tEnd);
  return o;
}

function filt(type, hz, q = 1) {
  nodesMade++;
  const f = g.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.max(10, hz);
  f.Q.value = q;
  return f;
}

function noiseSrc(kind, t0, dur, rate = 1) {
  nodesMade++;
  const s = g.ctx.createBufferSource();
  const buf = g.noise[kind] || g.noise.pink;
  s.buffer = buf;
  s.playbackRate.value = rate;
  const maxOff = Math.max(0, buf.duration - dur * rate - 0.01);
  s.start(t0, rng() * maxOff, dur * rate + 0.01);
  s.stop(t0 + dur + 0.02);
  return s;
}

/* ── THE MENU BED ────────────────────────────────────────────────────────
 *
 * Four layers, one bar at a time. It has a PULSE — that is the difference
 * between "sit down at a table" and ambient wallpaper, and it is the whole
 * brief. The pulse is brushed noise on 2 and 4, which is the card_slide voice
 * with a shorter envelope, so the menu and the game are the same instrument.
 */
function scheduleMenuBar(t, index) {
  const chord = PROGRESSION[index % PROGRESSION.length];
  const root = A2 * st(chord[0]);

  /* 1. pad — open fifth, no third. Two detuned saws and a sub sine. */
  const padLp = filt('lowpass', 620, 0.9);
  const padEnv = gain(0);
  padLp.connect(padEnv); padEnv.connect(out);
  // A slow open/close across the bar: the pad breathes rather than sits.
  padLp.frequency.setValueAtTime(520, t);
  padLp.frequency.exponentialRampToValueAtTime(900, t + BAR * 0.45);
  padLp.frequency.exponentialRampToValueAtTime(480, t + BAR);
  for (const [mult, amp, det] of [[1, 0.3, 1], [1, 0.24, 1.006], [st(chord[2]), 0.2, 0.997], [0.5, 0.26, 1]]) {
    const vg = gain(amp);
    const ov = osc(mult === 0.5 ? 'sine' : 'sawtooth', root * mult * det, t, t + BAR + 0.9);
    ov.connect(vg); vg.connect(padLp);
  }
  swell(padEnv.gain, t, 0.19, 0.55, BAR * 0.4, BAR * 0.55);

  /* 2. bugle — bars 0 and 2 of the phrase only. Sparse by construction: never
        more than 3 notes in 7.3s, so it reads as a call, not a tune. */
  if (index % 2 === 0) {
    if (index % 4 === 0) motif = (motif + 1 + Math.floor(rng() * (MOTIFS.length - 1))) % MOTIFS.length;
    const shape = MOTIFS[motif];
    for (const [deg, at] of shape) {
      const hz = root * st(degreeSemis(deg)) * 2;      // an octave up: a bugle
      brass(hz, t + at * BEAT, 0.85, 0.085);
    }
  }

  /* 3. backbeat — a brushed tick on 2 and 4, a soft floor thump on 1. */
  for (const b of [1, 3]) brush(t + b * BEAT, b === 3 ? 0.055 : 0.07);
  thumpAt(t, 0.075);
  if (index % 4 === 3) thumpAt(t + BEAT * 3.5, 0.05);    // a turnaround pickup
}

/** Degree index (may be negative) → semitones, wrapping the A-minor scale. */
function degreeSemis(deg) {
  const n = MINOR.length;
  const oct = Math.floor(deg / n);
  const i = ((deg % n) + n) % n;
  return MINOR[i] + oct * 12;
}

/**
 * Brass without samples: a sawtooth stack under a lowpass that OPENS on the
 * attack and closes through the note. Same construction as BANK.fanfare — the
 * menu and the victory are deliberately the same instrument, so the fanfare
 * sounds like the theme paying off rather than like a different game.
 */
function brass(hz, t, dur, amp) {
  const lp = filt('lowpass', 420, 1.1);
  const env = gain(0);
  lp.connect(env); env.connect(out);
  lp.frequency.setValueAtTime(420, t);
  lp.frequency.exponentialRampToValueAtTime(2400, t + 0.07);
  lp.frequency.exponentialRampToValueAtTime(700, t + dur);
  for (const [mult, a, det] of [[1, 0.34, 1], [1, 0.22, 1.005], [2, 0.08, 1]]) {
    const vg = gain(a);
    const ov = osc('sawtooth', hz * mult * det, t, t + dur + 0.06);
    ov.connect(vg); vg.connect(lp);
  }
  swell(env.gain, t, amp, 0.035, dur * 0.35, dur * 0.6);
}

/** The backbeat: card_slide's noise burst with a 40ms envelope on it. */
function brush(t, amp) {
  const bg = gain(0);
  const bp = filt('bandpass', 2600, 1.6);
  const hp = filt('highpass', 900, 0.7);
  const n = noiseSrc('pink', t, 0.075, 1.15);
  n.connect(hp); hp.connect(bp); bp.connect(bg); bg.connect(out);
  glide(bp.frequency, t, 2100, 3600, 0.05);
  perc(bg.gain, t, amp, 0.006, 0.055);
  n.onended = () => { try { hp.disconnect(); } catch { /* already gone */ } };
}

function thumpAt(t, amp) {
  const tg = gain(0);
  const o = osc('sine', 74, t, t + 0.22);
  glide(o.frequency, t, 74, 44, 0.13);
  o.connect(tg); tg.connect(out);
  perc(tg.gain, t, amp, 0.008, 0.17);
}

/* ── THE MATCH BED ───────────────────────────────────────────────────────
 *
 * A drone and nothing else: A1 + E2 + a brown floor, one filter drifting on a
 * 22s LFO, plus a hangar-air swell every 15–23s.
 *
 * THE FATIGUE ARGUMENT, since a bed that grates by turn 10 is worse than
 * silence. It has no rhythm, no melody and no loop — there is no repeating
 * figure for attention to latch onto, and the only motion is a filter LFO whose
 * period (22s) is prime against the air swell's (15–23s), so the texture never
 * lands in the same place twice. It is also 22dB under the quietest STING and
 * ducks another 5–9dB under every one of them (dip()).
 *
 * Measured justification for having it at all: a full seeded 3-player game
 * (scratchpad r6, real bot pacing) spends 89.9s of its 150s wall clock with NO
 * sfx onset inside 1.5s — 60% of the game is silence. That is the "under-fed"
 * complaint, and it is what this occupies. In the bot-storm case (400ms
 * cadence, scratchpad r9-400) there is not one gap over 1.5s in 79.5s, and
 * there the bed is ducked essentially continuously, which is correct.
 */
function startDrone() {
  if (drone) return;
  const now = g.ctx.currentTime;
  const lp = filt('lowpass', 240, 1.1);
  const dg = gain(0);
  lp.connect(dg); dg.connect(out);

  // 22s drift on the cutoff. An oscillator into an AudioParam costs nothing per
  // frame — this is why there is no JS running for the match bed at all.
  const lfo = osc('sine', 1 / 22, now, 0);
  const lfoAmt = gain(70);
  lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);

  const rootGain = gain(0.5);
  const rv = osc('sine', A2 / 2, now, 0);                 // A1, 55Hz
  const rv2 = osc('triangle', A2 / 2 * 1.004, now, 0);
  const rg2 = gain(0.25);
  rv.connect(rootGain); rv2.connect(rg2); rg2.connect(rootGain);
  rootGain.connect(lp);

  // E2 (82.4Hz) — the fifth, an octave above the 41.2Hz sub the §3.10 tension
  // bed runs, which is what lets the alarm land IN the harmony (see the header).
  const fifth = gain(0.34);
  const fv = osc('triangle', A2 * st(7) * 0.5, now, 0);
  fv.connect(fifth); fifth.connect(lp);

  const floorG = gain(0.5);
  const fn = g.ctx.createBufferSource();
  nodesMade++;
  fn.buffer = g.noise.brown;
  fn.loop = true;
  fn.connect(floorG); floorG.connect(lp);
  fn.start(now);

  // Held, not enveloped: a 2.2s fade-in and then nothing scheduled at all, so
  // there is no automation event queued for the rest of the game.
  // 0.045, not 0.5: at 0.5 the offline render measured the bed at -8.9 dBFS
  // peak / -17.7 RMS, i.e. LOUDER than half the sting bank. -21dB puts it at
  // -30.6 peak / -39.2 RMS — under card_slide, the quietest routine sound.
  dg.gain.setValueAtTime(EPS, now);
  dg.gain.linearRampToValueAtTime(0.045, now + 2.2);
  drone = { lp, dg, rootGain, nodes: [rv, rv2, fv, fn, lfo] };
}

function stopDrone(at) {
  const d = drone;
  drone = null;
  if (!d || !g) return;
  const now = g.ctx.currentTime;
  try {
    d.dg.gain.cancelScheduledValues(now);
    d.dg.gain.setValueAtTime(Math.max(d.dg.gain.value, EPS), now);
    d.dg.gain.exponentialRampToValueAtTime(EPS, Math.max(at, now + 0.3));
    for (const n of d.nodes) n.stop(Math.max(at, now + 0.3) + 0.15);
  } catch { /* a node already stopped is the state we wanted */ }
}

/* ── offline render (§8, so the score is measured and not asserted) ─────── */

/**
 * Schedule `seconds` of one bed into an OfflineAudioContext graph, through the
 * real voices and the real musicBus. engine.renderMusic() wraps this; the
 * scratchpad mix table renders it next to every sting so "the music sits under
 * the mix" is a number.
 *
 * The module's live state is saved and restored around the call. That is safe
 * because everything below is synchronous — there is no await between the swap
 * and the restore, so a live game cannot observe the offline state.
 */
export function offline(graph, seconds, which) {
  const save = { g, out, duck, mode, rng, drone, nextAir, bar, motif };
  g = graph;
  out = graph.ctx.createGain();
  out.gain.value = 1;
  duck = graph.ctx.createGain();
  out.connect(duck);
  duck.connect(graph.musicBus);
  mode = which;
  rng = makeRng(`chudopoly-music-${which}`);
  drone = null;
  bar = 0;
  motif = 0;
  try {
    if (which === 'match') {
      startDrone();
      for (let t = 3; t < seconds; t += 16) air(t);
    } else {
      for (let t = 0.05, i = 0; t < seconds; t += BAR, i++) scheduleMenuBar(t, i);
      for (let t = 5; t < seconds; t += 15) air(t);
    }
  } finally {
    g = save.g; out = save.out; duck = save.duck; mode = save.mode;
    rng = save.rng; drone = save.drone; nextAir = save.nextAir;
    bar = save.bar; motif = save.motif;
  }
}

/** Air across a ramp: one wide, very quiet noise swell. Both beds use it. */
function air(t) {
  if (!g || mode === 'off') return;
  const bg = gain(0);
  const bp = filt('bandpass', 480, 0.55);
  nodesMade++;
  const p = g.ctx.createStereoPanner();
  p.pan.value = rng() < 0.5 ? -0.5 : 0.5;
  const n = noiseSrc('pink', t, 2.6, 0.55);
  n.connect(bp); bp.connect(bg); bg.connect(p); p.connect(out);
  glide(bp.frequency, t, 380, 900, 1.6);
  swell(bg.gain, t, mode === 'menu' ? 0.05 : 0.016, 1.0, 0.3, 1.2);
  n.onended = () => { try { bp.disconnect(); } catch { /* already gone */ } };
}
