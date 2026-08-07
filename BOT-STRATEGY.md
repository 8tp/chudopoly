# Bot Strategy: How We Built the AI

This document covers the research, simulation pipeline, data analysis, and iterative tuning process behind the AI opponents in Chudopoly. The goal was to create bots that play strategically and feel human — not by guessing at good play, but by running hundreds of simulated games and analyzing what actually wins.

## Table of Contents

- [Starting Point](#starting-point)
- [Building the Simulation Pipeline](#building-the-simulation-pipeline)
- [Baseline Analysis: 500 Games](#baseline-analysis-500-games)
- [Key Findings: What Felt Robotic](#key-findings-what-felt-robotic)
- [Tuning Iterations](#tuning-iterations)
- [Early, Mid & Late Game Analysis](#early-mid--late-game-analysis)
- [Combo Detection & Sequencing](#combo-detection--sequencing)
- [OPSEC Economy](#opsec-economy)
- [Targeting Patterns](#targeting-patterns)
- [Final Bot Behavior Summary](#final-bot-behavior-summary)
- [Results: Before vs After](#results-before-vs-after)

## Starting Point

The initial bot implementation used five personality modes — Random, Conservative, Neutral, Aggressive, and Chud — with distinct decision priorities. Conservative played properties and banked everything else. Aggressive led with rent and attacks. Chud was an "anti-strategy" that banked all money first, played properties last, and targeted the weakest players.

This produced bots that were functional but deeply flawed:

| Mode | Initial Win Rate | Problem |
|---|---|---|
| Aggressive | 55% | Dominated everything |
| Neutral | 40% | Only other viable strategy |
| Conservative | 3% | Never attacked, just hoarded |
| Random | 1% | Too passive |
| Chud | 0% | Self-sabotaging, 0 wins in 100 games |

The game was a two-horse race between Aggressive and Neutral. Conservative and Chud were useless.

## Building the Simulation Pipeline

We built a headless simulation system (`simulate.js`) that runs bot-only games without the network layer:

**How it works:**
- Bypasses `scheduleBotAction()` — the server-side function uses `setTimeout` for realistic delays. Instead, we call `decideBotPlay()` directly in a synchronous loop
- Runs through the same `game.js` engine — decisions are executed through identical game rule enforcement
- Captures per-turn decision records — each bot decision is logged with game phase, action type, board state, and targeting information
- Tracks combos, play ordering, OPSEC usage, banking decisions, and set progression curves

The simulation script supports configurable game counts:

```bash
node simulate.js 500    # Run 500 games
```

**What we track per game:**

| Category | Metrics |
|---|---|
| Game phase splits | Early (turns 1-15), Mid (16-40), Late (41+) action distributions |
| Play sequencing | What's played 1st/2nd/3rd each turn, plays-per-turn distribution |
| Combos | Surge+Rent, PCS+followup, Steal-after-Rent sequences |
| Targeting | Who gets targeted, leader-targeting %, target-by-mode breakdown |
| OPSEC | Times held, times played, efficiency (% used on high-value threats) |
| Banking | Money vs action cards vs rent cards banked |
| Set progression | Average completed sets at turns 5, 10, 15, 20, 25, 30 |
| End state | Completed sets, bank value, property count, colors used |

## Baseline Analysis: 500 Games

The initial 500-game simulation revealed the core problems quantitatively:

**Win Rates:**
```
aggressive      275 wins (55.0%)  ██████████████████████
neutral         200 wins (40.0%)  ████████████████
conservative     15 wins ( 3.0%)  █
random            5 wins ( 1.0%)
chud              0 wins ( 0.0%)
```

**Per-Mode Averages (per game):**
```
Mode           Props  Bank  Rent  Draw  OPSEC  Sets
random           4.4   2.4   1.8  14.8    0.5   0.1
conservative     8.0  10.0   0.3  15.9    1.0   0.3
neutral          7.8   4.3   2.6  15.6    0.8   1.7
aggressive       7.0   3.1   4.5  14.6    0.5   2.0
chud             0.5   5.7   0.6  12.9    0.3   0.0
```

## Key Findings: What Felt Robotic

### 1. Conservative Never Attacked

Conservative banked 10 cards/game but charged only 0.3 rent. It played 0 CHUD cards, 1 Finance Office, 0 Roll Calls, and 1 Midnight Requisition across 100 games combined. The mode's strategy was "build sets and bank money" with no offensive element at all.

The root cause: conservative only used offensive actions when it had 2+ completed sets, but it averaged only 0.3 sets per game. The offensive threshold was effectively unreachable.

### 2. Chud Was Self-Destructive

Chud banked all money and rent first (5.7 bank plays/game), played only 0.5 properties, and built 0.01 completed sets on average. The "anti-strategy" was so extreme that Chud never won a single game.

The root cause: Chud's priority list started with "bank money" and "bank rent," wasting all 3 plays per turn on banking. Properties came last, and by then there were no plays remaining.

### 3. All Modes Played 3 Cards Every Turn

Every mode except Chud used all 3 plays 94-96% of turns. Real humans don't always use all their plays — sometimes you hold action cards for later, or you only have OPSEC and properties that don't help right now.

### 4. Predictable First Plays

Conservative and Neutral always played a property card first (66-67% of turns). This made their opening completely predictable.

### 5. OPSEC Wasted on Small Threats

Conservative played OPSEC on everything (100 plays), including 2M Roll Calls. Random played OPSEC randomly (24% efficiency — 76% wasted on small threats). Only Aggressive and Neutral used OPSEC selectively.

### 6. No Threat Detection

No mode checked whether an opponent was close to winning. If someone had 2 completed sets (1 away from victory), no bot adjusted its strategy to stop them.

### 7. No Combo Awareness

Surge+Rent was played as a combo only ~0.05 times per game. Bots played Surge Operations and then ended their turn or played a property, wasting the double-rent effect.

## Tuning Iterations

### Round 1: Fix Conservative and Chud

**Conservative overhaul:**
- Moved offensive actions earlier in priority — now attacks when any opponent has 2+ completed sets (threat detection)
- Added rent charging on any set with rent >= 2 (not just complete sets)
- Added Roll Call usage when 2+ opponents exist
- Added Finance Office targeting richest player
- Stopped banking action cards — holds them for later use

**Chud overhaul:**
- Reorganized priority: offensive actions first (CHUD card, Inspector General, steals), then rent, then properties, then banking
- Now actually charges rent and plays properties
- Reduced early-end chance from 40% to 20%
- Changed from "always target poorest" to random targeting (more chaotic)

**Results after Round 1:**
```
neutral         35 wins (35.0%)  ██████████████
conservative    31 wins (31.0%)  ████████████
aggressive      27 wins (27.0%)  ███████████
chud             5 wins ( 5.0%)  ██
random           2 wins ( 2.0%)  █
```

Conservative jumped from 3% to 31%. Chud went from 0% to 5%.

### Round 2: OPSEC Economy

**Conservative OPSEC:** Changed from "always play" to threat-based:
- Always block Inspector General, CHUD, high-rent (>= 4)
- Only block Midnight Requisition if targeting a set we're building, or we have spare OPSEC
- Skip Roll Call and low-rent unless we have 2+ OPSEC cards

**Random OPSEC:** Added basic survival instinct:
- Always block Inspector General
- 70% chance to block CHUD
- Only 20% chance to block Roll Call or low rent

**Neutral OPSEC:** Added Midnight Requisition blocking (70% chance).

**Results:** OPSEC efficiency improved from 24% to 41% for Random, from N/A to 87% for Conservative.

### Round 3: Smart Property Placement

Replaced simple "play first property in hand" with `findBestPropertyPlay()`:
- Scores each property by: progress toward set completion + smaller set bonus + "already building this color" bonus
- Wild cards score with a flexibility bonus
- Prefers colors we already have cards in (builds toward completion instead of scattering)

**Impact:** Average colors used dropped from 4.5 to 4.2 for Neutral (more focused building), and set completion curves improved across all modes.

### Round 4: Play Count Variability

Added holdback mechanics to avoid the "always plays 3" robot pattern:

| Mode | After 1 play | After 2 plays | Condition |
|---|---|---|---|
| Conservative | 8% stop | 25% stop | Only if hand <= 7 cards |
| Neutral | 5% stop | 15% stop | Only if hand <= 7 cards |
| Random | 12% stop | 25% stop | Only if hand <= 7 cards |
| Aggressive | 0% stop | 8% stop | Only if hand <= 7 cards |

Additionally: Conservative and Neutral never play their last OPSEC card if it's all they have left.

**Results:** 3-play turn rate dropped from 96% to 64% for Conservative, 95% to 76% for Neutral.

### Round 5: Threat-First Decision Making

Moved threat detection to the top of the decision chain for Conservative and Neutral. If any opponent has 2+ completed sets:
1. Inspector General — seize a set from the biggest threat
2. CHUD — steal from threat's best property
3. Midnight Requisition — steal from threat's incomplete sets
4. Finance Office — drain threat's bank
5. Fall back to normal play

### Round 6: Varied Opening Play

Fixed the "always lead with property" predictability:

**Conservative:**
- 24% chance to lead with PCS Orders (was 14%)
- 5% chance to lead with rent
- Rest: property first

**Neutral:**
- 35% chance: lead with rent if decent (>= 2)
- 15% chance: lead with PCS Orders
- 50% chance: property first

**Aggressive:**
- If 0 properties on board, build first (need sets to win)
- Otherwise: lead with Surge/Rent combo or attacks as before

## Early, Mid & Late Game Analysis

### Early Game (Turns 1-15)

| Action | Random | Conservative | Neutral | Aggressive | Chud |
|---|---|---|---|---|---|
| property | 56% | 55% | 54% | 50% | 48% |
| pcs_orders | 8% | 15% | 13% | 9% | 7% |
| rent | 4% | 6% | 9% | 12% | 14% |
| bank | 17% | 15% | 9% | 8% | 5% |

All modes focus on property placement in the early game (48-56%). Conservative and Neutral prioritize PCS Orders for card advantage. Aggressive leads with rent more often. Chud harasses immediately (14% rent, 5% steals).

### Mid Game (Turns 16-40)

| Action | Random | Conservative | Neutral | Aggressive | Chud |
|---|---|---|---|---|---|
| property | 43% | 33% | 30% | 32% | 41% |
| rent | 8% | 12% | 14% | 13% | 15% |
| bank | 19% | 19% | 17% | 22% | 10% |
| offensive* | 11% | 16% | 15% | 11% | 12% |

*Offensive = chud + finance_office + inspector_general + midnight_requisition + tdy_orders*

Mid game shifts toward income generation (rent) and offensive actions. Conservative becomes more aggressive as threats emerge. Property placement drops as players have fewer unplayed properties.

### Late Game (Turns 41+)

Small sample size (44-52 actions total) but shows interesting patterns:
- Conservative shifts to PCS Orders (23%) to find missing pieces
- Neutral focuses on rent (13%) and offensive cards
- Aggressive goes heavily offensive (17% CHUD, 8% IG)
- Chud goes for Midnight Requisition (29%) — last-ditch property theft

## Combo Detection & Sequencing

We tracked three specific card combos:

| Combo | How it works | Neutral | Aggressive |
|---|---|---|---|
| Surge + Rent | Play Surge Operations, then charge rent (doubled) | 0.14/game | 0.12/game |
| PCS + Followup | Draw 2 cards, then immediately play one | 0.37/game | 0.34/game |
| Steal after Rent | Charge rent to drain bank, then steal property | 0.07/game | 0.09/game |

Combo rates improved significantly after reordering decision priorities. Surge+Rent went from 0.05 to 0.14 for Neutral after moving the Surge check before property plays.

## OPSEC Economy

OPSEC (counter cards) are a limited resource — the deck has only 3 copies. Using them wisely is critical.

| Mode | Times Held | Times Played | On Big Threats | Efficiency |
|---|---|---|---|---|
| Random | 299 | 201 | 83 | 41% |
| Conservative | 541 | 178 | 155 | 87% |
| Neutral | 358 | 196 | 167 | 85% |
| Aggressive | 448 | 91 | 79 | 87% |
| Chud | 111 | 187 | 27 | 14% |

**Conservative holds OPSEC the most** (541 turns with OPSEC in hand) but uses it selectively. **Aggressive holds OPSEC but rarely plays it** (91 times) — saves it for Inspector General and CHUD only. **Chud wastes OPSEC** on small threats (14% efficiency) — intentionally chaotic.

"Big threats" are defined as: Inspector General, CHUD, Finance Office, or rent >= 4M.

## Targeting Patterns

We tracked who each mode targets with offensive actions:

| Attacker → Target | Conservative | Neutral | Aggressive | Chud |
|---|---|---|---|---|
| → random | 21% | 20% | 24% | 13% |
| → conservative | — | 38% | 30% | 20% |
| → neutral | 31% | — | 35% | 29% |
| → aggressive | 34% | 24% | — | 37% |
| → chud | 14% | 18% | 11% | — |
| **Targets leader** | **81%** | **79%** | **77%** | **72%** |

All modes preferentially target the leader (77-81%). Chud is less leader-focused (72%) due to random targeting. Notably, Chud is targeted least often (11-18%) by most modes because it's rarely the leader.

## Final Bot Behavior Summary

### Random
- Shuffles hand and plays in random order
- 60% chance to try properties first, otherwise random
- 15% chance to end turn early (reduced from 30%)
- OPSEC: blocks IG always, CHUD 70%, small stuff 20%
- Designed to be unpredictable but weak

### Conservative
- **Build first, attack when threatened**
- Prioritizes: threat response → surge+rent combo → rent on complete sets → PCS → properties → upgrades → decent rent → banking
- Holds action cards for later (never banks them)
- 25% chance to stop after 2 plays (saves hand for defense)
- OPSEC: saves for big threats (87% efficiency)
- Goes offensive when any opponent has 2+ sets

### Neutral
- **Balanced play with threat awareness**
- Varies opening play: 35% rent-first, 15% PCS-first, 50% property-first
- Prioritizes: threat response → surge+rent → properties → PCS → rent → offense → upgrades → banking
- 15% chance to stop after 2 plays
- OPSEC: selective (85% efficiency)
- Combo-aware: plays Surge before Rent when both in hand

### Aggressive
- **Attack-first, build second**
- Leads with rent (any amount) and offensive actions
- Plays properties after attacks (still needs sets to win)
- 8% chance to stop after 2 plays (almost always uses all plays)
- OPSEC: only blocks IG and CHUD (87% efficiency)
- Targets leader's most valuable properties

### Chud
- **Chaotic gremlin**
- Leads with CHUD card and Inspector General
- Targets random players (not strategic)
- Charges rent on random colors
- Places wild properties on random or wrong colors (50/50)
- 20% chance to end turn early after first play
- OPSEC: blocks small stuff, lets big attacks through (14% efficiency — intentional)
- Banks OPSEC cards — doesn't care about defense

## Results: Before vs After

### Win Rate Balance

| Mode | Before | After (6 rounds) |
|---|---|---|
| Aggressive | 55% | **27%** |
| Neutral | 40% | **37%** |
| Conservative | 3% | **28%** |
| Random | 1% | **2%** |
| Chud | 0% | **5%** |

From a 55/40 two-horse race to a balanced 37/28/27 three-way competition.

### Play Variability

| Metric | Before | After |
|---|---|---|
| 3-play turns (conservative) | 96% | **64%** |
| 3-play turns (neutral) | 95% | **76%** |
| First play predictability (conservative) | 66% property | **46% property** |
| First play predictability (neutral) | 67% property | **57% property** |

### OPSEC Usage

| Mode | Before Efficiency | After Efficiency |
|---|---|---|
| Random | 24% | **41%** |
| Conservative | N/A (always played) | **87%** |
| Neutral | N/A | **85%** |
| Aggressive | N/A | **87%** |

### Combos

| Combo | Before (neutral) | After (neutral) |
|---|---|---|
| Surge + Rent | 0.05/game | **0.14/game** |
| PCS + Followup | N/A | **0.37/game** |

### Game Health

| Metric | Before | After |
|---|---|---|
| Average game length | 38 turns | **26 turns** |
| Stalemates | 1% | **0%** |
| Modes with >1% win rate | 2 | **5** |

### Set Completion Curve

| Turn | Conservative Before | Conservative After |
|---|---|---|
| 10 | 0.03 | **0.10** |
| 15 | 0.06 | **0.25** |
| 20 | 0.08 | **0.40** |
| 25 | 0.10 | **0.59** |

## Methodology Notes

### Why Headless Simulation?

Running 500+ games through the actual WebSocket server would take hours due to artificial bot delays (600-2800ms per action). By calling `decideBotPlay()` directly in a synchronous loop, we can run 500 games in under 5 seconds.

### Simulation Limitations

Bot-vs-bot games feature 5 equally skilled opponents with different strategies. Real games feature 2-5 human players with varying skill levels. Our simulations validate that modes are differentiated and balanced against each other — real-world balance may differ since humans exploit different weaknesses.

### Iterative Process

The tuning was not a one-shot process. Each round of changes was validated through 500-game simulations, and results revealed secondary effects (e.g., fixing Conservative's banking caused it to hold too many action cards, requiring the holdback mechanic). The final parameters represent 6 rounds of tuning with simulation verification after each.

## P1 Card-Table Revamp — Rules Rebalance and Re-tune

The ARCHITECTURE §3 rebalance changed the rules under the bots (CHUD lost its 2M rider,
the wild rent became single-target, Surge Ops doubles any charge, colour zones are capped
at set size, insolvency now forces zero-value wilds out). Every personality was re-checked
against the §3 bounds: **no personality above 60% or below 8% in a 4-player mixed game.**

### New measurement harness

`simulate.js` grew a programmatic API next to the CLI:

```js
const { runMatches } = require('./simulate');
runMatches({ players:['chud','neutral','neutral','neutral'], games:500, seed:'x' });
// → { winrates, seatWinrates, firstPlayerWin, avgTurns, medianTurns, stalemates, ... }
```

`node simulate.js matrix <games> <seed>` prints the balance matrix. Every personality plays
**every seat of every 4-subset of the roster**, so seat order cannot masquerade as strength.
Runs are reproducible: the engine takes `{seed}` and the bot RNG is injected
(`Bot._internal.setRng`) rather than reading `Math.random` directly.

### 4-player mixed, 4000 games (3200 per personality)

| Personality | Before rebalance (5p, 500 games) | After (4p mixed, 4000 games) |
|---|---|---|
| Aggressive | 28.4% | **36.7%** |
| Neutral | 35.0% | **35.5%** |
| Conservative | 29.6% | **27.3%** |
| Chud | 5.8% ✗ | **13.2%** |
| Random | 1.2% ✗ | **12.4%** |

First-player advantage: **24.5%** against a 25.0% fair share — turn order is worth nothing
measurable. Average game 27.7 turns, 0 stalemates in 4000 games, 4000/4000 decided.

Each personality against three neutrals (4000 games each): random 9.6%, chud 10.8%,
conservative 19.8%, aggressive 20.4%, neutral 23.1%.

### What moved random and chud off the floor

Both were below the 8% floor *before* the rebalance too (1.2% and 5.8%), so this was a bot
fix, not a rules fix. Three changes, each measured:

| Change | Effect |
|---|---|
| Random's per-decision "do nothing" chance 15% → 5% → 2% | 2.5% → 8.6% → 12.4% |
| Random/chud pay from the **bank before properties** (still random order within each) | random 4.5% → 6.6%, chud +3 points |
| Random's wild colours pull 70% toward a colour it has already started | random 2.5% → 4.5% |
| Chud plays a property first on a 45% coin-flip instead of always harassing first | chud 6.0% → 12.3% |

Random still shuffles its hand, still targets at random, still discards blind — it is
unpredictable rather than absent. Chud still leads with theft, banks OPSEC and discards
chaotically; it just stopped refusing to build.

### Rules the bots had to learn

- **Wild rent needs a victim.** `makeRentPlay()` attaches a `targetId` for `Rent: any`;
  smart modes pick the leader (ties broken on who can actually pay), random/chud roll.
- **Zone cap.** `openColorsForWild()` and `randomPropertyPlay()` refuse a colour that
  already holds a full set, so no personality wastes a play on an illegal placement
  (soak: 45,396 decisions across 300 games, 0 rejected plays).
- **Surge Ops doubles any charge.** All three planning modes now play Surge when a rent,
  Finance Office *or* Roll Call can follow it (`hasChargeFollowUp()`).
- **No CHUD rider.** The follow-up payment branch is gone from the response logic.

## Final Approach (owner directive, ARCHITECTURE §3.10)

Reaching three sets no longer wins — it *arms*. The armed player wins only if they still hold
three sets when their own next turn begins, so every opponent gets one turn to shoot them down.
Bots had to learn both halves of that.

### Breaking someone else's approach

`tryBreakFinalApproach()` runs **before** every personality's own plan and before the
human-like holdback (there may not be another turn to spend the card on). It walks the
options in order of how reliably they cost the victim a set:

1. **Inspector General** — takes the whole set, and it lands on our board.
2. **THE CHUD CARD** — the only single-property steal that reaches into a complete set.
3. **TDY Orders** — a swap is not a steal, so the complete-set guard does not apply to it.
4. **Midnight Requisition** — only useful against an *overflowed* zone (length ≠ set size).
5. **Charge them past their bank** — Finance Office or a rent aimed at the armed player when
   their bank cannot cover it, so the payment has to come out of a set. Surge Ops first when
   doubling would push the charge past their cash.

Rent targeting (`chooseRentTarget`) now prefers an armed opponent over the leader, and chud's
CHUD/Inspector General targeting became threat-aware — spraying those cards at whoever left
chud with nothing to answer a late approach with (53.8% of approaches converted against an
all-chud field; 48.1% after the fix).

**Shot-taken rate** — an opponent is armed, a breaking card is in hand, does the bot fire at
them on the first play of its turn? (200 games, all lineups)

| Personality | Takes the shot |
|---|---|
| chud | **98.7%** |
| aggressive | **94.4%** |
| neutral | 88.0% |
| conservative | 86.4% |
| random | **38.5%** |

That is the intended spread: chud and aggressive are the enforcers, random mostly does not
notice. `BREAK_URGENCY` gates the attempt per personality, but the roll turns out to matter
far less than card availability — softening it (1.0/0.9/0.85/0.2 → 0.9/0.75/0.7/0.15) moved
conversion by 0.2 points, so the original values stayed.

### Defending your own approach

An armed bot stops building (more sets cannot help it) and starts protecting:

- **Hoards cash** (`tryDefendFinalApproach`) so an incoming charge never has to be paid out of
  a completed set. Bias per personality: conservative 0.9 … chud 0.4, random 0.2.
- **Pays complete-set cards last**, regardless of personality — `selectPaymentCards` sorts them
  to the back of the queue whenever the payer is armed.
- **OPSECs anything that could cost a set**: any property attack, or a payment demand larger
  than its bank. Random still flips a coin about it.

Measured effect: across 250 mixed games, **every** broken approach was broken by an opponent —
zero self-inflicted breaks. The defensive rules work.

### The checkpoint is a full turn cycle

The win checkpoint is the armed player's own turn start **with at least `active players`
turns elapsed since arming**, so every opponent is guaranteed a response turn no matter when
the arming happened. It matters because 5.2% of armings happen on somebody else's turn (a
payment or a swap completing your third set); those used to get a truncated grace period.
Conversion by arming position, 240 games: armed on your own turn **38.9%**, armed off-turn
**25.0%** — the strict rule costs an off-turn armer real equity, which is the point.

### Balance after the change (4000 games, seat-balanced)

| Personality | Before §3.10 | After §3.10 |
|---|---|---|
| random | 12.4% | **12.7%** |
| conservative | 27.3% | **25.8%** |
| neutral | 35.5% | **33.1%** |
| aggressive | 36.7% | **40.5%** |
| chud | 13.2% | **13.0%** |

§3 bounds still hold. First-player advantage 21.1% against a 25.0% fair share. Games got
longer, as expected: **27.7 → 41.3 average turns**, 2.61 armings per game, **56.8% of
approaches shot down / 43.2% converted** — the grace cycle is a real fight, not theater.
Conversion falls hard with table size (2p 86.2%, 3p 65.0%, 5p 31.4%): more opponents, more
guns pointed at you.

### The tail, and the attrition cap

The grace cycle has a cost: every break scatters a finished set, so 5-player games grew a long
tail. Measured over 300 five-player games:

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| before §3.10 | 27 | 44 | 63 | 73 |
| after §3.10 | 42 | 114 | 387 | 401 |

Not livelock — every game still ended — but a p99 of 387 turns is unplayable with live turn
timers. The separator is deck cycles: healthy games reshuffle 1.9 times (p90 5), tail games
22.8 (max 56). So the game now ends on points (most sets, net worth breaks the tie — the same
resolution §3.6 already used) once the deck has been cycled `DECK_CYCLE_LIMIT` times.

| Limit | max turns (5p) | 5p games decided on points |
|---|---|---|
| 8 | 99 | 17% |
| 12 | 129 | 11.7% |
| **16** | **152** | **7%** |

16 was chosen: it bounds the tail at ~30 turns per player and never fires at all in 2/3/4-player
games (0 of 450 sampled). Max turns across the 4000-game matrix: 167.

## Final Approach, round 2 — the §3.1 reversal had quietly gutted the counters

Owner report, 2026-08-07: *"when playing against bots, if someone is on final approach I want
to make sure that the bots will always do everything they can to try to stop them."*

The section above claims **56.8% of approaches shot down**. Re-measured at HEAD before
touching anything: **40.1%**. The regression was not in the bots — it was §3.1's reversal on
2026-08-06. TDY Orders was counter #3 in `tryBreakFinalApproach()`, and Hasbro FAQ 926 took it
away. The break list still *contained* the move; the engine just refused it. The numbers in
the previous section predate that reversal and were never re-measured.

That leaves exactly **four** cards in 106 that can pull a card out of a complete set — 2×
Inspector General, 2× THE CHUD CARD — against 3× OPSEC. Everything else has to come from
forcing a payment the victim cannot cover.

### Baseline: where the shots were actually going

Instrumented over 400 mixed games, on every decision taken while an opponent was armed:

| | before | after |
|---|---|---|
| hard breaker (IG/CHUD) in hand | 7.6% | **10.4%** |
| fired it | 7.5% | **10.4%** |
| fired a charge at the armed player | 10.5% | 6.8% |
| …of those, charges the victim could pay **without touching a set** | **51.9%** | 42.5% |
| banked a hard breaker while someone was armed | 2 | **0** |
| had nothing usable, but held PCS Orders | 12.6% | **5.9%** |

So the bots were *already* firing a counter 99.4% of the times they held one. The failure was
never nerve — it was that half the charges were theatre, the bot gave up instead of digging,
and it would occasionally bank the counter as cash.

### The shape of the change: a pre-emptive branch, not a weight

`tryBreakFinalApproach()` stays a branch that short-circuits ahead of every personality plan
and ahead of the holdback. A weight would be wrong: scoring compares plays by marginal value,
and a live final approach is not a bigger number, it is a **terminal condition** — every other
play on the board is worth zero if the armed player converts. Only a short-circuit expresses
that. What changed is what the branch knows.

**`disposableValue()` replaces "their bank".** What an armed player can hand over without
losing a set is bank + properties in zones that are *not* complete sets + upgrades (payable
per §3.1b; a House leaving a set costs rent, not the set — the same order `selectPaymentCards`
uses). A charge disarms only if it beats *that*. Charging less moves money, and during a grace
cycle there is no later turn in which that money mattered.

**Ranked by what actually disarms, verified against `game.js` rather than card text:**

| | why here |
|---|---|
| 1. Inspector General | takes the whole set, permanently, and it lands on *our* board — a two-set swing |
| 2. THE CHUD CARD | the only card that reaches into a complete set for a single property |
| 3. a charge sized above `disposableValue` | forces a set card out; Surge Ops first **only ahead of a rent** |
| 4. PCS Orders as a dig | holds no counter → a speculative draw beats any ordinary play, because there is no next turn |
| 5. Midnight Requisition | denial only — `zoneRequisitionable` bars it from complete sets, so it can never disarm |
| — | **TDY Orders: not a counter.** §3.1/FAQ 926 bars it from complete sets on *both* sides |

**Surge Ops was being burned on Finance Office.** §3.1c makes Surge rent-only, and
`finance_office` calls `chargeAmount()` with no `surgeable` flag — the multiplier is always 1.
The old break code spent a play surging it anyway, at the one moment in the game when plays
are worth the most. Surge now fires only when doubling a *rent* is what pushes it over
`disposableValue` and a play remains to fire the rent with.

**Roll Call joined the list.** 2M and it hits the table, but 2M is enough against a player who
has spent down to nothing. It was never considered before.

**Spend now, not later — in code, not in the report.** Two additions. The dig (a bot with no
counter plays PCS Orders rather than building, because the counter can only come from the
deck). And a veto in `decideBotPlay()`: while anyone is armed, no plan may bank an Inspector
General or CHUD as money. IG is the highest-value card in the deck at 5M, so *every*
personality's "bank the biggest thing" rule reached for it first — including
`tryDefendFinalApproach`, which is how an armed bot could bury the best counter in the game
under a pile of cash. Vetoing once at the chokepoint covers all five personalities instead of
patching the same mistake in five planners.

**Multiple armed opponents, and being armed yourself.** The victim is whoever converts
**first**, not whoever has the most sets, read off the engine's own `checkpointForecast().turn`
so it cannot drift from `resolveFinalApproach()`. (Use `.turn`, not `.opponents`: two players
armed on the same tick have the same opponent count left but still convert in seat order.) An
armed bot filters the list to rivals whose checkpoint lands **before** its own — if we convert
first we have already won the race and spending the counter is pure loss, so it defends
instead. If theirs lands first, it fires regardless of being armed.

### Personalities survived — that was checked, not assumed

`BREAK_URGENCY` (fire a counter you hold) is unchanged. A second table, `BREAK_OVERPAY`
(aggressive .95, chud .85, neutral .75, conservative .55, random .15), gates only the
*speculative* spending — the PCS dig and the denial play. That is the axis the personalities
are allowed to differ on: how much you overpay for the attempt. None of them may ignore an
armed player.

Shot-taken rate — opponent armed, breaker in hand, first play of the turn (2,000 games):

| | before | after |
|---|---|---|
| conservative / neutral / aggressive / chud | 100% | **100%** |
| random | 36.8% | **35.7%** |

Random stays the easy seat. Everyone else was already perfect and stayed perfect; what rose is
how often they *have* a card — 543/443/303/360 chances after vs 529/351/266/298 before, bought
by the dig and by no longer banking the thing.

Seats filled after a disconnect (`server/handlers.js` picks
conservative/neutral/aggressive) all sit in the 100% group, and an unknown mode falls through
to neutral. Pinned in `test/bot-finalapproach.test.js`.

### OPSEC: measured, and already at its ceiling

Of 426 IG/CHUD shots blocked by an armed player, the attacker held a spare OPSEC in only
**17.4%** — and already fought back through the chain in **82.4%** of those. Total headroom
from a smarter chain response is ~0.3 points, so nothing was changed. The existing
`isChainResponse` handling is sufficient; the binding constraint is card availability, which
is a property of the deck, not of the bots.

### Balance after (10,000-game matrix, 500 per lineup, every seat × every 4-subset)

| Personality | before | after |
|---|---|---|
| random | 13.6% | **13.3%** |
| conservative | 27.2% | **26.1%** |
| neutral | 33.6% | **33.6%** |
| aggressive | 36.5% | **38.2%** |
| chud | 14.1% | **13.8%** |

§3 bounds hold (8–60%). First-player advantage 22.7% → **23.1%** against a 25.0% fair share.
**Approaches shot down 40.1% → 45.6%; converted 59.9% → 54.4%.** Average game **34.6 → 35.6
turns** (+2.9%), 10,000/10,000 decided.

Aggressive gained 1.7 points and conservative lost 1.1. That is the expected direction — the
change rewards holding and spending a counter at the right moment, which is aggressive's game
— and both stay comfortably inside the bounds.

### Conversion by table size, and the honest cost

1,500 games per table size:

| | 2p | 3p | 4p | 5p |
|---|---|---|---|---|
| converted before | 88.8% | 75.2% | 59.5% | 44.3% |
| converted **after** | 88.5% | 74.8% | **54.3%** | **36.9%** |
| p90 turns before → after | 30 → 30 | 37 → 38 | 49 → 51 | **74 → 93** |
| decided on points (§3.6) before → after | 0% | 0% | 0.0% → 0.2% | **2.8% → 8.3%** |

The change bites where there are more guns pointed at the armed player, which is the right
shape. **The cost is real and it lands at 5 players**: p90 grows 74 → 93 turns and 8.3% of
5-player games now end on the deck-cycle points rule instead of a declared Final Approach, up
from 2.8%. That is inside the envelope `DECK_CYCLE_LIMIT = 16` was chosen for (7% of 5p games
on points), and max turns did not move (146 → 149, and 1500/1500 still decided — this is the
bounded points ending, never a livelock), but it is a one-in-twelve chance that a five-handed
game ends on a technicality rather than a landing. Worth watching if 5-player becomes common.

An attrition fallback — "charge them anyway even though it cannot disarm" — was built, measured
and **removed**: across 1,500 games per table size it moved conversion 0.4–1.5 points (inside
run noise) while pushing 5p points-endings from 8.3% to 8.9%, and it overrode the holdback that
keeps bots from attacking on every single play. It bought nothing and cost variety.

### Verdict

Roughly a coin flip: **45.6% of final approaches are now shot down, 54.4% land.** At a 4-player
table the armed player is favoured but not safe, and at 5 players they are underdogs. Not
hollow — the table demonstrably fights, and it fires a counter 100% of the times it holds one.
Not futile — the majority of approaches still convert. The remaining ceiling is the deck: four
set-breaking cards in 106, against three OPSEC. Raising the break rate further would take a
rules change, not a bot change.

---

## Round 6 (2026-08-07) — the deck knob, the contested approach, and the table nobody measured

Round 5 closed with a hypothesis: *"The remaining ceiling is the deck: four set-breaking cards
in 106 against three OPSEC. Getting materially above ~46% would take a rules change."*

The deck is now a **rule** (game.js `DECK_BASE`, thirteen editable counts), so that hypothesis
became measurable rather than arguable. It is **confirmed as a mechanism and rejected as a
change**, and the reason is the cost the round-5 verdict had already flagged.

### The matrices

`simulate.js lineupsFor()` was generalised from the 4-player drop-one loop to **every k-subset
of the 5-personality roster × every rotation** — the k=4 case reproduces the old loop lineup
for lineup (asserted in `test/deckconfig.test.js`), and 3- and 5-player matrices exist for the
first time. 10,000 games per variant per seat count; ≥333 per matchup at every count.

**4 players** (the Quick Play default since this round):

| variant | size | shot down | avg turns | p90 | points% |
|---|---|---|---|---|---|
| **baseline** | 106 | **45.8%** | **35.7** | **53** | **0.29%** |
| +1 IG | 107 | 52.4% | 37.3 | 56 | 0.68% |
| +1 Chud | 107 | 52.5% | 38.4 | 59 | 0.78% |
| +1 each | 108 | 59.0% | 40.6 | 63 | 1.41% |
| +2 wilds (9→11) | 108 | 41.7% | 33.8 | 48 | 0.15% |
| +1 each, +1 OPSEC | 109 | 57.5% | 40.5 | 63 | 0.94% |
| +1 IG, −1 PCS (size-neutral) | 106 | 53.3% | 37.7 | 56 | 0.80% |
| mdFaithful deck | 106 | 24.8% | 30.4 | 42 | 0.00% |

**5 players**, where round 5 said the cost lives — and it does:

| variant | shot down | avg turns | p90 | points% |
|---|---|---|---|---|
| **baseline** | **62.6%** | **47.9** | **96** | **8.39%** |
| +1 IG | 69.5% | 53.9 | 112 | **13.12%** |
| +1 Chud | 68.6% | 55.3 | 115 | **14.35%** |
| +1 each | 74.0% | 61.8 | 125 | **19.12%** |
| +2 wilds | 59.9% | 44.2 | **81** | **5.93%** |
| mdFaithful deck | 41.5% | 35.1 | 52 | 0.76% |

### What the numbers say

1. **The hypothesis was right about the mechanism.** One more Inspector General really does
   move the shot-down rate (45.8% → 52.4% at four seats). The **size-neutral control**
   (+1 IG, −1 PCS Orders, still 106 cards) reaches 53.3%, so the effect is the *breaker*, not
   the bigger deck. The deck was genuinely the ceiling.

2. **And it is still not worth shipping.** Every breaker addition pushes 5-player
   points-endings from 8.4% to 13–19% and p90 past 110. The bar was "not materially past ~8%
   and ~100 turns". Every one of them fails it. **Baseline is fine; the bots just got better.**

3. **The surprise: restoring the two missing wilds goes the other way and is the only deck
   change that pays.** It *lowers* the shot-down rate (approaches convert more, because sets
   are easier to rebuild) but improves every cost at once: 5-player p90 96 → 81, points 8.39%
   → 5.93%, average turns 47.9 → 44.2. Wilds are a *tail* fix, not a breaker fix.

4. **CHUD is doing most of the set-breaking work.** The MD-faithful deck — the official
   Monopoly Deal deck exactly, which is our deck minus CHUD plus the two wilds — shoots down
   **24.8%** at four seats against our 45.8%. That is the honest price of fidelity, and it is
   why MD needs no grace cycle: it has instant win instead.

### §3.10b — the contested approach

A contested approach (two or more seats armed at the same turn start) is **not rare**:
**8.1% of 3-player games, 16.7% at 4 players, 26.1% at 5.** At the new default it is roughly
one game in six, so this is a real part of the game rather than a curiosity.

The owner's rule as stated does not terminate, so each mode carries its own bound. 10,000
games per mode:

| mode | 4p shot down | 4p p90 | 4p points% | 5p p90 | 5p points% |
|---|---|---|---|---|---|
| **off** (default) | 45.3% | 53 | 0.35% | 96 | 8.52% |
| oneLap | 50.9% | 55 | 0.75% | 104 | 12.02% |
| **escalate** | **55.1%** | 57 | 1.18% | 105 | 13.27% |
| points | 58.6% | 59 | **4.95%** | 107 | **15.68%** |

`escalate` buys **+9.8 points of shot-down at four seats — more than any deck change, at
lower cost.** `points` is rejected outright: it converts one 4-player game in twenty into a
technical ending, which is the failure mode the whole exercise exists to avoid.

### The combination that actually pays for itself

`escalate` lengthens games; restored wilds shorten them. Together (12,000 games, independent
confirming seed, `suddenDeath: 'escalate'` + `wildPairs: 9, wildAny: 4` = 110 cards):

| | 3p | 4p | 5p |
|---|---|---|---|
| shot down | 22.6 → **23.5%** | 45.4 → **46.8%** | 62.5 → **64.1%** |
| avg turns | 28.2 → **25.8** | 35.6 → **32.3** | 47.7 → **41.3** |
| p90 turns | 38 → **36** | 53 → **47** | 95 → **76** |
| max turns | 78 → **61** | 145 → **131** | 147 → **142** |
| decided on points | 0.00% | 0.31 → 0.50% | 8.08 → **6.16%** |
| contested approaches | 8.3 → 14.4% | 16.1 → 21.1% | 26.0 → 29.5% |

**Better or equal on every axis at every seat count**, §3 personality bounds green throughout
(8–60% at 3, 4 and 5 players). It directly repairs the 5-player cost round 5 shipped —
p90 96 → 76 and points 8.4% → 6.2% — while adding the drama the owner asked for.

Sensitivity on the rainbow wilds, which are the part that pays (5 players):

| wilds | 5p p90 | 5p points% |
|---|---|---|
| 11 (MD exactly) | 99 | 10.21% |
| 12 | 86 | 7.47% |
| 13 | 75 | 6.10% |

Eleven wilds — the MD-faithful count — is **not** enough to pay for `escalate` at five seats.
Twelve is. So the combination that works is a deliberate departure from MD, not a return to it.

### Quick Play was measuring the wrong table

Quick Play seated **two** bots, so the configuration the owner actually played was 3-player —
the one configuration these matrices had never covered. Every number this document quotes
described a table nobody was sitting at.

| | 3p (old default) | 4p (new default) |
|---|---|---|
| seat-0 win rate | 31.9% | 21.5% |
| avg / median turns | 24.8 / 25 | 32.4 / 30 |
| **SD of turn count** | **6.5** | **13.0** |
| final approaches shot down | **19.5%** | **47.5%** |
| contested approaches | 8.0% | 19.7% |

Three players is not a shorter game, it is a **thinner** one: four of every five final
approaches simply convert, so the mechanic the whole win rule is built around barely
functions. And the turn count is nearly constant — which is exactly the owner's complaint
that *"every game is 20-25ish points."* **That number is the turn counter** (median 25, p10
17, p90 33), not net worth, which sits at a median of 9M. Four seats doubles the spread.

Bench chosen by measurement: `neutral + aggressive + conservative` gave the highest shot-down
rate (47.5%, against 43.9% seating `chud` and 42.4% seating `random`) and the most contested
approaches, and `random` measurably softens the table (seat 0 wins 26.8%).

### Verdict

**Ship nothing to the stock deck.** Round 5's hypothesis was correct about the mechanism and
wrong about the remedy: the breakers work, and every way of adding them costs more at five
seats than the shot-down rate is worth. A null result, and it is the real one.

**Ship the configurability**, which makes the question cheap to re-ask, and makes MD Faithful
genuinely faithful for the first time. **`escalate` + 12–13 wilds is the one variant measured
that improves every axis at every seat count** — it is offered rather than defaulted, because
defaulting a rule that changes the deck is a bigger decision than a balance round should make
alone, and because the case for it rests on the tail rather than on the shot-down rate.
