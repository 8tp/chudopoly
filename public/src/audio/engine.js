// audio/engine.js — P5 STUB with the real interface.
//
// §7: no AudioContext before a user gesture, and every call no-ops silently
// until init(). This file keeps that contract already, so the audio agent fills
// in synthesis behind `play()` without any caller changing. Under ?harness=1 a
// recorder is installed instead of a context and every trigger lands in
// __CHUD.sfxLog (§9).

let ctx = null;
let enabled = true;
let recorder = null;
let unlocked = false;

export function setRecorder(fn) { recorder = fn; }
export function setEnabled(on) { enabled = !!on; }
export function isEnabled() { return enabled; }
export function isReady() { return !!ctx; }

/** Call from a real user gesture only. Safe to call repeatedly. */
export function init() {
  if (ctx || recorder) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    unlocked = true;
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * @param {string} name  vocabulary from §7 (card_slide, card_snap, chip, chime_0…)
 * @param {{gain?:number, mine?:boolean, rate?:number}} opts
 */
export function play(name, opts = {}) {
  if (!enabled) return;
  if (recorder) { recorder(name, opts); return; }
  if (!unlocked || !ctx) return;
  // P5: synthesis lands here. Deliberately silent until then — a placeholder
  // beep is worse than nothing and would ship if it were here.
}

export function suspend() { try { ctx?.suspend(); } catch { /* ignore */ } }
export function resume() { try { ctx?.resume(); } catch { /* ignore */ } }

/** Engine-event → sound name. The audio agent owns the values; the keys are §4. */
export const SFX_FOR_EVENT = Object.freeze({
  deal: 'card_slide', draw: 'card_slide', shuffle: 'shuffle_riffle',
  play_money: 'chip', play_property: 'card_snap', play_action: 'card_snap',
  rent_charged: 'demand', demand: 'demand', opsec: 'opsec',
  action_blocked: 'block', payment: 'chip_pay', insolvent: 'sour',
  steal: 'sour_steal', set_stolen: 'sour_steal', swap: 'card_slide',
  upgrade: 'chime_up', move_property: 'card_slide', set_completed: 'chime_set',
  discard: 'card_slide', turn_start: 'turn', turn_end: 'turn_end',
  scoop: 'sour', win: 'fanfare', stalemate: 'flat', game_start: 'deal_start',
});
