// table/cardart.js — the printed face of every card ("flight-line technical order").
//
// ART-DIRECTION "APRON" §1–§2 in one module. The card is cream printed stock in
// BOTH themes; the table changes, the objects do not. Colour is disciplined to
// the band, the line-work and — for rents — the whole face. Everything is
// authored as text: inline SVG, zero binary assets (§0.3).
//
// ── THE OWNER DEFECT THIS FIXES ───────────────────────────────────────────
// "there is like an orange rent card but it's actually the wild — it was quite
// confusing what the actual card was and what it did." Every rent wore the same
// amber band, so the band said RENT and nothing said WHICH rent. Per
// ART-DIRECTION §6.3, a card announces its COLOURS before it announces its type:
//
//   pair rent  → the face IS the two set colours, split full-bleed, one glyph
//                per half, plus a small achromatic RENT medallion. No band.
//   any rent   → all ten set colours as a HARD-EDGED wheel (never a soft
//                gradient — a gradient reads as decoration, hard segments read
//                as "all of them"), plus the same medallion.
//   pair wild  → cream PROPERTY chassis, split band, both glyphs.
//   any wild   → cream PROPERTY chassis, the same ten-colour wheel as a
//                contained disc.
//
// So wild-rent and wild-property differ by CHASSIS, not by colour: on a rent the
// colour bleeds to the trim, on a wild it is contained on cream. Third channel:
// a wild's value coin reads 0M.
//
// ── TIERS ─────────────────────────────────────────────────────────────────
// Two markup tiers only, because table/cardnode.js builds a face ONCE and then
// only ever reparents the node (§0.4) — a card that moves from the hand to the
// board to an opponent's mini row must not need its face rebuilt:
//
//   'peek'  fixed ~248px, the read-me tier (ui/peek.js)
//   'hand'  the ONE in-game face. style/cardart.css degrades it with container
//           queries at ≤66 / ≤48 / ≤34px into what the old code called the
//           table and mini tiers. Nothing is re-rendered, only re-styled.
//
// ── NO INNER HTML ─────────────────────────────────────────────────────────
// tools/checkClient.mjs bans `.innerHTML =` / `insertAdjacentHTML` in table/ and
// anim/, because a rebuild mid-FLIP destroys the node the transform is running
// on. Markup is composed as a string and materialised ONCE through DOMParser,
// which is a parse, not a write into a live tree.
//
// ── SOURCE OF TRUTH ───────────────────────────────────────────────────────
// Set names, sizes, rent ladders and rule text come from core/cards.js, which
// mirrors game.js. This module adds ONLY what is genuinely presentational: a
// glyph and a short mono code per set. An earlier draft kept its own copy of the
// deck and had already drifted — it still described the CHUD card's 2M rider,
// removed from game.js in §3.1.

import { COLORS, COLOR_KEYS, cardText, cardName } from '../core/cards.js';

/* ── Presentational-only set metadata ─────────────────────────────────────
   Names / sizes / ladders are NOT duplicated here — see COLORS. */

const SET_CODE = {
  brown: 'DRONE', lightblue: 'TRNG', pink: 'SPACE', orange: 'TEST', red: 'FTR',
  yellow: 'MOB', green: 'ELITE', darkblue: 'CMD', base: 'BASE', intel: 'INTEL',
};

/** The SECOND of the two marks (ART §6 amendment, 2026-08-07).
 *
 *  MIL-STD-2525 carries air platform type as a Sector-1 letter — B bomber,
 *  C cargo, F fighter, K tanker, R recon — precisely because a drawing cannot
 *  be asked to survive every size. Below 34px this client stops asking the
 *  drawing and asks the code instead.
 *
 *  Uniformly THREE characters, not SET_CODE's 3–5: ten of these stand in a row
 *  on an opponent's board and a ragged set width reads as noise. Measured, the
 *  mini tier is 26–34px wide (style/cardart.css header), and three mono
 *  characters advance 1.8em, so `max(8px, 30cqw)` sets 7.8–10.2px type inside a
 *  26–34px card at 54% of its width — the 8px floor is checkContrast's own line
 *  between type and texture and this is the first card mark to clear it at that
 *  tier. SET_CODE is unchanged: it still owns the band and the wild's title,
 *  where there is room for the longer form. */
const SET_MARK = {
  brown: 'DRN', lightblue: 'TRN', pink: 'SPC', orange: 'T&E', red: 'FTR',
  yellow: 'MOB', green: 'ELT', darkblue: 'CMD', base: 'OSB', intel: 'INT',
};

/** Short face name where the deck name will not fit a small card on two lines.
 *  Every key is a real name from game.js buildDeck(). */
const PROP_SHORT = {
  'Lackland AFB (BMT)': 'LACKLAND',
  'KC-135 Stratotanker': 'KC-135',
  'C-17 Globemaster III': 'C-17',
  'C-130 Hercules': 'C-130',
  'F-35 Lightning II': 'F-35',
  'F-22 Raptor': 'F-22',
  'F-15 Eagle': 'F-15',
  'PAVE PAWS Radar': 'PAVE PAWS',
  'GPS Constellation': 'GPS',
  'The Pentagon': 'PENTAGON',
  'Air Force One': 'AIR FORCE ONE',
};

/** Action face names + the mono code the smallest tiers fall back to. */
const ACTIONS = {
  pcs_orders:           { name: 'PCS ORDERS',      code: 'PCS' },
  opsec:                { name: 'OPSEC',           code: 'OPS' },
  midnight_requisition: { name: 'MIDNIGHT REQ',    code: 'REQ' },
  tdy_orders:           { name: 'TDY ORDERS',      code: 'TDY' },
  finance_office:       { name: 'FINANCE OFFICE',  code: 'FIN' },
  roll_call:            { name: 'ROLL CALL',       code: 'RC'  },
  upgrade:              { name: 'UPGRADE',         code: 'UPG' },
  foc:                  { name: 'FOC',             code: 'FOC' },
  inspector_general:    { name: 'INSPECTOR GEN',   code: 'IG'  },
  surge_ops:            { name: 'SURGE OPS',       code: 'SRG' },
  chud:                 { name: 'THE CHUD CARD',   code: 'CHUD' },
};

/** Sub-line for the two actions whose deck name is a mouthful. */
const ACTION_SUB = {
  upgrade: 'HOUSE',
  foc: 'FULL OPERATIONAL CAPABILITY · HOTEL',
};

