#!/usr/bin/env node
/**
 * tools/checkClient.mjs — static gate over the new client (§8, §10).
 *
 * Cheap greps that catch the four invariants which are expensive to catch any
 * other way, because each one produces a bug that looks like something else:
 *
 *   innerHTML in table/ or anim/  → destroys card nodes mid-FLIP; presents as
 *                                   "animation randomly stops" (§0.4, §10)
 *   on*= in index.html            → CSP + XSS regression; presents as nothing
 *                                   at all until someone types a name (§2)
 *   setInterval in anim/          → second clock; presents as jitter under load
 *                                   that no profiler run reproduces (§0.6)
 *   uncached entry <script>       → stale module after deploy; presents as
 *                                   "works on my machine" (§0.2)
 *   Math.random in table/         → nondeterministic layout; presents as the
 *                                   screenshot harness never reproducing (§5)
 *
 * Exits 2 (SKIP) until public/src/ exists — P3 has not written it yet. The
 * index.html scans still RUN in that state and print as advisory, so the
 * architect sees the bar before writing the file rather than after.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';

const SRC = path.join(ROOT, 'public', 'src');
const INDEX = path.join(ROOT, 'public', 'index.html');
const hasSrc = fs.existsSync(SRC) && fs.statSync(SRC).isDirectory();

console.log(bold('checkClient') + dim('  §8 static client invariants'));

let code = EXIT_PASS;
const advisory = [];
const pass = (m) => console.log(`  ${green('✓')} ${m}`);
const fail = (m) => {
  if (hasSrc) { code = EXIT_FAIL; console.log(`  ${red('✗')} ${m}`); }
  else advisory.push(m);
};

function walkFiles(dir, re) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full, re));
    else if (re.test(ent.name)) out.push(full);
  }
  return out;
}

/**
 * Strips // and /* comments and string/template literals before matching, so
 * a comment saying "never use innerHTML here" does not fail the innerHTML gate.
 * Deliberately crude — it only has to be right about which bytes are CODE.
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === quote) { out += ' '; i++; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
    } else {
      out += c; i++;
    }
  }
  return out;
}

function scan(files, re, label, { code: codeOnly = true } = {}) {
  const hits = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const hay = codeOnly ? stripNonCode(raw) : raw;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(hay))) {
      const line = hay.slice(0, m.index).split('\n').length;
      hits.push(`${path.relative(ROOT, f)}:${line}  ${raw.split('\n')[line - 1]?.trim().slice(0, 90)}`);
    }
  }
  if (hits.length) {
    fail(`${hits.length} ${label}`);
    for (const h of hits.slice(0, 12)) console.log(`      ${dim(h)}`);
  } else if (hasSrc) {
    pass(`no ${label}`);
  }
  return hits.length;
}

// ---------------------------------------------------------------- public/src
if (hasSrc) {
  const jsIn = (sub) => walkFiles(path.join(SRC, sub), /\.m?js$/);

  const cardDirs = [...jsIn('table'), ...jsIn('anim')];
  scan(cardDirs, /\.innerHTML\s*=|\binsertAdjacentHTML\s*\(|\bouterHTML\s*=/, 'innerHTML/outerHTML write(s) in table\\/ or anim\\/');

  scan(jsIn('anim'), /\bsetInterval\s*\(/, 'setInterval call(s) in anim/ (§0.6: one clock, rAF via core/clock.js)');

  // core/rng.js is the sanctioned source of randomness; table layout must be
  // reproducible or screenshot.mjs can never diff.
  const tableFiles = jsIn('table').filter((f) => !/rng\.m?js$/.test(f));
  scan(tableFiles, /\bMath\.random\s*\(/, 'Math.random call(s) in table/ (use core/rng.js)');

  const allSrc = walkFiles(SRC, /\.m?js$/);
  if (!allSrc.length) fail('public/src/ contains no .js modules');
  else pass(`${allSrc.length} client module(s) scanned`);
} else {
  console.log(yellow('  public/src/ does not exist yet — src scans skipped'));
}

// ---------------------------------------------------------------- index.html
if (fs.existsSync(INDEX)) {
  const html = fs.readFileSync(INDEX, 'utf8');

  // Inline handlers. Match only inside tags, so prose or a URL containing
  // "on..." in the body cannot trip it.
  const inline = [];
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let t;
  while ((t = tagRe.exec(html))) {
    const attrRe = /\s(on[a-z]+)\s*=/gi;
    let a;
    while ((a = attrRe.exec(t[0]))) {
      inline.push(`${a[1]} at line ${html.slice(0, t.index).split('\n').length}`);
    }
  }
  if (inline.length) {
    fail(`${inline.length} inline on*= handler(s) in public/index.html (§2: delegated handling only)`);
    for (const h of inline.slice(0, 12)) console.log(`      ${dim(h)}`);
  } else pass('no inline on*= handlers in public/index.html');

  // Cache-busted ES-module entry (§0.2).
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  const modules = scripts.filter((s) => /type\s*=\s*["']module["']/i.test(s) && /\ssrc\s*=/i.test(s));
  const entries = modules.filter((s) => /src\s*=\s*["']([^"']*\/src\/main\.m?js[^"']*)["']/i.test(s));
  const candidates = entries.length ? entries : modules;
  if (!candidates.length) {
    fail('no <script type="module" src="..."> entry in public/index.html (§0.2)');
  } else if (candidates.length > 1 && entries.length !== 1) {
    fail(`${candidates.length} module <script src> tags — §0.2 wants ONE entry with real imports below it`);
  } else {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(candidates[0])[1];
    if (/[?&]v=/.test(src)) pass(`entry is cache-busted ${dim(src)}`);
    else fail(`entry <script src="${src}"> is not cache-busted (needs ?v=…)`);
  }

  // Classic (non-module) app scripts mean the "no build step / real imports"
  // rule got walked back.
  const classic = scripts.filter((s) => /\ssrc\s*=/i.test(s) && !/type\s*=\s*["']module["']/i.test(s));
  if (classic.length) fail(`${classic.length} non-module <script src> tag(s) — §0.2 wants ES modules only`);
  else if (hasSrc) pass('no classic <script src> tags');
} else {
  fail('public/index.html is missing');
}

// ---------------------------------------------------------------- verdict
if (!hasSrc) {
  if (advisory.length) {
    console.log(yellow(`  ${advisory.length} advisory finding(s) against the CURRENT client (not gated, P3 replaces it):`));
    for (const a of advisory) console.log(`      ${dim(a)}`);
  }
  console.log(yellow(bold('  PENDING CLIENT')) + ' — public/src/ (P3) has not landed yet');
  process.exit(EXIT_SKIP);
}
console.log(code === EXIT_PASS ? green(bold('checkClient: PASS')) : red(bold('checkClient: FAIL')));
process.exit(code);
