#!/usr/bin/env node
/**
 * tools/record.mjs — record REAL games and cut fixtures from them (§9).
 *
 * §9: "Fixtures live in tools/fixtures/*.json and are recorded from real seeded
 * games … states the game cannot reach must not be screenshot." So this tool
 * plays actual games against the real server with the real bots and keeps every
 * `state` broadcast the seat receives, then selects named moments by predicate.
 *
 * It drives the seat over a raw `ws` socket (tools/lib/wsclient.mjs) rather than
 * through the browser, because the P3 client does not exist yet. The fixture
 * format is the server's own `state` message, so switching to browser capture
 * later changes nothing downstream.
 *
 * Output:
 *   tools/fixtures/session-*.json   full transcript — every state, in order
 *   tools/fixtures/<moment>.json    one selected state + why it was selected
 *
 * Usage: node tools/record.mjs [--seed N] [--maxMs 300000] [--bots chud,chud]
 *                              [--verbose] [--only 3p|5p]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR, SEED, ensureDir, parseArgs, green, red, yellow, dim, bold,
  EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';
import { ChudClient, driveGame } from './lib/wsclient.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;
const maxMs = args.maxMs ? Number(args.maxMs) : 300000;
const verbose = !!args.verbose;
const only = args.only || null;

ensureDir(FIXTURE_DIR);
console.log(bold('record') + dim(`  seed=${seed} → ${path.relative(process.cwd(), FIXTURE_DIR)}/`));

const written = [];
function write(name, payload) {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  // Transcripts are compact: a pretty-printed 144-state transcript is 4.9MB
  // (each state carries the 120-event tail and the whole discard pile).
  // Curated single-state fixtures stay readable — a human reviews those.
  const pretty = payload.states.length <= 3;
  fs.writeFileSync(file, JSON.stringify(payload, null, pretty ? 1 : 0) + '\n');
  written.push({ name, states: payload.states.length, bytes: fs.statSync(file).size, note: payload.description });
  return file;
}

/* ─────────────────────────────── session ─────────────────────────────── */

/**
 * Play one game and return every state broadcast this seat saw.
 * @param {{label:string, bots:string[], seed:number, turnTimeout:number, responseTimeout:number, maxMs:number}} cfg
 */
async function session(server, cfg) {
  const client = new ChudClient(server.wsUrl, { name: 'HARNESS', verbose });
  await client.connect();

  await client.send({ type: 'create_room', name: 'HARNESS' });
  await client.waitFor((m) => m.type === 'joined', 10000, 'joined');
  const lobby = [];
  const states = [];

  // Lobby fill. add_bot is host-only and lobby-only (server/handlers.js).
  for (const mode of cfg.bots) {
    await client.send({ type: 'add_bot', mode });
    const s = await client.waitFor((m) => m.type === 'state', 10000, 'lobby state');
    lobby.push(s);
  }

  const collected = [];
  const res = await driveGame(client, {
    maxMs: cfg.maxMs,
    initialState: lobby[lobby.length - 1],
    planOpts: { turnTimeout: cfg.turnTimeout, responseTimeout: cfg.responseTimeout },
    onState: (msg) => {
      collected.push(msg);
      if (collected.length % 25 === 0) process.stdout.write(dim('.'));
    },
  });
  states.push(...collected);
  client.close();

  return { ...res, lobby, states, selfId: client.playerId, code: client.roomCode, errors: client.errors };
}

/* ────────────────────────────── selectors ────────────────────────────── */

const boardCount = (g) =>
  g.players.reduce((n, p) => n + Object.values(p.properties || {}).flat().length, 0);
const bankCount = (p) => (p.bank || []).length;
const propCount = (p) => Object.values(p.properties || {}).flat().length;