const MONEY_WORDS = { 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR', 5: 'FIVE', 10: 'TEN' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Geometry helpers ─────────────────────────────────────────────────────
   Authored as path data so the glyphs stay text (§0.3) and stay editable. */

function starPath(cx, cy, R, r, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = rot + (i * Math.PI) / 5;
    pts.push((cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2));
  }
  return 'M' + pts.join(' L') + ' Z';
}

function ngonPath(cx, cy, R, n, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    pts.push((cx + R * Math.cos(a)).toFixed(2) + ' ' + (cy + R * Math.sin(a)).toFixed(2));
  }
  return 'M' + pts.join(' L') + ' Z';
}

/** An annulus as a single evenodd path — a ring that survives being filled. */
function ringPath(cx, cy, R, r) {
  return `M${cx} ${cy - R} A${R} ${R} 0 1 0 ${cx} ${cy + R} A${R} ${R} 0 1 0 ${cx} ${cy - R} Z`
       + `M${cx} ${cy - r} A${r} ${r} 0 1 1 ${cx} ${cy + r} A${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
}

/** A solid arc band (annulus segment) from a0° to a1°, screen-clockwise. */
function bandArc(cx, cy, R, r, a0, a1) {
  const rad = (d) => (d * Math.PI) / 180;
  const P = (a, rr) => (cx + rr * Math.cos(rad(a))).toFixed(2) + ' ' + (cy + rr * Math.sin(rad(a))).toFixed(2);
  const la = a1 - a0 > 180 ? 1 : 0;
  return `M${P(a0, R)} A${R} ${R} 0 ${la} 1 ${P(a1, R)} L${P(a1, r)} A${r} ${r} 0 ${la} 0 ${P(a0, r)} Z`;
}

/** A solid triangular arrowhead riding an arc at radius m, pointing clockwise. */
function arcHead(cx, cy, m, a, len, halfw) {
  const rad = (d) => (d * Math.PI) / 180;
  const ux = Math.cos(rad(a)), uy = Math.sin(rad(a));
  const tx = -Math.sin(rad(a)), ty = Math.cos(rad(a));
  const bx = cx + m * ux, by = cy + m * uy;
  const p = (x, y) => x.toFixed(2) + ' ' + y.toFixed(2);
  return `M${p(bx + ux * halfw, by + uy * halfw)} L${p(bx + tx * len, by + ty * len)}`
       + ` L${p(bx - ux * halfw, by - uy * halfw)} Z`;
}

/** A bar of width w from (x0,y0) to (x1,y1). Authored as a filled quad, not a
 *  stroke: butt ends and mitre corners are ASME Y14.2 (there is no round cap
 *  anywhere in this system), and a fill cannot be thinned out of existence by a
 *  transform the way a stroke can. */
function bar(x0, y0, x1, y1, w) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
  const p = (x, y) => x.toFixed(2) + ' ' + y.toFixed(2);
  return `M${p(x0 + nx, y0 + ny)} L${p(x1 + nx, y1 + ny)}`
       + ` L${p(x1 - nx, y1 - ny)} L${p(x0 - nx, y0 - ny)} Z`;
}

/** The same bar laid along the ray at a°, between radii r0 and r1. */
function radialBar(cx, cy, r0, r1, a, w) {
  const rad = (a * Math.PI) / 180;
  const ux = Math.cos(rad), uy = Math.sin(rad);
  return bar(cx + r0 * ux, cy + r0 * uy, cx + r1 * ux, cy + r1 * uy, w);
}

/** One ship of the Elite four-ship: a swept delta, nose up, scaled about (cx,cy).
 *  Traced from the generic swept-delta planform shared by the FM 44-80 recognition
 *  plates and the Navy SAC 3-views — the same drawing as SET_GLYPHS.red at 1/4
 *  size, so the two marks are visibly one family. */
function shipPath(cx, cy, s) {
  const P = [[0, -6.5], [1.2, -1.5], [6, 4], [6, 5.6], [1.6, 4.9], [1.6, 6.5],
             [-1.6, 6.5], [-1.6, 4.9], [-6, 5.6], [-6, 4], [-1.2, -1.5]];
  return 'M' + P.map(([x, y]) =>
    (cx + x * s).toFixed(2) + ' ' + (cy + y * s).toFixed(2)).join(' L') + ' Z';
}

/** One hard-edged wedge of the ten-colour wheel, as an SVG path. */
function wedge(cx, cy, R, i, n) {
  const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / n;
  const x0 = (cx + R * Math.cos(a0)).toFixed(2), y0 = (cy + R * Math.sin(a0)).toFixed(2);
  const x1 = (cx + R * Math.cos(a1)).toFixed(2), y1 = (cy + R * Math.sin(a1)).toFixed(2);
  return `M${cx} ${cy} L${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} Z`;
}

/* ── SET GLYPHS ───────────────────────────────────────────────────────────
   Solid marks on a 48×48 viewBox, `currentColor` with knockouts in
   `--ca-knock`. Drawn as fills rather than strokes because a stroke width is
   not scaled by the container query ladder and a 2-unit stroke on a 48 viewBox
   is a sub-pixel smear on a board card.

   ── WHAT CHANGED, AND WHY (ART §6 amendment, 2026-08-07) ─────────────────
   The retired rule required every set glyph to survive as a 1-bit silhouette
   on a 14×14 raster. Three redraws optimised against that threshold check and
   the owner's verdict on the result was "this SVG art is just bad". Measured
   against the proof sheet, he was right on the specifics too:
     • pink   thresholded into a WITCH HAT — a triangle with two lobes.
     • red    was a fat arrow with a stub, not an aircraft.
     • lightblue was two apex-up chevrons: crude, AND that is an enlisted rank
       device, which 32 C.F.R. §507.9 forbids executing as a "colorable
       imitation". It also inverts the MIL-STD-2525 UAV mark (one wide chevron,
       apex DOWN), so it read as the wrong symbol to anyone who knows 2525.
     • green   was the four-point sparkle that every LLM product shipped in
       2025. It is the single most generic mark that could occupy that slot.
     • base    read as an X / crossed swords, not as an airfield.
     • intel   read as a pie chart with a clock hand.

   The mandate is retired and replaced by TWO MARKS per set: this drawing,
   which only has to answer from the table tier (≈25px) upward, and SET_MARK
   below, a 3-character code that owns the ≤34px tier. That is MIL-STD-2525's
   own split (air platform type is a Sector-1 letter) and it is what buys these
   drawings the right to carry interior detail.

   ── HOW THEY ARE DRAWN ────────────────────────────────────────────────────
   MIL-STD-38784B / ASME Y14.2: exactly two weights at 2:1 — heavy 4 units for
   object lines, thin 2 units for every rule, break and knockout. No rounded
   corner anywhere (every `rx` in the previous set is gone). No gradient, no
   blur, no soft shadow. Aircraft are TOP-DOWN PLANFORMS traced from the
   orthographic recognition corpus (FM 44-80 Visual Aircraft Recognition,
   PD-USGov-Military-Army; Navy Standard Aircraft Characteristics 3-views,
   PD-USGov), never from photographs — ATC Distribution v. Whatever It Takes
   (6th Cir. 2005). No CC BY-SA Commons 3-view was opened. */

const SET_GLYPHS = {
  /* Drone Ops — quadcopter: X frame, four rotor rings, avionics body. KEPT from
     the previous round; it was the one mark the proof sheet showed working, and
     it is structurally unlike everything else here. Square corners restored
     (the body carried rx="3") and the body given the sensor detail that the
     1-bit rule had forbidden. */
  brown: `
    <path d="M9.5 13 L13 9.5 L38.5 35 L35 38.5 Z"/>
    <path d="M35 9.5 L38.5 13 L13 38.5 L9.5 35 Z"/>
    <rect x="17.5" y="17.5" width="13" height="13"/>
    <rect x="19.5" y="19.5" width="9" height="9" fill="var(--ca-knock)"/>
    <rect x="21.5" y="21.5" width="5" height="5"/>
    ${[[12, 12], [36, 12], [12, 36], [36, 36]]
      .map(([x, y]) => `<path d="${ringPath(x, y, 8, 4.8)}"/>`).join('')}`,

  /* Training — the ATTITUDE INDICATOR: a square instrument case, a round dial,
     a solid ground below the horizon, a pitch ladder, the fixed wings symbol
     and a bank index. It replaces the rank chevrons on three counts: chevrons
     are service insignia (§507.9), apex-up stacked chevrons collide with the
     2525 UAV mark, and an ADI is what a student actually stares at. A solid
     square case is also the only rectilinear mass in the ten, so the set is
     nameable from silhouette alone. */
  lightblue: `
    <path d="M4 4 H44 V44 H4 Z M8 8 H40 V40 H8 Z"/>
    <path d="${ringPath(24, 24, 15.5, 13.5)}"/>
    <path d="M10.84 27 A13.5 13.5 0 0 0 37.16 27 Z"/>
    <path d="M24 10.8 L26.4 14.4 L21.6 14.4 Z"/>
    <rect x="18" y="17.4" width="12" height="2"/>
    <rect x="11.5" y="22.8" width="7" height="2"/>
    <rect x="29.5" y="22.8" width="7" height="2"/>
    <rect x="22.7" y="21.6" width="2.6" height="4.2"/>
    <g fill="var(--ca-knock)">
      <rect x="20.5" y="30.4" width="7" height="2"/>
      <rect x="18" y="33.8" width="12" height="2"/>
    </g>`,

  /* Space Force — MIL-STD-2525 entity 05 110700 (SATELLITE): a bus flanked by
     two solar arrays. A previous agent derived this form independently before
     anyone checked it against 2525, which is the strongest evidence available
     that it is the right shape. §105 public domain; no APP-6 was consulted.
     The array cell rules and the nadir antenna are what stop three blocks in a
     row from reading as a battery. */
  pink: `
    <rect x="19.5" y="10" width="9" height="18"/>
    <rect x="15.5" y="17.5" width="4" height="3"/>
    <rect x="28.5" y="17.5" width="4" height="3"/>
    <rect x="1.5" y="11.5" width="14" height="15"/>
    <rect x="32.5" y="11.5" width="14" height="15"/>
    <rect x="22.75" y="28" width="2.5" height="6.5"/>
    <rect x="19" y="34.5" width="10" height="3.5"/>
    <g fill="var(--ca-knock)">
      <rect x="6" y="11.5" width="2" height="15"/>
      <rect x="11" y="11.5" width="2" height="15"/>
      <rect x="37" y="11.5" width="2" height="15"/>
      <rect x="42" y="11.5" width="2" height="15"/>
      <rect x="1.5" y="18" width="14" height="2"/>
      <rect x="32.5" y="18" width="14" height="2"/>
      <rect x="21.5" y="13" width="5" height="2"/>
      <rect x="21.5" y="23" width="5" height="2"/>
    </g>`,

  /* Test & Eval — calibration reticle: heavy ring, four spikes, centre pip.
     KEPT unchanged. It is the only mark in the ten that was already a real
     instrument rather than a symbol, it reads at every tier on the proof
     sheet, and it carries no rounded corners to fix. */
  orange: `
    <path d="M24 5 A19 19 0 1 0 24 43 A19 19 0 1 0 24 5 Z
             M24 11 A13 13 0 1 1 24 37 A13 13 0 1 1 24 11 Z"/>
    <rect x="21.4" y="1" width="5.2" height="13"/>
    <rect x="21.4" y="34" width="5.2" height="13"/>
    <rect x="1" y="21.4" width="13" height="5.2"/>
    <rect x="34" y="21.4" width="13" height="5.2"/>
    <circle cx="24" cy="24" r="3.6"/>`,

  /* Fighters — a swept-delta fighter PLANFORM, nose up: chined forebody, cropped
     delta with a ~50° leading edge, trapezoidal stabilators, twin nozzles. The
     canopy is knocked out because in a top view it is the single feature that
     separates an aircraft from an arrow, and the canted fins are knocked as
     slivers because in a true top view that is all they are. Traced against the
     generic modern-fighter planform common to FM 44-80's recognition plates and
     the Navy SAC 3-views; matching both is evidence of copying the aircraft
     rather than either drawing. No specific type is named on the mark — the
     designations live on the card faces (AM General v. Activision). */
  red: `
    <path d="M24 2.5 L26.2 9 L27.2 15 L27.8 20 L28.6 24.5 L43 33.5 L43 36
             L29.4 37.4 L29.4 38.6 L36.5 41.2 L36.5 43.2 L28.6 45 L26.6 46.5
             L21.4 46.5 L19.4 45 L11.5 43.2 L11.5 41.2 L18.6 38.6 L18.6 37.4
             L5 36 L5 33.5 L19.4 24.5 L20.2 20 L20.8 15 L21.8 9 Z"/>
    <g fill="var(--ca-knock)">
      <path d="M24 11 L26.3 14.5 L26 19.5 L24 22 L22 19.5 L21.7 14.5 Z"/>
      <path d="M27 32.5 L31.8 43.4 L29 43.4 L25.2 33.8 Z"/>
      <path d="M21 32.5 L16.2 43.4 L19 43.4 L22.8 33.8 Z"/>
    </g>`,

  /* Mobility — heavy airlifter planform: high straight wing with mild sweep,
     four pylon-mounted nacelles, a T-tail stabiliser bar. Redrawn from the
     previous version only to obey the drawing law — every rx is gone, the
     fuselage is a drawn planform instead of a rounded rect, and it carries the
     same knocked flight-deck lozenge as the fighter so the two aircraft read as
     one draughtsman's hand. Same PD corpus. */
  yellow: `
    <path d="M2 21 L24 14 L46 21 L46 26 L24 24.5 L2 26 Z"/>
    <path d="M24 3.5 L26.8 8.5 L28.2 14 L28.2 33 L27.2 38 L25.6 42.5 L24 44.5
             L22.4 42.5 L20.8 38 L19.8 33 L19.8 14 L21.2 8.5 Z"/>
    ${[[29.2, 11.6], [36.2, 13.8], [15.4, 11.6], [8.4, 13.8]]
      .map(([x, y]) => `<path d="M${x + 0.5} ${y} H${x + 2.9} L${x + 3.4} ${y + 1.5}
        V${y + 7.4} H${x} V${y + 1.5} Z"/>`).join('')}
    <path d="M12.5 37.4 H35.5 L34 41.6 H14 Z"/>
    <path d="M24 5.5 L26.2 9.5 L25.8 13.5 L24 15 L22.2 13.5 L21.8 9.5 Z"
      fill="var(--ca-knock)"/>`,

  /* Elite Programs — the FOUR-SHIP DIAMOND, drawn at last. The previous two
     attempts died because four ships can never each get enough pixels on a
     14×14 raster; with that gate retired the arrangement is free to be what the
     set actually is, and it replaces a four-point sparkle that was the most
     generic mark in the build. Geometry only: a diamond formation is geometry
     and is not claimed, but the DAF's "Thunderbirds" trade dress includes the
     red/white/blue livery, so the mark is monochrome in the set colour and the
     name stays on the card face where AM General protects it. */
  green: `
    <path d="${shipPath(24, 10, 1.08)}"/>
    <path d="${shipPath(11.6, 24, 1.08)}"/>
    <path d="${shipPath(36.4, 24, 1.08)}"/>
    <path d="${shipPath(24, 38, 1.08)}"/>`,

  /* Command — THE PENTAGON IN PLAN: concentric pentagonal rings around the
     courtyard, which is literally what the building is and what a top-down
     orthographic of it looks like. It replaces a pentagon with a five-point
     star punched through it — a star inside a service outline is the shape
     §507.9 exists to keep amateurs away from, and it was doing no work the
     pentagon was not already doing. Four nested subpaths in ONE path so the
     svg's fill-rule="evenodd" alternates solid/void without a knock colour;
     the voids therefore show the true card through at every tier. */
  darkblue: `
    <path d="${ngonPath(24, 26, 21, 5)} ${ngonPath(24, 26, 15.5, 5)}
             ${ngonPath(24, 26, 11, 5)} ${ngonPath(24, 26, 6, 5)}"/>`,

  /* Overseas Bases — a RUNWAY in plan: threshold "piano key" bars at the far
     end, a dashed centreline running out of frame at the near end, laid at 22°
     so it reads as pavement on a field rather than as a ruler. The threshold
     marking is the most recognisable painted geometry on any airfield on earth
     and it is pure square-corner drawing. The previous crossed bars read as an
     X and said nothing about aviation. */
  base: `
    <g transform="rotate(-22 24 24)">
      <rect x="14" y="4" width="20" height="40"/>
      <g fill="var(--ca-knock)">
        <rect x="15.8" y="7" width="2.6" height="8"/>
        <rect x="20.4" y="7" width="2.6" height="8"/>
        <rect x="25" y="7" width="2.6" height="8"/>
        <rect x="29.6" y="7" width="2.6" height="8"/>
        <rect x="22.9" y="19" width="2.2" height="6.5"/>
        <rect x="22.9" y="28.5" width="2.2" height="6.5"/>
        <rect x="22.9" y="38" width="2.2" height="6"/>
      </g>
    </g>`,

  /* Intelligence — the ART §6 spec taken literally at last: a PARABOLIC DISH on
     a mast, feed horn on its strut at the focus, panel rules across the
     reflector, plinth at the base. The previous disc-with-a-wedge was a radar
     PPI scope in theory and a pie chart with a clock hand in practice. A dish
     in profile is the only curved-and-open mass in the ten. */
  intel: `
    <path d="${bandArc(24, 19, 15, 10.6, 60, 230)}"/>
    <path d="${bar(16.5, 9.5, 29.6, 15.6, 2.4)}"/>
    <rect x="26.6" y="12.6" width="6" height="6"/>
    <rect x="22.2" y="28" width="3.6" height="13"/>
    <rect x="12.5" y="41" width="23" height="4"/>
    <g fill="var(--ca-knock)">
      <path d="${radialBar(24, 19, 10.2, 15.4, 100, 1.8)}"/>
      <path d="${radialBar(24, 19, 10.2, 15.4, 160, 1.8)}"/>
      <rect x="16" y="42.2" width="16" height="1.8"/>
    </g>`,
};

