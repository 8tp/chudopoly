#!/usr/bin/env node
/**
 * tools/verify.mjs — the gate. §8:
 *   check → test → checkAssets → checkClient → simbalance → playtest →
 *   touchtest → audiotest
 *
 * EXIT CODE 2 IS A SKIP, NOT A PASS. During P2–P5 most browser tools cannot run
 * (no client, no audio engine), and quietly treating that as green is how a
 * gate rots. Every skip is printed loudly, counted, and listed again in the
 * summary, and `--strict` turns any skip into a failure — which is what CI
 * should use from P6 onward, once nothing is legitimately pending.
 *
 * Flags: --fast (skip playtest + simbalance), --strict (skip ⇒ fail),
 *        --games N (simbalance sample size)
 */
import { spawn } from 'node:child_process';
import {
  ROOT, parseArgs, green, red, yellow, bold, dim,
  EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';

const args = parseArgs();
const FAST = !!args.fast;
const STRICT = !!args.strict;

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
];
if (!FAST) steps.push(['node', ['tools/simbalance.mjs', '--games', String(args.games || 400)], 'simbalance']);
if (!FAST) steps.push(['node', ['tools/playtest.mjs'], 'playtest']);
steps.push(['node', ['tools/touchtest.mjs'], 'touchtest']);
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
    console.log(`  ${yellow('⚠')} ${yellow(res.label.padEnd(14))} ${t} ${yellow('SKIPPED — pending client/engine, NOT verified')}`);
  } else {
    failed++;
    console.log(`  ${red('✗')} ${res.label.padEnd(14)} ${t} ${red(`exit ${res.code}`)}`);
  }
}

if (skipped) {
  const names = results.filter((x) => x.code === EXIT_SKIP).map((x) => x.label).join(', ');
  console.log('');
  console.log(yellow(bold('  ⚠  ' + '─'.repeat(66))));
  console.log(yellow(bold(`  ⚠  ${skipped} GATE(S) DID NOT RUN: ${names}`)));
  console.log(yellow(bold('  ⚠  These assert nothing today. Do not read this run as coverage.')));
  console.log(yellow(bold('  ⚠  Re-run with --strict once the client/engine they need has landed.')));
  console.log(yellow(bold('  ⚠  ' + '─'.repeat(66))));
  if (STRICT) failed += skipped;
}

if (failed) {
  console.log(red(bold(`\nverify: FAIL (${failed} failing, ${skipped} skipped, ${results.length} total)`)));
  process.exit(EXIT_FAIL);
}
console.log(skipped
  ? yellow(bold(`\nverify: PASS with ${skipped} skipped gate(s)`))
  : green(bold('\nverify: PASS')));
process.exit(EXIT_PASS);
