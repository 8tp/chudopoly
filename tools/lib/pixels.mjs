/**
 * tools/lib/pixels.mjs — the Node half of the colour measurements.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Two gates read pixels off a captured frame:
 *   • grayscale.mjs   — ART-DIRECTION §10's "grayscale mid-game@desktop: is
 *                       hierarchy still readable?" ship gate,
 *   • checkContrast.mjs — the real painted background under a text run, for the
 *                       samples whose CSS background stack is a gradient/image
 *                       and therefore unmeasurable from getComputedStyle alone.
 *
 * Everything works in **CIE L\*** (0–100 perceptual lightness), not in linear
 * relative luminance, wherever a threshold is stated about what an eye can
 * separate. Linear luminance is savagely compressed at the dark end — the
 * current dark build's whole apron lives between Y 0.019 and Y 0.035, a span of
 * 1.6% that looks tiny and is a visible 7 L* — so a threshold expressed in Y
 * either passes everything dark or fails everything dark. Contrast RATIOS stay
 * in Y, because that is what WCAG 2.x defines.
 */

const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };

/** WCAG 2.x relative luminance of an [r,g,b] triple in 0..255. */
export function relLum(rgb) {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** CIE L* from relative luminance. 0 = black, 100 = white. */
export function lstar(Y) {
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}

export function contrastRatio(a, b) {
  const [hi, lo] = relLum(a) >= relLum(b) ? [relLum(a), relLum(b)] : [relLum(b), relLum(a)];
  return (hi + 0.05) / (lo + 0.05);
}

/** Per-pixel L* of a decoded PNG, as a Float32Array. Computed once per frame. */
export function lightnessField(png) {
  const out = new Float32Array(png.width * png.height);
  const d = png.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    out[p] = lstar(0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
  }
  return out;
}

/** Percentiles of an L* field, plus the decile occupancy used by the gate. */
export function lightnessStats(field) {
  const sorted = Float32Array.from(field).sort();
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  const bins = new Array(10).fill(0);
  for (let i = 0; i < field.length; i++) bins[Math.min(9, Math.floor(field[i] / 10))]++;
  return {
    n: field.length,
    p2: q(0.02), p5: q(0.05), p25: q(0.25), p50: q(0.5),
    p75: q(0.75), p95: q(0.95), p98: q(0.98),
    bulk: q(0.95) - q(0.05),          // p5–p95: the range the FRAME actually uses
    bins: bins.map((n) => n / field.length),
  };
}

/** Mean L* inside a CSS-pixel rect [x,y,w,h], scaled by the frame's DPR. */
export function regionLightness(field, png, rect, scale = 1) {
  const x0 = Math.max(0, Math.round(rect[0] * scale));
  const y0 = Math.max(0, Math.round(rect[1] * scale));
  const x1 = Math.min(png.width, Math.round((rect[0] + rect[2]) * scale));
  const y1 = Math.min(png.height, Math.round((rect[1] + rect[3]) * scale));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) { sum += field[y * png.width + x]; n++; }
  }
  return n ? sum / n : null;
}

/**
 * The painted background colour inside a text element's rect.
 *
 * Glyph pixels are a MINORITY of a text box (typical coverage 10–25%), so the
 * modal colour of the box is its background. Pixels close to the known ink are
 * dropped first so that a tight, heavy label cannot vote for its own ink, and
 * the winning 24-bin luminance bucket is averaged rather than picking a single
 * pixel — antialiasing makes any single pixel a coin flip.
 *
 * Returns `{ rgb, share, n }` — `share` is the winning bucket's fraction of the
 * non-ink pixels, i.e. how much of a background there was to find. Callers
 * should ignore a low-share answer and keep the CSS reading: an 8px label whose
 * glyphs are mostly antialiased fringe has no modal background worth trusting.
 * Returns null when the rect is empty or every pixel looked like ink.
 */
export function sampledBackground(png, rect, fg, scale = 1) {
  const x0 = Math.max(0, Math.round(rect[0] * scale));
  const y0 = Math.max(0, Math.round(rect[1] * scale));
  const x1 = Math.min(png.width, Math.round((rect[0] + rect[2]) * scale));
  const y1 = Math.min(png.height, Math.round((rect[1] + rect[3]) * scale));
  if (x1 <= x0 || y1 <= y0) return null;
  const BINS = 24;
  const count = new Array(BINS).fill(0);
  const acc = Array.from({ length: BINS }, () => [0, 0, 0]);
  const d = png.data;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
      // 70 in RGB euclidean space: wide enough to swallow antialiased fringes,
      // narrow enough that a background one tone off the ink still counts (a
      // 1.5:1 pair is a violation we must be able to SEE, not discard).
      const dr = r - fg[0]; const dg = g - fg[1]; const db = b - fg[2];
      if (dr * dr + dg * dg + db * db < 70 * 70) continue;
      const bin = Math.min(BINS - 1, Math.floor(lstar(relLum([r, g, b])) / (100 / BINS)));
      count[bin]++;
      acc[bin][0] += r; acc[bin][1] += g; acc[bin][2] += b;
    }
  }
  let best = -1;
  let total = 0;
  for (let i = 0; i < BINS; i++) {
    total += count[i];
    if (count[i] > (best < 0 ? 0 : count[best])) best = i;
  }
  if (best < 0 || !count[best]) return null;
  return {
    rgb: [
      Math.round(acc[best][0] / count[best]),
      Math.round(acc[best][1] / count[best]),
      Math.round(acc[best][2] / count[best]),
    ],
    share: count[best] / total,
    n: total,
  };
}
