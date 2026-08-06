# CHUDOPOLY GO — ARCHITECTURE (LAW)

This document is **binding for every agent** working on the card-table revamp. You may push
back on any rule — but only with measurements in hand, in your final report, and you may not
silently violate it. When this file and any other doc disagree, this file wins.

Goal of the revamp: turn a working-but-dashboard-like multiplayer Monopoly-Deal variant into a
**native-feeling card game** — a physical card table where every card is an object that moves,
flips, and lands; tap-and-drag mobile controls; synthesized tactile audio; correct, explained,
balanced rules. Reference quality bar: `/Users/hunter/src/games/gatecrash` (read its
ARCHITECTURE.md §11a and its fx/audio comments if you need calibration on "juice").

## §0 Non-negotiables

1. **The server is authoritative and stays.** `server.js`, `server/*`, the WebSocket protocol
   message types in `server/protocol.js`, reconnect/resume tokens, bots, and timers are kept.
   Extend, don't replace. The client renders and requests; it never decides.
2. **No build step.** The client ships as native ES modules served statically from `public/`.
   `npm start` must remain the entire deployment story (Railway, single instance).
   `<script type="module" src="/src/main.js?v=...">` — one entry, real imports below it.
3. **Zero external binary assets.** No .png/.jpg/.mp3/.woff/.glb — ever. Every texture,
   card face, card back, icon, and sound is generated in code (CSS, inline SVG / SVG data-URIs
   authored as text, canvas, WebAudio). Enforced by `tools/checkAssets.mjs`.
4. **Every card on screen is a persistent DOM node keyed by card id** (`data-card-id`).
   Cards move between zones by reparenting + FLIP transforms. **`innerHTML` rebuilding of any
   zone that contains card nodes is banned.** (Chat/log building nodes via `textContent` is fine
   and required — XSS discipline is kept from the old client.)
5. **All animation/sfx/haptics dispatch from structured engine events** (§4), never from
   string-matching log prose. The prose log exists only as the visible Mission Log.
6. **One clock.** Client animation timing goes through `core/clock.js` (rAF, `dt` clamped to
   [0, 1/20]). No `setInterval` animation, no CSS keyframe whose *phase* matters. CSS
   transitions/keyframes are allowed for ambient loops and screen transitions only.
7. **Determinism hooks for the harness.** The engine accepts an optional seed
   (`createGame(players, {seed})` → seeded shuffle via sfc32/xmur3). The client exposes the
   `__CHUD` bridge (§9) when `?harness=1`. Harness captures must only stage states the real
   game can reach (fixtures are recorded from real games or built through engine calls).
8. **No per-frame allocation in animation hot paths**; guarded DOM writes (skip if value
   unchanged). Target: 60fps on a mid phone with 5 players and a full table.
9. **Accessibility floor:** keyboard operability (Enter/Space activate, Escape cancels/closes,
   focus trap in sheets), `prefers-reduced-motion` honored (motion collapses to fades, sound
   stays), tap targets ≥ 44px, text contrast ≥ 4.5:1 except decorative.
10. **Tests stay green.** `npm run check` and `npm test` pass at every commit. Engine changes
    update `test/*` in the same commit. The old `test/ui-contract.test.js` gets rewritten for
    the new client (keep its spirit: no inline handlers, XSS-safe chat, cache-busted entry).
11. **Comments record measurements, not intent.** A tuning constant gets the number/failure
    that produced it, or no comment at all.

## §1 Directory ownership

One owner per directory per phase. Touching a directory you don't own = your PR is wrong.
If you need a change in someone else's directory, put the request in your report.