/* ── ACTION GLYPHS ────────────────────────────────────────────────────────
   Achromatic by law (§1: "actions concern no colour, and that absence is
   itself the signal"). Solid-first for the same silhouette reason.

   NOT REDRAWN in the 2026-08-07 round, and that is a judgement rather than a
   deadline: rendered at 150px against the ten new set marks, nine of these
   eleven answer at the table tier and none of them is generic in the way the
   green sparkle was — a shield with a bar, a banknote, a magnifier, a house
   are the correct universal marks for what these cards do and drawing them
   more cleverly would cost legibility. Two exceptions are recorded honestly:
   `midnight_requisition` (the walking crate reads as a robot before it reads
   as theft) and `tdy_orders` (two arc bands are the universal refresh icon,
   correct but anonymous). Both are named in the round's report as still below
   the bar. What DID change here: every `rx` is gone. The set glyphs' drawing
   law says square corners always, and eight rounded rectangles in the action
   family would have made that comment a lie. */

const ACTION_GLYPHS = {
  /* PCS Orders — TWO order sheets, fanned. The effect is "draw 2", so the
     glyph is two of the thing. The old single-sheet-plus-move-arrow collapsed
     into clutter at 14px, and its transfer arrow was one more arrow in a
     family that needs its arrows scarce (the RENT medallion owns opposed
     arrows). A knock outline separates the front sheet from the back one. */
  pcs_orders: `
    <path d="M18 4 h13.5 l7.5 7.5 v15.5 h-21 z"/>
    <path d="M6 10.5 h19 l9 9 v24 h-28 z" fill="var(--ca-knock)"/>
    <path d="M9 13.5 h13.5 l8.5 8.5 v18.5 h-22 z"/>
    <path d="M22.5 13.5 l8.5 8.5 h-8.5 z" fill="var(--ca-knock)"/>
    <g fill="var(--ca-knock)">
      <rect x="13.5" y="26" width="13" height="3.6"/>
      <rect x="13.5" y="33" width="8.5" height="3.6"/>
    </g>`,

  /* OPSEC — a shield with one heavy DENIED bar knocked through it. The old
     bar-plus-stub knockout merged into an ambiguous "T" at 14px; a single fat
     horizontal slot is the universal "blocked" and survives thresholding. */
  opsec: `
    <path d="M24 3.5 L41 9.5 V22.5 C41 34.5 24 44.5 24 44.5 S7 34.5 7 22.5 V9.5 Z"/>
    <rect x="13.5" y="18" width="21" height="7" fill="var(--ca-knock)"/>`,

  /* Midnight Requisition — the supply crate WALKING OFF on its own two legs,
     motion dashes trailing. The previous crescent-over-footlocker was two
     disconnected blobs at 14px (a "C" over a tiny window) and said nothing
     about theft; "the crate grew legs overnight" is the actual joke the phrase
     means, it is one connected silhouette, and nothing else in the family is a
     box on legs. The crescent survives as a stencil knocked out of the crate
     face — at hand size it says midnight, at 14px it closes gracefully. */
  midnight_requisition: `
    <path d="M8 11 h32 v21 h-32 z"/>
    <path d="M15 32 L21.5 32 L18.5 41.5 L12 41.5 Z"/>
    <path d="M8 40.5 h10.5 v5 h-10.5 z"/>
    <path d="M26.5 32 L33 32 L36 41.5 L29.5 41.5 Z"/>
    <path d="M29.5 40.5 h10.5 v5 h-10.5 z"/>
    <path d="M1.5 14.5 h4.5 v4.5 h-4.5 z M1.5 23 h4.5 v4.5 h-4.5 z"/>
    <circle cx="30" cy="20.5" r="5" fill="var(--ca-knock)"/>
    <circle cx="32.5" cy="18.5" r="5"/>`,

  /* TDY Orders — the two-way trade as two heavy arc bands with solid heads,
     built geometrically (bandArc/arcHead) instead of the old hand-sketched
     curls, whose thin tails and merged heads thresholded into a broken "S" at
     14px. Deliberately circular so it cannot be confused with the RENT
     medallion's straight opposed arrows. */
  tdy_orders: `
    <path d="${bandArc(24, 24, 20, 13, 195, 318)}"/>
    <path d="${arcHead(24, 24, 16.5, 322, 11.5, 8)}"/>
    <path d="${bandArc(24, 24, 20, 13, 15, 138)}"/>
    <path d="${arcHead(24, 24, 16.5, 142, 11.5, 8)}"/>`,

  /* Finance Office — a banknote: solid note, knocked side slots, centre disc
     with the M drawn as a PATH. The old one had two invisible edges (zero-width
     `M9 17 v14` subpaths contribute nothing to a fill) and set its M in <text>,
     which made the mark font-dependent — it read as a camera badge at 1-bit. */
  finance_office: `
    <path d="M3.5 12 h41 v24 h-41 z"/>
    <g fill="var(--ca-knock)">
      <rect x="9.5" y="16.5" width="4.5" height="15"/>
      <rect x="34" y="16.5" width="4.5" height="15"/>
      <circle cx="24" cy="24" r="8.8"/>
    </g>
    <path d="M18.9 28.9 v-9.8 h3.2 l1.9 3.3 1.9 -3.3 h3.2 v9.8 h-3 v-4.4 l-2.1 3.2 -2.1 -3.2 v4.4 z"/>`,

  /* Roll Call — a RANK: three identical figures at identical height over the
     line. The old staggered trio (centre head raised, shoulders interleaved)
     thresholded into a mushy middle; a formation stands at attention, so equal
     heights are also the honest drawing. Shoulders overlap into one scalloped
     mass on purpose — three heads over one rank reads at any size. */
  roll_call: `
    <circle cx="11" cy="13.5" r="4.8"/><circle cx="24" cy="13.5" r="4.8"/><circle cx="37" cy="13.5" r="4.8"/>
    <path d="M3.5 31.5 a7.5 8.5 0 0 1 15 0 z"/>
    <path d="M16.5 31.5 a7.5 8.5 0 0 1 15 0 z"/>
    <path d="M29.5 31.5 a7.5 8.5 0 0 1 15 0 z"/>
    <rect x="4" y="36.5" width="40" height="4.5"/>`,

  /* Upgrade (House) — a house with a plus */
  upgrade: `
    <path d="M24 6 L42 23 H36 V41 H12 V23 H6 Z"/>
    <path d="M21.4 25 h5.2 v5.2 h5.2 v5.2 h-5.2 v5.2 h-5.2 v-5.2 h-5.2 v-5.2 h5.2 z"
      fill="var(--ca-knock)"/>`,

  /* FOC (Hotel) — the same house with a star: the upgrade ABOVE the upgrade */
  foc: `
    <path d="M24 6 L42 23 H36 V41 H12 V23 H6 Z"/>
    <path d="${starPath(24, 31, 9, 3.7)}" fill="var(--ca-knock)"/>`,

  /* Inspector General — a magnifier whose lens is a SOLID disc with the IG
     star knocked out of it, plus a heavier handle. The old open ring put a
     solid star inside it and the two merged into a crusted "Q" at 14px; a
     solid lens keeps the magnifier mass and the star survives as a white
     stencil at every size. */
  inspector_general: `
    <circle cx="20" cy="20" r="16"/>
    <path d="${starPath(20, 20, 9.5, 3.8)}" fill="var(--ca-knock)"/>
    <rect x="28.5" y="29" width="16.5" height="7" transform="rotate(45 32 32)"/>`,

  /* Surge Ops — a bolt (the ×2 rides as a caption, not as glyph text) */
  surge_ops: `
    <path d="M26 2 L9 25 h9.5 L14 46 L39 21 h-10.5 L34 2 Z"/>`,

  /* THE CHUD — a commanding sunburst star */
  chud: `
    <g class="ca-chud-rays">
      <path d="M21.6 0 h4.8 v7 h-4.8 z M21.6 41 h4.8 v7 h-4.8 z
               M0 21.6 h7 v4.8 h-7 z M41 21.6 h7 v4.8 h-7 z"/>
      <g transform="rotate(45 24 24)">
        <path d="M21.6 1.5 h4.8 v6 h-4.8 z M21.6 40.5 h4.8 v6 h-4.8 z
                 M1.5 21.6 h6 v4.8 h-6 z M40.5 21.6 h6 v4.8 h-6 z"/>
      </g>
    </g>
    <path d="M24 6.5 A17.5 17.5 0 1 0 24 41.5 A17.5 17.5 0 1 0 24 6.5 Z
             M24 11.5 A12.5 12.5 0 1 1 24 36.5 A12.5 12.5 0 1 1 24 11.5 Z"/>
    <path d="${starPath(24, 24, 11.5, 4.6)}"/>`,
};