/** @type {Array<{name:string, description:string, pick:(states:object[], selfId:string)=>object|null}>} */
const MOMENTS = [
  {
    name: 'early-game',
    description: 'First play phase of the opening turn — small hands, empty boards, full deck.',
    pick: (states) => states.find((s) => s.game?.turnPhase === 'play' && boardCount(s.game) <= 2)
      || states.find((s) => s.game?.turnPhase === 'play') || null,
  },
  {
    name: 'mid-game',
    description: 'Every seat holds properties and banked money — the dense table the layout must survive.',
    pick: (states) => {
      const ok = states.filter((s) => s.game && s.game.players.every((p) => propCount(p) >= 1 && bankCount(p) >= 1));
      if (!ok.length) return null;
      // Prefer the busiest board rather than the first qualifying one.
      return ok.reduce((best, s) => (boardCount(s.game) > boardCount(best.game) ? s : best));
    },
  },
  {
    name: 'payment-pending',
    description: 'A pending charge this seat owes — stages payment selection and the response timer.',
    pick: (states, selfId) => {
      const owes = (s) => {
        const pa = s.game?.pendingAction;
        if (!pa || !(pa.amount > 0)) return false;
        return pa.type === 'payment_all'
          ? Array.isArray(pa.pending) && pa.pending.includes(selfId)
          : pa.responderId === selfId;
      };
      const hits = states.filter(owes);
      if (!hits.length) return states.find((s) => s.game?.pendingAction?.amount > 0) || null;
      return hits.reduce((best, s) => (boardCount(s.game) > boardCount(best.game) ? s : best));
    },
  },
  {
    name: 'targeting',
    description: 'This seat is on turn holding a card that needs an on-table target, with legal targets present.',
    pick: (states, selfId) => states.find((s) => {
      const g = s.game;
      if (!g || g.pendingAction || g.currentPlayerId !== selfId || g.turnPhase !== 'play') return false;
      const me = g.players.find((p) => p.id === selfId);
      const needsTarget = (me?.hand || []).some(
        (c) => c.type === 'rent' || ['midnight_requisition', 'chud', 'finance_office', 'inspector_general', 'tdy_orders'].includes(c.action)
      );
      const foesHaveStuff = g.players.some((p) => p.id !== selfId && propCount(p) > 0);
      return needsTarget && foesHaveStuff;
    }) || null,
  },
  {
    name: 'opsec-chain',
    description: 'A pending action with a live OPSEC counter-chain — the deepest chain recorded.',
    pick: (states) => {
      // P1 shape: pendingAction.targets[] = {id, depth, responderId}; depth is
      // the OPSEC counter-chain length. (The pre-rewrite shape used
      // opsecChains/_opsecChain — read both so old transcripts still select.)
      const depth = (s) => {
        const pa = s.game?.pendingAction;
        if (!pa) return 0;
        const fromTargets = (pa.targets || []).map((t) => t.depth || 0);
        const fromChains = Object.values(pa.opsecChains || {}).map((c) => c.chain || 1);
        return Math.max(pa._opsecChain || 0, 0, ...fromTargets, ...fromChains);
      };
      const hits = states.filter((s) => depth(s) > 0);
      if (!hits.length) return null;
      return hits.reduce((best, s) => (depth(s) > depth(best) ? s : best));
    },
  },
  {
    name: 'big-hand',
    description: 'Largest hand this seat ever held — the fan-layout worst case (hand limit is 7 plus draws).',
    pick: (states, selfId) => {
      const size = (s) => (s.game?.players.find((p) => p.id === selfId)?.hand || []).length;
      const hits = states.filter((s) => size(s) >= 8);
      if (!hits.length) return null;
      return hits.reduce((best, s) => (size(s) > size(best) ? s : best));
    },
  },
  {
    name: 'finished',
    description: 'Win screen state — winner set, phase finished, final boards intact.',
    pick: (states) => [...states].reverse().find((s) => s.game?.phase === 'finished') || null,
  },
];

/* ──────────────────────────────── run ────────────────────────────────── */

let code = EXIT_PASS;
const server = await startServer({ seed });
console.log(dim(`  server on ${server.url}`));