| Path | Contents | Owner (phase) |
|---|---|---|
| `game.js`, `bot.js`, `simulate.js` | Engine, bots, balance sim | engine agent (P1) |
| `server/` | Transport, validation, timers | engine agent (P1), then frozen |
| `test/` | Node test suite | whoever changes the code under test |
| `tools/` | Harness scripts (Playwright etc.) | harness agent (P2) |
| `public/index.html` | Shell, screen containers | architect (P3) |
| `public/src/core/` | bus, clock, math/easing, dom helpers, rng | architect (P3) |
| `public/src/net/` | socket, reconnect, message router | architect (P3) |
| `public/src/state/` | store, event queue, selectors | architect (P3) |
| `public/src/table/` | zones, card nodes, layout | table agent (P3/P4) |
| `public/src/anim/` | FLIP engine, choreography per event | motion agent (P4) |
| `public/src/interact/` | tap/drag/targeting, sheets | interaction agent (P4) |
| `public/src/ui/` | screens: home/lobby/game HUD/win, chat, help | ui agent (P3/P6) |
| `public/src/audio/` | WebAudio engine, sfx bank, dispatch map | audio agent (P5) |
| `public/src/fx/` | confetti, flash, shake, floating text, haptics | fx agent (P5) |
| `public/style/` | design system CSS (see §6) | design agent (P3), then per-file |
| `ARCHITECTURE.md`, `README.md` | Law + truth | orchestrator only |

## §2 What we keep from the old client (spirit, not code)

- Server-authoritative full-state broadcasts with per-player redaction (`getPlayerView`).
- Reconnect with resume tokens in `sessionStorage`; 2s retry.
- Delegated event handling (no inline `on*=` attributes anywhere — test-enforced).
- Chat via `textContent` only. Emotes. Turn/response timers with urgency treatment.
- Safe-area insets, visualViewport keyboard handling, `@media (hover:hover)` gating.

The old `public/js/*` and `public/style/*` files are **deleted** in P3, replaced by the new
tree. Git history is the archive; do not keep a `legacy/` copy.

## §3 Gameplay balance (P1 directives)

Authoritative deck stays 106 cards. Changes below are directives; the engine agent tunes exact
numbers and **must validate with `simulate.js` winrate matrices** (≥500 games per matchup of
the 5 bot personalities; no personality > 60% or < 8% winrate in a 4-player mixed game, and
first-player advantage measured and reported).

1. **CHUD** keeps its identity (steal any property, even from a complete set — the only card
   that can) but **loses the 2M tax rider**. It is OPSEC-able. If sims show it still dominates,
   raise its face value (dead-weight as payment) rather than adding riders.
2. **Wild rent ("any")** targets **one chosen player**, like the color rents. (The old
   hit-everyone behavior was an undocumented buff.)
3. **Surge Ops** doubles the **next charge you make this turn** — rent, Finance Office,
   Roll Call, any demand — matching its card text. Still costs a play.
4. **Zero-value wilds**: keep value 0 (dead weight is their cost), but fix the insolvency
   exploit — a player whose only cards are zero-value cards must surrender them when they
   cannot otherwise pay ("pay with everything you have" already exists; make zero-value cards
   count as "something").
5. **Overstacking**: a color zone holds at most `set size` property cards. Extra copies must
   go to a different legal zone (wilds) or stay in hand. Kills the armor exploit.
6. **Stalemate end**: when the deck and discard are both empty and a full round passes with no
   card leaving any hand, the game ends; most completed sets wins, net worth breaks ties.
7. **Upgrades (FOC/hangar)** stay off-limits as payment (matches MD) but must be **shown** in
   net worth display so the UI never lies.
