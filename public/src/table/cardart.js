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

/** One hard-edged wedge of the ten-colour wheel, as an SVG path. */
function wedge(cx, cy, R, i, n) {
  const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / n;
  const x0 = (cx + R * Math.cos(a0)).toFixed(2), y0 = (cy + R * Math.sin(a0)).toFixed(2);
  const x1 = (cx + R * Math.cos(a1)).toFixed(2), y1 = (cy + R * Math.sin(a1)).toFixed(2);
  return `M${cx} ${cy} L${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} Z`;
}

/* ── SET GLYPHS ───────────────────────────────────────────────────────────
   SOLID silhouettes on a 48×48 viewBox, drawn in `currentColor` with knockouts
   punched in `--ca-knock`. Solid, not stroked: these are re-used at 14px as
   1-bit silhouettes (the ≤34px flood tier knocks them out of the set colour),
   and 2px strokes on a 48 viewBox vanish at that size.

   Silhouette separation was the design constraint, and it cost two redraws
   against real screenshots:
     • DRONE OPS was an MQ-9 planform — sensor ball, fuselage, straight wing,
       V-tail. At 44px on five-player@phone it read unmistakably as a STICK
       FIGURE: round head, arms out, legs apart. It is now a quadcopter, which
       is both more literally "drone" and structurally unlike anything else
       here (four rotor rings on an X frame).
     • That also leaves only TWO aircraft, so they can afford to be far apart:
       FIGHTER is a narrow swept delta pointing up, MOBILITY is a wide straight
       wing with four pods and a broad T-tail.
   TRAINING is deliberately not a third winged shape — it is a chevron stack. */

const SET_GLYPHS = {
  /* Drone Ops — quadcopter: X frame, four rotor rings, avionics body */
  brown: `
    <path d="M9.5 13 L13 9.5 L38.5 35 L35 38.5 Z"/>
    <path d="M35 9.5 L38.5 13 L13 38.5 L9.5 35 Z"/>
    <rect x="17.5" y="17.5" width="13" height="13" rx="3"/>
    ${[[12, 12], [36, 12], [12, 36], [36, 36]]
      .map(([x, y]) => `<path d="${ringPath(x, y, 8, 4.8)}"/>`).join('')}`,

  /* Training — three chevrons (rank / instruction), NOT a winged shape */
  lightblue: `
    <path d="M24 6 L42 20 L42 27 L24 13 L6 27 L6 20 Z"/>
    <path d="M24 19 L42 33 L42 40 L24 26 L6 40 L6 33 Z"/>`,

  /* Space Force — a solid delta with the orbit passing BEHIND it. This is the
     THIRD construction: an equal-weight ring merged with the delta into one
     blob at 14px, a centred ring swallowed the triangle, and the "fixed" low
     thin ring thresholded into the brim of a WITCH HAT (the 1-bit panel is
     merciless). Now the full tilted annulus is drawn first, an expanded knock
     delta erases its middle, and the true delta sits on top — so at 1-bit the
     orbit survives as two chunky lobes emerging from the delta's flanks with a
     clean gap, which can only be read as a ring passing behind. */
  pink: `
    <path d="M24 18 A23.5 9 0 1 0 24 36 A23.5 9 0 1 0 24 18 Z
             M24 24.5 A14.5 2.5 0 1 1 24 29.5 A14.5 2.5 0 1 1 24 24.5 Z"
      transform="rotate(-10 24 27)"/>
    <path d="M24 0 L44.5 43 L3.5 43 Z" fill="var(--ca-knock)"/>
    <path d="M24 4 L40 39 L8 39 Z"/>`,

  /* Test & Eval — calibration reticle: heavy ring, four spikes, centre pip */
  orange: `
    <path d="M24 5 A19 19 0 1 0 24 43 A19 19 0 1 0 24 5 Z
             M24 11 A13 13 0 1 1 24 37 A13 13 0 1 1 24 11 Z"/>
    <rect x="21.4" y="1" width="5.2" height="13"/>
    <rect x="21.4" y="34" width="5.2" height="13"/>
    <rect x="1" y="21.4" width="13" height="5.2"/>
    <rect x="34" y="21.4" width="13" height="5.2"/>
    <circle cx="24" cy="24" r="3.6"/>`,

  /* Fighters — narrow swept delta, nose up */
  red: `
    <path d="M24 2.5 L28.4 15 L40.5 27.5 L40.5 31 L28.8 30 L30 38 L34.5 43.5
             L13.5 43.5 L18 38 L19.2 30 L7.5 31 L7.5 27.5 L19.6 15 Z"/>`,

  /* Mobility — heavy airlifter: wide straight wing, four pods, broad T-tail */
  yellow: `
    <rect x="21" y="4" width="6" height="33" rx="2.8"/>
    <path d="M21 15.5 L1.5 24 L1.5 29 L21 24 Z"/>
    <path d="M27 15.5 L46.5 24 L46.5 29 L27 24 Z"/>
    <rect x="7.5" y="23" width="4.4" height="6.6" rx="2"/>
    <rect x="14.2" y="21" width="4.4" height="6.6" rx="2"/>
    <rect x="29.4" y="21" width="4.4" height="6.6" rx="2"/>
    <rect x="36.1" y="23" width="4.4" height="6.6" rx="2"/>
    <rect x="13" y="36.5" width="22" height="5.2" rx="2.4"/>`,

  /* Elite Programs — the ART §6 four-point star whose hull is the diamond.
     Two attempts at a literal four-ship Thunderbirds diamond died in the 1-bit
     panel — even 17-unit ships threshold to scattered specks at 14px, because
     four small triangles can never each get enough pixels. One bold sparkle
     keeps the diamond formation's geometry and survives at any size. */
  green: `
    <path d="M24 2 L29.3 18.7 L46 24 L29.3 29.3 L24 46 L18.7 29.3 L2 24 L18.7 18.7 Z"/>`,

  /* Command — solid pentagon with the star punched out */
  darkblue: `
    <path d="${ngonPath(24, 25.5, 20, 5)}" />
    <path d="${starPath(24, 26, 11, 4.5)}" fill="var(--ca-knock)"/>`,

  /* Overseas Bases — crossed runways (an X of two solid bars) */
  base: `
    <g transform="rotate(-34 24 24)"><rect x="1" y="19.4" width="46" height="9.2" rx="1.4"/></g>
    <g transform="rotate(36 24 24)"><rect x="4" y="19.9" width="40" height="8.2" rx="1.4"/></g>
    <g fill="var(--ca-knock)">
      <g transform="rotate(-34 24 24)"><rect x="6" y="23" width="36" height="2" rx="1"/></g>
    </g>`,

  /* Intelligence — radar scope: solid disc with the sweep wedge punched out */
  intel: `
    <path d="M24 4 A20 20 0 1 0 24 44 A20 20 0 1 0 24 4 Z"/>
    <path d="M24 24 L24 5.4 A18.6 18.6 0 0 1 40 14.5 Z" fill="var(--ca-knock)"/>
    <circle cx="24" cy="24" r="3.4" fill="var(--ca-knock)"/>`,
};

