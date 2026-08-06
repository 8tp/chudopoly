#!/usr/bin/env node
/**
 * tools/playtest.mjs — a full seeded game to the win screen, in the browser (§8).
 *
 * Asserts:
 *   • zero pageerrors and zero console.error for the whole game
 *   • __CHUD.driftCount === 0 — the choreographer's DOM matched every snapshot,
 *     so the animation never lied about the game (§10). Nonzero means reconcile
 *     had to silently correct the table, which is the bug this tool exists for.
 *   • the game actually reaches phase 'finished' with a winner
 *   • __CHUD.lastError is null
 *
 * The seat is driven the same way record.mjs drives one — over a raw socket
 * from Node — while the BROWSER watches the same room as a spectator seat. That
 * keeps the move policy in one place and means a client bug cannot deadlock the
 * game it is supposed to be rendering.
 *
 * Exits 2 (PENDING CLIENT) until public/src/ exposes window.__CHUD (§9).
 */
import {
  SEED, parseArgs, launchBrowser, openPage, requireBridge, reporter,
  green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';
import { ChudClient, driveGame } from './lib/wsclient.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;
const maxMs = Number(args.maxMs || 240000);

const r = reporter(`playtest  ${dim(`seed=${seed}`)}`);
const server = await startServer({ seed });
let browser = null;
let code = EXIT_PASS;

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`);
  // Fail fast: a missing bridge is a PENDING, not a 45s selector wait.
  await requireBridge(h.page, 8000);
  r.pass('client booted with the __CHUD bridge');

  const version = await h.page.evaluate(() => window.__CHUD.version);
  if (version !== 1) r.fail(`__CHUD.version is ${version}, expected 1 (§9)`);
  else r.pass('bridge contract v1');

  // ---- play a real game over a socket, feeding the page every state --------
  const client = new ChudClient(server.wsUrl, { name: 'PLAYTEST' });
  await client.connect();
  await client.send({ type: 'create_room', name: 'PLAYTEST' });
  await client.waitFor((m) => m.type === 'joined', 10000, 'joined');

  const lobby = [];
  for (const mode of ['chud', 'aggressive']) {
    await client.send({ type: 'add_bot', mode });
    lobby.push(await client.waitFor((m) => m.type === 'state', 10000, 'lobby state'));
  }

  let applied = 0;
  let applyError = null;
  const drive = await driveGame(client, {
    maxMs,
    initialState: lobby[lobby.length - 1],
    planOpts: { turnTimeout: 60, responseTimeout: 30 },
    onState: async (msg) => {
      try {
        await h.page.evaluate((state) => window.__CHUD.applyState(state), msg);
        applied++;
      } catch (e) {
        applyError = applyError || e.message;
      }
    },
  });
  client.close();

  if (applyError) r.fail(`__CHUD.applyState threw: ${applyError}`);
  else r.pass(`${applied} state broadcast(s) applied to the client`);

  if (drive.finished) r.pass(`game reached 'finished' in ${drive.stateCount} broadcasts`);
  else r.fail(`game never finished (${drive.timedOut ? 'timed out' : 'socket closed'}) after ${drive.stateCount} broadcasts`);

  const winner = drive.lastState?.game?.winner;
  if (drive.finished && !winner) r.fail("phase is 'finished' but no winner is set");
  else if (winner) r.pass(`winner recorded ${dim(String(winner))}`);

  // ---- bridge assertions ---------------------------------------------------
  await h.page.evaluate(() => window.__CHUD.drainEvents?.()).catch(() => {});
  const bridge = await h.page.evaluate(() => ({
    drift: window.__CHUD.driftCount,
    lastError: window.__CHUD.lastError ? String(window.__CHUD.lastError) : null,
    sfx: (window.__CHUD.sfxLog || []).length,
    haptics: (window.__CHUD.hapticLog || []).length,
  }));

  if (bridge.drift === 0) r.pass('driftCount 0 — every animation left the DOM matching the snapshot (§10)');
  else r.fail(`driftCount ${bridge.drift} — reconcile had to correct the table ${bridge.drift}× (§10 requires 0)`);

  if (bridge.lastError) r.fail(`__CHUD.lastError: ${bridge.lastError}`);
  else r.pass('__CHUD.lastError is null');

  r.info(`sfx events ${bridge.sfx}, haptic events ${bridge.haptics}`);

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s)`);
    for (const e of h.errors.slice(0, 8)) console.log(red(`      ${e}`));
  } else r.pass('zero console/page errors across the whole game');

  await h.close();
  code = r.code;
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('playtest: PASS')) : red(bold('playtest: FAIL')));
process.exit(code);