/* Money — a solid rosette ring the numeral sits inside, with a guilloche-style
   broken inner ring. The inner ring carried `stroke-dasharray="3 2.6"` on a
   path that had a fill and no stroke, so the attribute did nothing and the
   "dashed" ring printed solid; it is now an actual stroked, dashed circle. Only
   the hand and peek tiers ever see it — ≤60px drops the rosette entirely so the
   numeral can own the note. */
const MONEY_GLYPH = `
  <path d="M24 3 A21 21 0 1 0 24 45 A21 21 0 1 0 24 3 Z
           M24 6.4 A17.6 17.6 0 1 1 24 41.6 A17.6 17.6 0 1 1 24 6.4 Z"/>
  <circle cx="24" cy="24" r="14.4" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-dasharray="3 2.6"/>`;

/* The RENT medallion mark: opposed transfer arrows, achromatic. */
const RENT_MARK = `
  <path d="M6 16 h26 v-5 l11 8.5 -11 8.5 v-5 h-26 z"/>
  <path d="M42 32 h-26 v-5 l-11 8.5 11 8.5 v-5 h26 z"/>`;

/* ── SVG assembly ─────────────────────────────────────────────────────────
   Every glyph <svg> fills with currentColor by default; knockouts opt into
   --ca-knock, which the stylesheet points at whatever the glyph is sitting on
   (cream stock normally, the set colour in the flood tier). */