try {
  /* ---- 3-player game, played to the end ---------------------------------- */
  let main = null;
  if (only !== '5p') {
    const bots = (args.bots ? String(args.bots).split(',') : ['chud', 'aggressive']).map((s) => s.trim());
    process.stdout.write(`  3p vs [${bots.join(', ')}] `);
    main = await session(server, {
      label: '3p', bots, seed,
      turnTimeout: 60, responseTimeout: 30, maxMs,
    });
    console.log(
      ` ${main.finished ? green('finished') : yellow('timed out')} ` +
      dim(`${main.states.length} states, room ${main.code}`)
    );
    if (main.errors.length) {
      console.log(dim(`    ${main.errors.length} server rejections (expected: the policy probes moves)`));
    }
    if (!main.states.length) {
      console.log(red('  ✗ no state broadcasts received'));
      code = EXIT_FAIL;
    }

    // Six evenly spaced states from the same real game. The full transcript is
    // 2.5MB and gitignored; this is the committed slice the shot list uses, so
    // a fresh clone can regenerate the review set without recording first.
    if (main.states.length >= 6) {
      const step = (main.states.length - 1) / 5;
      const arc = Array.from({ length: 6 }, (_, i) => main.states[Math.round(i * step)]);
      write('arc', {
        $schema: 'chud-fixture/1',
        name: 'arc',
        description: 'Six evenly spaced moments from one real 3-player game, opening to win screen.',
        seed, selfId: main.selfId, room: main.code,
        recordedAt: new Date().toISOString(),
        states: arc,
      });
      console.log(`  ${green('✓')} ${'arc'.padEnd(16)} ${dim(`6 moments across ${main.states.length} broadcasts`)}`);
    }

    write('session-3p', {
      $schema: 'chud-fixture/1',
      name: 'session-3p',
      description: 'Full transcript: every state broadcast one seat received across a real 3-player game.',
      seed, selfId: main.selfId, room: main.code, recordedAt: new Date().toISOString(),
      states: main.states,
    });

    for (const m of MOMENTS) {
      const hit = m.pick(main.states, main.selfId);
      if (!hit) { console.log(`  ${yellow('!')} ${m.name.padEnd(16)} ${dim('not reached in this game')}`); continue; }
      write(m.name, {
        $schema: 'chud-fixture/1',
        name: m.name,
        description: m.description,
        seed, selfId: main.selfId, room: main.code,
        recordedAt: new Date().toISOString(),
        stateIndex: main.states.indexOf(hit),
        states: [hit],
      });
      console.log(`  ${green('✓')} ${m.name.padEnd(16)} ${dim(`turn ${hit.game?.stats?.turns ?? '?'}, ${boardCount(hit.game)} cards on boards`)}`);
    }
  }

  /* ---- 5-player table + a real lobby ------------------------------------- */
  if (only !== '3p') {
    process.stdout.write('  5p table ');
    const five = await session(server, {
      label: '5p', bots: ['conservative', 'neutral', 'aggressive', 'chud'], seed: seed + 1,
      turnTimeout: 60, responseTimeout: 30,
      maxMs: Math.min(maxMs, Number(args.fiveMs || 90000)),
    });
    console.log(` ${dim(`${five.states.length} states, room ${five.code}`)}`);

    if (five.lobby.length) {
      const full = five.lobby[five.lobby.length - 1];
      write('lobby', {
        $schema: 'chud-fixture/1',
        name: 'lobby',
        description: 'Real 5-seat lobby broadcast: host, four bots with modes, no game yet.',
        seed: seed + 1, selfId: five.selfId, room: five.code,
        recordedAt: new Date().toISOString(),
        states: [full],
      });
      console.log(`  ${green('✓')} ${'lobby'.padEnd(16)} ${dim(`${full.players.length} seats`)}`);
    }

    const busiest = five.states.length
      ? five.states.reduce((best, s) => (s.game && boardCount(s.game) > boardCount(best.game || { players: [] }) ? s : best), five.states[0])
      : null;
    if (busiest?.game) {
      write('five-player', {
        $schema: 'chud-fixture/1',
        name: 'five-player',
        description: 'Busiest 5-player board reached — the maximum-density table (§8 shot list).',
        seed: seed + 1, selfId: five.selfId, room: five.code,
        recordedAt: new Date().toISOString(),
        stateIndex: five.states.indexOf(busiest),
        states: [busiest],
      });
      console.log(`  ${green('✓')} ${'five-player'.padEnd(16)} ${dim(`${boardCount(busiest.game)} cards on boards`)}`);
    } else if (!main) {
      code = EXIT_FAIL;
    }
  }
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  await server.stop();
}

console.log(dim(`  ${written.length} fixture file(s):`));
for (const w of written) {
  console.log(dim(`    ${w.name.padEnd(18)} ${String(w.states).padStart(4)} state(s)  ${String(Math.round(w.bytes / 1024)).padStart(4)}KB`));
}
console.log(code === EXIT_PASS ? green(bold('record: PASS')) : red(bold('record: FAIL')));
process.exit(code);
