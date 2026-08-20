# replayeval — pricing bot policies against recorded games

`tools/replayeval.mjs` is the instrument BOT-STRATEGY round 12b names as missing. The two
instruments that existed could not answer "does this change make a bot stronger against
the games people actually play?": `simbalance` divides a fixed pot among bots, so a change
that strengthens every seat moves nothing in it, and production A/B at ~100 games/week
cannot resolve a 3–5pp effect inside a season. This tool rebuilds the exact engine states
recorded games passed through and prices a candidate policy with paired rollouts from
those states. On the current production corpus that is **13,828 real decision points**
from 153 games, and a full-corpus pricing run takes under a minute.

## What it does

1. **Reconstruction.** A gamelog record's event stream is replayed through the real
   engine — every command re-issued via `game.js` itself (`playAsMoney`, `playAction`,
   `respondToAction`, `endTurn`, …), nothing re-implemented. Draws are "rigged" so the
   deck yields the recorded cards: directly on the deck top, or — when the record shows a
   reshuffle — via a planned Fisher–Yates permutation handed to the engine's own RNG, so
   the engine still performs its own shuffle, event and cycle-count included. Every
   emitted event is compared field-by-field against the record as it happens, and the
   final boards, winner, end reason and turn count are compared at the end. **A game is
   reconstructed exactly or rejected — never approximated.**

2. **Decision points.** At every play-phase choice of a focus seat (its turn, no pending
   action), the full state is snapshotted along with the action actually taken.

3. **Determinized paired rollouts.** From a decision point the only unknown is the deck
   order: hands are known (the retained event stream is unredacted), and the deck's
   multiset is `buildDeck(rules.deck)` minus every visible card. Each rollout samples a
   fresh uniform order of exactly that multiset — the true conditional distribution given
   uniform shuffles — and both arms share the determinization seed and the bot-RNG seed,
   so a delta is measured inside matched worlds.

4. **Aggregation.** Mean win-probability delta per evaluated point, with a 95% cluster
   bootstrap CI resampling **games** (decision points inside one game share a trajectory
   and are not independent).

## How to run it

```sh
# The reconstruction gate (exits nonzero on any inexact game):
node tools/replayeval.mjs --log logs/production-games.jsonl --verify

# Price a candidate at the neutral bot's real production decision points:
node tools/replayeval.mjs --log logs/production-games.jsonl \
  --subject cashfloor:neutral --baseline neutral --focus neutral --rollouts 24

# One-step deviation against what the human actually played:
node tools/replayeval.mjs --log logs/production-games.jsonl \
  --subject neutral --baseline recorded --focus human --rollouts 16
```

Policies: the five lobby personas plus `humanlike`, `persona@scale` variants, and
evaluation-only wrappers `cashfloor:<mode>` / `nocompleter:<mode>` (defined inside
`tools/lib/replay.js`; **bot.js is untouched** — a test asserts it). `--baseline
recorded` compares the subject's first action against the recorded one with both arms
continuing under identical policies (isolates the decision); a policy baseline rolls each
arm's seat under its own policy for the whole continuation (prices a persistent change).

## Validation (2026-08-20, this corpus)

* **Exactness:** 118/118 loadable dev-corpus records reconstruct exactly; 153/153
  production records reconstruct exactly. The 115 dev records with seeds ALSO replay from
  bare `(seed, rules, seats)` with every drawn card matching the record — proving both
  record fidelity and the command inference, independently of the rigging.
* **Mutation-proved:** a tampered draw or tampered final board is rejected
  (`test/replayeval.test.js`).
* **Null:** identical subject and baseline return a delta of **exactly zero** — and this
  gate caught a real defect on first run (per-arm decide() RNG streams manufactured
  divergence between identical policies; both arms now share the stream).
* **Discrimination:** a policy lobotomized to refuse set completions prices −33pp against
  its base; `random` prices −14.0pp [−16.1, −12.8] against `aggressive` at human decision
  points. Wrapper knobs are asserted to have fired before any delta is believed
  (round 13's identical-numbers-means-broken-harness lesson).
* **Known ordering reproduced from real data:** `aggressive` prices **+3.23pp
  [+1.46, +4.94]** over `neutral` at neutral's production decision points — the same
  ordering the production win rates show (28.6% vs 10.7% in round 12b's paired tables).

## First real use: the cash floor, re-priced

Round 12b measured the strongest human-behavior finding in the corpus — humans bank up
and lose half as much board to payments as neutral does — implemented a cash floor three
ways, found a real cost in bot-vs-bot play and an unmeasurable benefit, and rejected it
pending "the missing instrument". With the instrument:

> **cashfloor:neutral vs neutral**, at neutral's 831 divergent production decision
> points, 24 paired rollouts each: **−6.67pp, 95% CI [−7.97, −5.48]**.

The floor is not an unpriceable trade-off; it is measurably worse at the very states
production neutral actually faced. The rejection stands, now with a number on it.
(The wrapper re-derives round 12b's first cut — "bank while the bank cannot cover the
largest charge the table can print at you", completions exempt — from its description;
the original experimental diff was never committed.)

## Limits — read before quoting numbers

* **Deltas are priced under bot continuation play.** Human seats are continued by
  `humanlike` (round 13's instrument: a good behaviour clone, a poor strength clone), bot
  seats by their recorded modes. Like `simhuman`, this **ranks** policies; it does not
  certify difficulty against a live human. A CI excluding zero is a real ordering at real
  states; the magnitude is a proxy.
* **Records must be complete.** A stream truncated by the engine's 400-event retention
  cap has lost its opening deals and is skipped (11 of the current production file), as
  are pre-`779b1a1` legacy walkovers whose ending was never written as an event (1).
* **A blocked steal never reveals its named target card**; the replay substitutes a legal
  one. The post-block state is identical either way; only the transient pendingAction
  differs, and no decision point is captured while a pending action is live.
* **Response decisions** (OPSEC, payment composition) are replayed exactly but not yet
  offered as evaluation points — play-phase decisions only.
* Rollouts cap at 300 turns; an unfinished rollout counts as a non-win for the seat.

## Cost

Reconstruction of the full production corpus: ~0.6s. Pricing: roughly
`evaluated-points × 2 × rollouts` playouts; the cash-floor run above (831 × 48 ≈ 40k
playouts) took 26s. `--max-points` and `--rollouts` trade power for time; `--at all`
evaluates non-divergent points too (they contribute exact zeros under a shared seed —
variance reduction, at playout cost).