/* ── ACTION GLYPHS ────────────────────────────────────────────────────────
   Achromatic by law (§1: "actions concern no colour, and that absence is
   itself the signal"). Solid-first for the same silhouette reason. */

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
      <rect x="13.5" y="26" width="13" height="3.6" rx="1.8"/>
      <rect x="13.5" y="33" width="8.5" height="3.6" rx="1.8"/>
    </g>`,

  /* OPSEC — a shield with one heavy DENIED bar knocked through it. The old
     bar-plus-stub knockout merged into an ambiguous "T" at 14px; a single fat
     horizontal slot is the universal "blocked" and survives thresholding. */
  opsec: `
    <path d="M24 3.5 L41 9.5 V22.5 C41 34.5 24 44.5 24 44.5 S7 34.5 7 22.5 V9.5 Z"/>
    <rect x="13.5" y="18" width="21" height="7" rx="2" fill="var(--ca-knock)"/>`,

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
      <rect x="9.5" y="16.5" width="4.5" height="15" rx="1.6"/>
      <rect x="34" y="16.5" width="4.5" height="15" rx="1.6"/>
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
    <rect x="4" y="36.5" width="40" height="4.5" rx="2.2"/>`,

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
    <rect x="29.5" y="29" width="15.5" height="7" rx="3.5" transform="rotate(45 32 32)"/>`,

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

/* Money — a solid rosette ring the numeral sits inside. */
const MONEY_GLYPH = `
  <path d="M24 3 A21 21 0 1 0 24 45 A21 21 0 1 0 24 3 Z
           M24 6.4 A17.6 17.6 0 1 1 24 41.6 A17.6 17.6 0 1 1 24 6.4 Z"/>
  <path d="M24 8.5 A15.5 15.5 0 1 0 24 39.5 A15.5 15.5 0 1 0 24 8.5 Z
           M24 10.6 A13.4 13.4 0 1 1 24 37.4 A13.4 13.4 0 1 1 24 10.6 Z"
    stroke-dasharray="3 2.6"/>`;

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
  return `<div class="${cls}">${TICKS}${band}
    <div class="ca-title">${esc(name)}</div>
    <div class="ca-art">${setGlyph(key)}${code}</div>
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

function backMarkup(tier) {
  const roundel = `<svg class="ca-back-art" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="1.2"
      stroke-dasharray="1.6 3.6" opacity=".55"/>
    <rect x="1" y="43" width="98" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>
    <circle cx="50" cy="50" r="27" fill="none" stroke="currentColor" stroke-width="2.4"/>
    <path d="${starPath(50, 50, 18, 7.2)}" fill="currentColor"/>
  </svg>`;
  if (tier === 'peek') {
    return `<div class="ca ca-peek ca-back">${TICKS}
      <div class="ca-back-word">CHUDOPOLY</div>${roundel}
      <div class="ca-back-sub">PROPERTY COMMAND DECK</div></div>`;
  }
  return `<div class="ca ca-hand ca-back">${TICKS}
    <div class="ca-back-word">CHUDOPOLY</div>${roundel}</div>`;
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

export { SET_CODE, ACTIONS, SET_GLYPHS, ACTION_GLYPHS };