8. **Free wild rearranging** stays (it's good), but becomes a first-class visible interaction.
10. **FINAL APPROACH (win grace cycle — owner directive 2026-08-06).** Reaching 3 complete
    sets does NOT win immediately (deliberate departure from Monopoly Deal). It arms *final
    approach*: every other player gets exactly one turn to respond; if the player still holds
    ≥3 complete sets when their own next turn begins, they win then. Dropping below 3 disarms
    (and can re-arm — each arming restarts the cycle). Multiple players can be armed at once;
    the first to reach their checkpoint still armed wins. Engine emits `final_approach`
    `{actor, sets}` on arm and `final_approach_broken` `{actor, by}` on disarm so the client
    can treat it as the dramatic peak it is. Bots must understand both defending and breaking
    a final approach. `last_standing` (scoop-out) still ends the game immediately.
    The checkpoint requires a **full round**: the win resolves at the armed player's first
    own-turn start that is ≥ one full turn cycle after arming, so every opponent is
    guaranteed at least one turn to respond regardless of when the arming happened.
11. **Deck-cycle attrition end (ratified from P1b measurement).** After the discard has been
    reshuffled into the deck **16 times**, the game ends on points exactly like §3.6
    (most completed sets, net worth tiebreak), emitting `stalemate {reason:'deck_cycles'}`.
    Measured: fires in 0.45% of games, only at 5 players, and caps the pathological tail
    (p99 387 turns → max 152) without touching healthy games (p90 reshuffles = 5).
9. Every rule above must be reflected in card text and the help content — **no rule may exist
   that the help screen doesn't state**. The help must also cover: rent on incomplete sets,
   set sizes/rent ladders, OPSEC chains, scoop, hand limit, and win-on-opponent's-turn.

## §4 Structured event channel (the protocol addition)

The engine appends events to `state.events` as it mutates. Broadcast includes the tail
(last 120). Envelope: `{ seq, t, ...payload }` — `seq` monotonically increasing per game.
Client tracks `lastSeq`, animates only unseen events in order, then **reconciles** the DOM
against the state snapshot (the snapshot is always truth; animation is presentation).

Redaction rule: events must leak nothing `getPlayerView` hides. Draws/deals carry card ids
only in the drawer's own view; other players get `{count}`. Cards becoming public (played,
paid, discarded, stolen) carry the full public card object `{id, name, type, color, value}`
so the client can animate a card it has never seen.

Vocabulary (engine agent may append rows in its report; may not repurpose existing ones):

| t | payload | fired when |
|---|---|---|
| `game_start` | `{order:[pid], names:{pid:name}}` | game created |
| `deal` | `{to, count, cards?}` | opening hands |
| `turn_start` | `{actor, plays}` | turn begins |
| `draw` | `{to, count, cards?}` | draw phase / empty-hand 5 |
| `shuffle` | `{deckCount}` | discard reshuffled into deck |
| `play_money` | `{actor, card}` | banked |
| `play_property` | `{actor, card, color}` | property/wild placed |
| `play_action` | `{actor, card, action}` | action card hits the table |
| `rent_charged` | `{actor, color, amount, targets, doubled}` | rent played |
| `demand` | `{actor, target, amount, reason}` | finance/rollcall demand |
| `opsec` | `{actor, against, depth}` | OPSEC played (incl. counter-OPSEC) |
| `payment` | `{from, to, cards, total}` | payment resolves |
| `insolvent` | `{from, to}` | target had nothing of value |
| `steal` | `{actor, from, card, toColor}` | midnight requisition / CHUD |
| `swap` | `{actor, target, gave, took}` | TDY orders |
| `set_stolen` | `{actor, from, color, cards}` | inspector general |
| `upgrade` | `{actor, color, card}` | FOC/hangar placed |
| `move_property` | `{actor, card, from, to}` | wild rearranged |
| `set_completed` | `{actor, color}` | a set completes (any cause) |
| `discard` | `{actor, cards}` | end-of-turn discard |
| `turn_end` | `{actor}` | turn passes |
| `scoop` | `{actor}` | player scoops |
| `win` | `{actor, sets}` | victory |
| `stalemate` | `{winner, reason}` | deck-dry end |

## §5 Client architecture (P3+)

- **Store**: one module holding `{snapshot, self, room, timers, lastSeq}`. Snapshot replaced
  wholesale per `state` message; an **event queue** feeds the choreographer. Subscribers get
  `(snapshot, events)`. No `window._*` globals — interaction state lives in `interact/`.
