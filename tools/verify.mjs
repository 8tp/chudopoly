#!/usr/bin/env node
/**
 * tools/verify.mjs — the gate. §8, as extended in P7 round 1:
 *   check → test → checkAssets → checkClient → checkServer → simbalance →
 *   playtest → touchtest → screenshot → audiotest
 *
 * EXIT CODE 2 IS A SKIP, NOT A PASS. It existed because P2 (the harness) landed
 * before P3 (the client): without it every tool reported red for work that had
 * simply not been written, and a real red would have been invisible in the
 * noise.
 *
 * P7: THAT WINDOW IS CLOSED. Every gate's subject now exists, so `--strict` is
 * the default — a skip is a failure unless you explicitly pass `--allow-skips`.
 * The five round-1 critics all found defects that gates had reported PASS
 * through; a silently-skipped gate is the same failure with fewer steps.
 *
 * Flags: --fast (skip playtest/simbalance/screenshot), --allow-skips (restore
 *        the old lenient behaviour), --strict (kept as a no-op alias),
 *        --games N (simbalance sample size)
 */
import { spawn } from 'node:child_process';
import {
  ROOT, parseArgs, green, red, yellow, bold, dim,
  EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';

const args = parseArgs();
const FAST = !!args.fast;
/** Strict is the default now. --allow-skips is the escape hatch, and it is
 *  loud, because "the gate did not run" is the failure mode this whole file
 *  exists to make impossible to miss. */
const STRICT = !args['allow-skips'];

function run(cmd, cmdArgs, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(bold(`\n━━ ${label} `) + dim(`${cmd} ${cmdArgs.join(' ')}`));
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, env: process.env });
    p.on('exit', (c) => resolve({ label, code: c ?? EXIT_FAIL, secs: (Date.now() - started) / 1000 }));
  });
}

const steps = [
  ['npm', ['run', '--silent', 'check'], 'check'],
  ['npm', ['test', '--silent'], 'test'],
  ['node', ['tools/checkAssets.mjs'], 'checkAssets'],
  ['node', ['tools/checkClient.mjs'], 'checkClient'],
  // Node-only, never skips: proves the WS error handling and the ping/pong
  // heartbeat stay wired (a single anonymous frame used to end the process).
  ['node', ['tools/checkServer.mjs'], 'checkServer'],
];
if (!FAST) steps.push(['node', ['tools/simbalance.mjs', '--games', String(args.games || 400)], 'simbalance']);
if (!FAST) steps.push(['node', ['tools/playtest.mjs'], 'playtest']);
steps.push(['node', ['tools/touchtest.mjs'], 'touchtest']);
// The review set is now gated on its own honesty (duplicate shots, undriven
// client modes, clipped text) — not on pixels, which §8 still forbids.
if (!FAST) steps.push(['node', ['tools/screenshot.mjs'], 'screenshot']);
steps.push(['node', ['tools/audiotest.mjs'], 'audiotest']);

const results = [];
for (const [cmd, a, label] of steps) results.push(await run(cmd, a, label));

console.log(bold('\n━━ verify summary'));
let failed = 0;
let skipped = 0;
for (const res of results) {
  const t = dim(`${res.secs.toFixed(1)}s`);
  if (res.code === EXIT_PASS) {
    console.log(`  ${green('✓')} ${res.label.padEnd(14)} ${t}`);
  } else if (res.code === EXIT_SKIP) {
    skipped++;
    console.log(`  ${yellow('⚠')} ${yellow(res.label.padEnd(14))} ${t} ${yellow('SKIPPED — asserted nothing')}`);
  } else {
    failed++;
    console.log(`  ${red('✗')} ${res.label.padEnd(14)} ${t} ${red(`exit ${res.code}`)}`);
  }
}

if (skipped) {
  const names = results.filter((x) => x.code === EXIT_SKIP).map((x) => x.label).join(', ');
  const paint = STRICT ? red : yellow;
  console.log('');
  console.log(paint(bold('  ⚠  ' + '─'.repeat(66))));
  console.log(paint(bold(`  ⚠  ${skipped} GATE(S) DID NOT RUN: ${names}`)));
  console.log(paint(bold('  ⚠  These assert nothing. Do not read this run as coverage.')));
  console.log(paint(bold(STRICT
    ? '  ⚠  Counted as FAILURES: every gate\'s subject exists as of P7.'
    : '  ⚠  --allow-skips is set. This run does NOT satisfy the ship gate.')));
  console.log(paint(bold('  ⚠  ' + '─'.repeat(66))));
  if (STRICT) failed += skipped;
}

if (FAST) {
  console.log(yellow(bold('\n  ⚠  --fast: simbalance, playtest and screenshot did not run.')));
}

if (failed) {
  console.log(red(bold(`\nverify: FAIL (${failed} failing, ${skipped} skipped, ${results.length} total)`)));
  process.exit(EXIT_FAIL);
}
console.log(skipped
  ? yellow(bold(`\nverify: PASS with ${skipped} skipped gate(s) — NOT the ship gate`))
  : green(bold('\nverify: PASS')));
process.exit(EXIT_PASS);
