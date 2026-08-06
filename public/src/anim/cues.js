// anim/cues.js — the FX cue bus. The ONE channel P5 (audio/, fx/) subscribes to.
//
// Why a second channel next to CHOREO_SFX: CHOREO_SFX carries the engine event
// (`{name:'payment', ev, mine}`) — one message for a five-card caravan, with no
// screen position. Sound and confetti need the opposite grain: one cue per card
// that actually lands, at the pixel where it landed, flagged for weight. So the
// choreographer emits SFX per EVENT and this file emits cues per PHYSICAL BEAT.
//
// Payload: { kind, mine, big, at:{x,y} }
//   kind — one of CUE below, and nothing else. Subscribers switch on it.
//   mine — it happened to or for the viewing player (§7: yours is louder/centred).
//   big  — this beat carries drama (a steal, a completed set, a win, or a card
//          that crossed more than a third of the screen). Not "loud" — the audio
//          agent decides what big means for its bus.
//   at   — viewport px, the centre of the thing that moved. fx/ anchors sparks,
//          floating text and shake epicentres on it.
//
// Cues fire under prefers-reduced-motion too: motion collapses, the game does
// not go silent (§0.9).

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';

export const CUE = Object.freeze({
  // table motion (anim/)
  FLIGHT_START: 'card_flight_start',
  LANDED: 'card_landed',
  FLIP: 'card_flip',
  DEAL_DONE: 'deal_done',
  SHUFFLE: 'shuffle',
  SET_COMPLETED: 'set_completed',
  STEAL_LANDED: 'steal_landed',
  OPSEC_CLASH: 'opsec_clash',
  ACTION_BLOCKED: 'action_blocked',
  PAYMENT_DONE: 'payment_done',
  TURN_START: 'turn_start',
  FINAL_APPROACH: 'final_approach',      // §3.10 armed — the game's peak, big
  APPROACH_BROKEN: 'approach_broken',
  WIN: 'win',
  STALEMATE: 'stalemate',
  // interaction (interact/ emits these itself, same payload shape)
  PICKUP: 'card_pickup',
  DENIED: 'denied',
  DETAILS: 'card_details',
});

/** One cue. Two small allocations per BEAT — never per frame. */
export function cue(kind, mine, big, x, y) {
  bus.emit(EVENTS.FX_CUE, {
    kind,
    mine: !!mine,
    big: !!big,
    at: { x: Math.round(x) || 0, y: Math.round(y) || 0 },
  });
}

/** Cue anchored on an element's centre. Costs one layout read — beats only. */
export function cueEl(kind, mine, big, el) {
  if (!el) { cue(kind, mine, big, 0, 0); return; }
  const r = el.getBoundingClientRect();
  cue(kind, mine, big, r.left + r.width / 2, r.top + r.height / 2);
}