function svg(body, cls = 'ca-glyph') {
  return `<svg class="${cls}" viewBox="0 0 48 48" fill="currentColor"
    fill-rule="evenodd" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** The ten-colour wheel, hard-edged. Used by the any-rent and the any-wild.
 *  Explicitly NOT a conic-gradient: browsers antialias conic stops into a soft
 *  smear at small sizes, and §6.3 says a gradient reads as decoration. */
function wheelSVG(cls) {
  const seg = COLOR_KEYS.map((k, i) =>
    `<path d="${wedge(24, 24, 23.5, i, COLOR_KEYS.length)}" fill="var(--set-${k}, ${FALLBACK[k]})"/>`
  ).join('');
  return `<svg class="${cls}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <g>${seg}</g></svg>`;
}

/** ART-DIRECTION §2 set colours — the fallback if the theme has not defined
 *  --set-* yet. The theme token always wins; these are never the primary. */
const FALLBACK = {
  brown: '#8A4B1E', lightblue: '#136C90', pink: '#B01C63', orange: '#A85200',
  red: '#B81A33', yellow: '#8A6A00', green: '#1B6E37', darkblue: '#26308F',
  base: '#0C5F5B', intel: '#465767',
};

function setVar(key) { return `var(--set-${key}, ${FALLBACK[key]})`; }

