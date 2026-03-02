# Bot Strategy: How We Built the AI

This document covers the research, simulation pipeline, data analysis, and iterative tuning process behind the AI opponents in Chudopoly GO. The goal was to create bots that play strategically and feel human — not by guessing at good play, but by running hundreds of simulated games and analyzing what actually wins.

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