- **Choreographer** (`anim/`): consumes events serially (max ~600ms per event, overlappable
  where safe), drives table mutations through `table/`'s API, then calls `table.reconcile
  (snapshot)` which corrects any drift silently. On reconnect or `?harness=1` fixture load:
  skip animation, snap.
- **Table API** (`table/`): `zoneFor(kind, ownerId, color?)`, `spawnCard(card | back)`,
  `moveCard(id, zone, {flip, arc, delay})` (FLIP: measure → reparent → invert → spring to 0),
  `reconcile(snapshot)`. Card faces are built once per card node and cached.
- Opponent hands render as **fanned card backs** (count-accurate up to 9, then a counter).
  The deck is a real stack with depth (up to 6 stacked back nodes + count). Discard shows the
  real top card, slightly rotated per card (seeded by card id — deterministic).
- Your properties and opponents' properties are **real miniature cards** in set columns —
  never text rows, never colored squares. Tapping any zone zooms it (no data hidden on touch).
- **Interactions** (`interact/`): tap a hand card → it lifts and shows an inline action strip
  (Play / Bank / Details), not a modal. Drag the same card to a zone to play it directly
  (drop targets highlight; invalid targets shake head). Targeting (rent target, steals) happens
  **on the table**: eligible player boards glow, tap to choose; Escape/scrim-tap cancels.
  Payment selection: your bank/property cards become toggleable with a running total chip and
  a confirm bar. Bottom sheets only for: card details, help, settings, discard pick.
- **Timers**: served `{timeout, startedAt}` → client renders ring/bar; urgency at ≤10s and
  ≤5s (sound + haptic once each, not per tick).

## §6 Design system (P3 design agent; binding on everyone after)

- **Identity: "night flight line."** A felt-and-tarmac card table under hangar light. Navy
  felt surface (radial gradient + SVG feTurbulence grain, authored inline), gold as *foil* —
  reserved for emphasis (your turn, selection, CHUD, victory) — silver/steel for chrome,
  signal colors only from card sets.
- **One scale unit**: `--s: clamp(...)` on the app root; components size in `em`/`--s`
  multiples. Portrait override allowed. No other `px` font sizes.
- **Cards are the heroes**: aspect ratio 5:7 everywhere (one `--card-w` per context:
  hand/table/mini), layered face (frame, type band, name, art field, rent ladder, value coin),
  procedural per-color art motif (CSS/SVG — e.g. contrails, roundels, runway chevrons),
  embossed edge (inset highlight + drop shadow), **a real card back** (AF star roundel,
  used for deck, opponent hands, and flips). `backface-visibility` flips for reveals.
- **Type**: system stack, weight 800/900 for display with tight tracking; small caps/
  letterspacing for micro-labels. No webfonts (see §0.3).
- **Motion language**: overshoot easings (`cubic-bezier(.18,1.5,.4,1)` family) for landings;
  cards travel with slight arc + rotation; springs from `core/math.js` (`damp`, `spring`,
  `easeOutBack`) for JS-driven motion. Durations 180–420ms; nothing over 600ms uninterruptible.
- **Dark only.** No light theme. `theme-color` set. Looks native full-screen on a phone
  (`viewport-fit=cover`, safe areas, `overscroll-behavior:none`, no tap highlight).

## §7 Audio (P5) — all WebAudio synthesis

- No `AudioContext` before a user gesture; every call no-ops silently until `init()`.
- Master chain: `sfx/ui/music buses → compressor (-14dB, 12:1) → soft-clip WaveShaper →
  master`. No clipping as a graph invariant.
- **Card-tactile vocabulary is mandatory**: shuffle riffle (filtered noise bursts), card slide
  (short noise swish), card snap-down (thump + click transient), flip (pitch-swept tick),
  chip/coin for money, distinct positive chime ladder for set progress (pentatonic,
  monotonic), a *distinctly sour* treatment (tritone/downglide) for being stolen from or
  paying, klaxon-adjacent hit for CHUD, resolved fanfare + crowd-less confetti crackle for win.
- Events happening **to you** are louder/centered; others' are quieter. Rate-limit per sound;
  voice cap with weights.
- Haptics (`navigator.vibrate` where available): short tick on your card landing, double-buzz
  on being targeted, success pattern on set completion, long on win. Never more than one
  pattern per event.

## §8 Harness (P2, `tools/`)

All tools run headless Chromium (Playwright, devDependency) against `npm start` on an
ephemeral port, plus Node-only engine tools. Every tool exits nonzero on failure.

| Tool | Asserts |
|---|---|
| `tools/checkAssets.mjs` | no binary assets anywhere in repo (allowlist: none) |
| `tools/checkClient.mjs` | no `innerHTML` writes in `table/`/`anim/`; no `on*=` in html; no `Math.random` outside `core/rng.js` usage in table layout paths; entry is cache-busted |
| `tools/simbalance.mjs` | winrate matrix per §3 bounds, prints table for README |
| `tools/playtest.mjs` | full seeded game vs bots to the win screen, zero console errors, zero missed reconciles (bridge counts drift corrections; must be 0 except reconnect) |
| `tools/touchtest.mjs` | touch-only playthrough of core actions on emulated 390×844 DPR3: drag-play a card, pay rent, target a steal; HUD fits; no 300ms ghosts |
| `tools/screenshot.mjs` | 30+ shot review set from fixtures (desktop 1280×720 + phone 390×844): home, lobby, mid-game, targeting, payment, OPSEC chain, big hand, 5-player table, win. Writes `shots/` + `contactsheet.png` |
| `tools/audiotest.mjs` | OfflineAudioContext render: peak ≤ 0dBFS, chime ladder monotonic, sour cue below chime-0 |

`npm run verify` chains: `check → test → checkAssets → checkClient → simbalance → playtest →
touchtest → audiotest`. Screenshot review sets are for humans/critics, not gated on pixels
(no imagediff until the design settles; add it in P7).

## §9 The `__CHUD` bridge (test-only contract)

With `?harness=1`, the client exposes `window.__CHUD`:

```js
{
  version: 1,
  ready: Promise,            // resolves when modules are up
  applyState(stateMsg),      // inject a full server state message (fixture)
  drainEvents(),             // run queued event animations instantly
  sfxLog: [],                // {name, t} — audio engine records instead of playing
  hapticLog: [],
  driftCount: 0,             // reconcile corrections since load (0 = choreography honest)
  lastError: null,
}
```

Fixtures live in `tools/fixtures/*.json` and are **recorded from real seeded games**
(a recorder script saves the state broadcasts), never hand-authored — states the game
cannot reach must not be screenshot.

## §10 Hard-won invariants (append here as they're earned)

| Invariant | Why | Enforced by |
|---|---|---|
| Card conservation (106, no dupes) before every broadcast | corrupt state = unwinnable game | `validateState` in engine |
| Events leak nothing `getPlayerView` hides | hidden information is the game | `test/protocol.test.js` additions (P1) |
| Snapshot is truth; animation is presentation | desync shows wrong game | `driftCount === 0` in playtest |
| No `AudioContext` before gesture | silent console, autoplay policy | audiotest + code review |
| Zone containers never innerHTML-rebuilt | kills FLIP, scroll, focus | checkClient scan |
| Choreography ≤600ms/event, interruptible | multiplayer can't wait on your cinematics | motion agent measures; playtest wall-clock |

## §11 Phase plan and review gate

P0 constitution → P1 engine+balance → P2 harness → P3 client core (architect, then table/ui/
design in parallel) → P4 motion+interaction → P5 audio+fx → P6 content+clarity → P7 beauty
passes + adversarial gauntlet.

The **gate**: independent critic agents score Look, Feel/Juice, Mobile UX, Clarity/Rules,
and Robustness 1–10 with evidence (screenshots, playtest logs). Ship requires **≥8/10 on
every axis**, re-scored after each fix round by *fresh* critics. Scores without cited
evidence are void. The final README must include an honest-assessment section with the last
round's real numbers.