function setGlyph(key) { return svg(SET_GLYPHS[key] || SET_GLYPHS.base); }

/* ── Shared fragments ─────────────────────────────────────────────────── */

const TICKS = '<i class="ca-tick tl"></i><i class="ca-tick tr"></i>'
  + '<i class="ca-tick bl"></i><i class="ca-tick br"></i>';

function pips(n) { return `<span class="ca-pips">${'<i></i>'.repeat(n)}</span>`; }

function coin(v) { return `<span class="ca-val">${v}M</span>`; }

function serial(card) {
  const n = typeof card.id === 'number' ? String(card.id + 1).padStart(3, '0') : '000';
  return `<span class="ca-serial">TO-${n} · USAF ED.</span>`;
}

function foot(card, tier) {
  return `<div class="ca-foot">${tier === 'peek' ? serial(card) : ''}${coin(card.value ?? 0)}</div>`;
}

function rule(card, opts) {
  const text = opts.rule !== undefined ? opts.rule : cardText(card);
  if (!text) return '';
  return `<div class="ca-rulebox"><p class="ca-rule">${esc(text)}</p></div>`;
}

function ladderStrip(color) {
  const info = COLORS[color];
  if (!info) return '';
  return `<div class="ca-rents">${info.rent.map((r, i) =>
    `<span class="ca-rentstep"><b>${i + 1}</b>${r}M</span>`).join('')}</div>`;
}

function ladderRows(color) {
  const info = COLORS[color];
  if (!info) return '';
  return `<div class="ca-rrows">${info.rent.map((r, i) =>
    `<div class="ca-rrow"><span>${i + 1} OF ${info.size}</span><i></i><span>${r}M</span></div>`
  ).join('')}</div>`;
}

/* ── Property ─────────────────────────────────────────────────────────── */

function propFace(card, tier, opts) {
  const key = COLORS[card.color] ? card.color : 'base';
  const info = COLORS[key];
  const cls = `ca ca-${tier} ca-prop ca-set-${key}`;
  const name = tier === 'peek' ? card.name : (PROP_SHORT[card.name] || card.name);
  const band = `<div class="ca-band"><span class="ca-band-name">${esc(
    tier === 'peek' ? info.name : SET_CODE[key])}</span>${pips(info.size)}</div>`;
  const code = `<span class="ca-code" aria-hidden="true">${SET_CODE[key]}</span>`;

  if (tier === 'peek') {
    return `<div class="${cls}">${TICKS}${band}
      <div class="ca-title">${esc(name)}</div>
      <div class="ca-art">${setGlyph(key)}</div>
      ${ladderRows(key)}${rule(card, opts)}${foot(card, tier)}</div>`;
  }
  // Both marks ship in the one markup, because table/cardnode.js builds a face
  // ONCE and only reparents it (§0.4) — the ≤34px tier cannot ask for a rebuild.
  // The stylesheet shows the drawing above 34px and the mark below it.
  const mark = `<span class="ca-mark" aria-hidden="true">${SET_MARK[key]}</span>`;
  return `<div class="${cls}">${TICKS}${band}
    <div class="ca-title">${esc(name)}</div>
    <div class="ca-art">${setGlyph(key)}${mark}${code}</div>
    ${ladderStrip(key)}${foot(card, tier)}</div>`;
}

/* ── Rent — the face IS the colours (§6.3) ────────────────────────────── */

function rentFace(card, tier, opts) {
  const colors = Array.isArray(card.colors) ? card.colors : ['any'];
  const any = colors[0] === 'any';
  const cls = `ca ca-${tier} ca-rent ${any ? 'ca-rent-any' : 'ca-rent-pair'}`;

  // The colour field, full-bleed to the trim. This is the whole fix: there is
  // no cream chassis under a rent, so it can never be read as a wild property.
  const field = any
    ? `<div class="ca-field ca-field-wheel">${wheelSVG('ca-wheel')}</div>`
    // --ca-fill drives BOTH the half's background and the glyph's knockout
    // colour, so a punched shape (Command's star, Intel's sweep) shows the set
    // colour through it instead of a hole of stock that is not behind it.
    : `<div class="ca-field ca-field-split">
         <div class="ca-half" style="--ca-fill:${setVar(colors[0])}">${setGlyph(colors[0])}</div>
         <div class="ca-half" style="--ca-fill:${setVar(colors[1])}">${setGlyph(colors[1])}</div>
       </div>`;

  // Achromatic, and small: the type is the SECOND thing the card says.
  const medal = `<span class="ca-medal">${svg(RENT_MARK, 'ca-medal-mark')}<b>RENT</b></span>`;

  if (tier === 'peek') {
    const rows = any
      ? `<div class="ca-crow"><i class="ca-dot">${wheelSVG('ca-dot-wheel')}</i><span>ANY ONE SET YOU OWN</span></div>`
      : colors.map(k =>
          `<div class="ca-crow"><i class="ca-dot" style="--ca-fill:${setVar(k)}"></i>`
          + `<span>${esc(COLORS[k].name)}</span></div>`).join('');
    return `<div class="ca ca-peek ca-rent-peek ${any ? 'ca-rent-any' : 'ca-rent-pair'}">${TICKS}
      <div class="ca-band ca-band-ink"><span class="ca-band-name">RENT DEMAND</span></div>
      <div class="ca-title">${esc(cardName(card))}</div>
      <div class="ca-art ca-art-field">${field}${medal}</div>
      <div class="ca-crows">${rows}</div>
      ${rule(card, opts)}${foot(card, tier)}</div>`;
  }
  return `<div class="${cls}">${field}${medal}
    <span class="ca-val ca-val-float">${card.value ?? 0}M</span></div>`;
}

/* ── Wild property — the SAME colours on a cream PROPERTY chassis ──────── */

function wildFace(card, tier, opts) {
  const colors = Array.isArray(card.colors) ? card.colors : ['any'];
  const any = colors[0] === 'any';
  const cls = `ca ca-${tier} ca-prop ca-wild ${any ? 'ca-wild-any' : 'ca-wild-pair'}`;

  // Contained, not bled: a disc/band of colour sitting ON cream stock.
  const art = any
    ? `<div class="ca-art">${wheelSVG('ca-wheel ca-wheel-art')}</div>`
    : `<div class="ca-art ca-art-pair">
         <span class="ca-pairhalf" style="color:${setVar(colors[0])}">${setGlyph(colors[0])}</span>
         <span class="ca-pairhalf" style="color:${setVar(colors[1])}">${setGlyph(colors[1])}</span>
       </div>`;

  const band = any
    ? `<div class="ca-band ca-band-wheel"><span class="ca-band-name">WILD · ANY</span></div>`
    : `<div class="ca-band ca-band-split" style="background:linear-gradient(90deg,`
      + `${setVar(colors[0])} 0 50%,${setVar(colors[1])} 50% 100%)">`
      + `<span class="ca-band-name">WILD</span></div>`;

  const title = any ? 'WILD PROPERTY'
    : colors.map(k => SET_CODE[k]).join(' / ');

  if (tier === 'peek') {
    const rows = any
      ? `<div class="ca-crow"><i class="ca-dot">${wheelSVG('ca-dot-wheel')}</i><span>ANY SET</span></div>`
      : colors.map(k =>
          `<div class="ca-crow"><i class="ca-dot" style="--ca-fill:${setVar(k)}"></i>`
          + `<span>${esc(COLORS[k].name)}</span></div>`).join('');
    return `<div class="${cls}">${TICKS}${band}
      <div class="ca-title">WILD PROPERTY</div>
      ${art}<div class="ca-crows">${rows}</div>
      ${rule(card, opts)}${foot(card, tier)}</div>`;
  }
  return `<div class="${cls}">${TICKS}${band}
    <div class="ca-title">${esc(title)}</div>
    ${art}${foot(card, tier)}</div>`;
}

/* ── Money ────────────────────────────────────────────────────────────── */

function moneyFace(card, tier, opts) {
  const v = card.value ?? 0;
  const cls = `ca ca-${tier} ca-money`;
  const num = `<div class="ca-mnum"><b>${v}</b><i>M</i></div>`;
  if (tier === 'peek') {
    return `<div class="${cls}">${TICKS}
      <div class="ca-band ca-band-ink"><span class="ca-band-name">APPROPRIATED FUNDS</span></div>
      <div class="ca-title">${MONEY_WORDS[v] || v} MILLION</div>
      <div class="ca-art">${svg(MONEY_GLYPH)}${num}</div>
      ${rule(card, opts)}
      <div class="ca-foot">${serial(card)}</div></div>`;
  }
  return `<div class="${cls}">${TICKS}
    <div class="ca-band ca-band-ink"><span class="ca-band-name">FUNDS</span></div>
    <div class="ca-art">${svg(MONEY_GLYPH)}${num}</div>
    <div class="ca-title">${MONEY_WORDS[v] || v} MILLION</div></div>`;
}

/* ── Action — achromatic by law (§1) ──────────────────────────────────── */

function actionFace(card, tier, opts) {
  const key = ACTION_GLYPHS[card.action] ? card.action : 'pcs_orders';
  const meta = ACTIONS[key] || { name: card.name, code: 'ACT' };
  const chud = key === 'chud';
  const opsec = key === 'opsec';
  const cls = `ca ca-${tier} ca-action${chud ? ' ca-chud' : ''}${opsec ? ' ca-opsec' : ''}`;
  // "EXECUTIVE DIRECTIVE" needed 91px in an 85px band on five-player@desktop and
  // was clipped in five shots. The long form is a peek-tier luxury.
  const bandText = chud ? (tier === 'peek' ? 'EXECUTIVE DIRECTIVE' : 'DIRECTIVE')
    : opsec ? (tier === 'peek' ? 'ORDER · COUNTER' : 'COUNTER') : 'ORDER';
  const sub = ACTION_SUB[key] && tier === 'peek'
    ? `<div class="ca-sub">${ACTION_SUB[key]}</div>` : '';

  if (tier === 'peek') {
    return `<div class="${cls}">${TICKS}
      <div class="ca-band ca-band-ink"><span class="ca-band-name">${bandText}</span></div>
      <div class="ca-title">${esc(card.name || meta.name)}</div>${sub}
      <div class="ca-art">${svg(ACTION_GLYPHS[key])}</div>
      ${rule(card, opts)}${foot(card, tier)}</div>`;
  }
  return `<div class="${cls}">${TICKS}
    <div class="ca-band ca-band-ink"><span class="ca-band-name">${bandText}</span></div>
    <div class="ca-title">${esc(meta.name)}</div>
    <div class="ca-art">${svg(ACTION_GLYPHS[key])}<span class="ca-code" aria-hidden="true">${meta.code}</span></div>
    ${foot(card, tier)}</div>`;
}

/* ── The back — the ONE dark object in the whole design (§2) ───────────── */

/** The deck mark: a stencil-cut ALIGNMENT TARGET.
 *
 *  What it replaces, and why it had to go: the back carried a five-point star
 *  inside a circle with a bar struck through it — the US national aircraft
 *  insignia. 32 C.F.R. §507.9 runs the opposite way to intuition. PHOTOGRAPHING
 *  a service medal, badge, patch, seal or device is authorised; "making or
 *  executing in any manner any engraving, impression, or COLORABLE IMITATION"
 *  is prohibited without written approval. Hand-authored SVG is the prohibited
 *  act, not the permitted one, and this was the most-seen surface in the game.
 *
 *  What it is instead: a pre-press registration target rendered in the drawing
 *  law of the rest of the system — four heavy bars (5 units) crossing a thin
 *  frame (2.5 units, the 2:1 pair), a square-annulus centre, four corner datum
 *  pips, and a stencil bridge broken out of each bar. Every corner is square,
 *  nothing is stroked, and it imitates no insignia of any service because a
 *  registration target is a printer's mark. It is also a better fit for a deck
 *  whose whole identity is a flight-line technical order than a roundel was.
 *
 *  The 45° halftone screen behind it lives in style/cardart.css as a background
 *  with an absolute px pitch rather than as an <svg><pattern>: a pattern needs
 *  an `id`, every card back in the DOM would declare the same one, and the
 *  first declaration disappearing with a pooled node would break the rest. */
const BACK_MARK = `
  <path d="M4 4 H30 V10 H10 V30 H4 Z M96 4 V30 H90 V10 H70 V4 Z
           M4 96 V70 H10 V90 H30 V96 Z M96 96 H70 V90 H90 V70 H96 Z"/>
  <path d="M24 24 H76 V76 H24 Z M27 27 H73 V73 H27 Z"/>
  <path d="M47 12 H53 V37 H47 Z M47 63 H53 V88 H47 Z
           M12 47 H37 V53 H12 Z M63 47 H88 V53 H63 Z"/>
  <path d="M50 40.5 L59.5 50 L50 59.5 L40.5 50 Z"/>
  <g fill="var(--ca-knock)">
    <rect x="47" y="19" width="6" height="3"/>
    <rect x="47" y="78" width="6" height="3"/>
    <rect x="19" y="47" width="3" height="6"/>
    <rect x="78" y="47" width="3" height="6"/>
  </g>`;

function backMarkup(tier) {
  const mark = `<svg class="ca-back-art" viewBox="0 0 100 100"
    fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"
    >${BACK_MARK}</svg>`;
  if (tier === 'peek') {
    return `<div class="ca ca-peek ca-back">${TICKS}
      <div class="ca-back-word">CHUDOPOLY</div>${mark}
      <div class="ca-back-sub">PROPERTY COMMAND DECK</div></div>`;
  }
  return `<div class="ca ca-hand ca-back">${TICKS}
    <div class="ca-back-word">CHUDOPOLY</div>${mark}</div>`;
}

/* ── Materialise ──────────────────────────────────────────────────────── */

/** Parse a markup string into ONE element.
 *  Not innerHTML: nothing is written into the live tree, so a face can be built
 *  while a FLIP is running on the node that will adopt it (§0.4, checkClient). */
function parse(markup) {
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  return doc.body.firstElementChild;
}

function markupFor(card, tier, opts) {
  switch (card.type) {
    case 'property':      return propFace(card, tier, opts);
    case 'wild_property': return wildFace(card, tier, opts);
    case 'rent':          return rentFace(card, tier, opts);
    case 'money':         return moneyFace(card, tier, opts);
    case 'action':        return actionFace(card, tier, opts);
    default:              return moneyFace(card, tier, opts);
  }
}

/**
 * The printed face of `card`, as a detached element.
 * @param {object} card
 * @param {'hand'|'peek'} [tier]  'hand' is the ONE in-game face; the stylesheet
 *        degrades it to the board and mini sizes with container queries, so a
 *        reparented node never needs its face rebuilt (§0.4).
 * @param {{rule?: string}} [opts]  rule copy override (ui/peek.js passes the
 *        canonical cardText so the face and the sheet cannot disagree).
 * @returns {Element|null}
 */
export function faceNode(card, tier = 'hand', opts = {}) {
  if (!card) return null;
  const t = tier === 'peek' ? 'peek' : 'hand';
  return parse(markupFor(card, t, opts || {}));
}

/** The card back. @returns {Element|null} */
export function backNode(tier = 'hand') {
  return parse(backMarkup(tier === 'peek' ? 'peek' : 'hand'));
}

/** A bare set glyph, for legends and the set-column headers. */
export function glyphNode(color) {
  return parse(svg(SET_GLYPHS[color] || SET_GLYPHS.base));
}

export { SET_CODE, SET_MARK, ACTIONS, SET_GLYPHS, ACTION_GLYPHS, BACK_MARK };
