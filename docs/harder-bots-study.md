# Harder bots: getting the solo human from 46% into the 30–40% band

Owner goal (2026-08-20): solo quick-play human win rate in the **30–40%** band, down
from the measured **46.2%** (48/104 production solo games vs the quick-play bench).
Two levers priced, measurement-first, nothing shipped without approval.

## Anchor and calibration

The anchor is production truth: 46.2% over 104 solo games — itself uncertain (Wilson
95%: **36.9–55.6%**), which bounds how precisely ANY projection can land. Candidate
benches are measured with `tools/benchstudy.mjs`: one `humanlike` proxy vs the
candidate 3-bot bench, seat-rotated, 6,000 games each, paired deck order across
benches, quick play's real ruleset. The proxy is a behaviour clone, not a strength
clone, so only the RATIO transfers: projected = 46.2% × (proxy rate vs candidate) /
(proxy rate vs current). Assumption stated in the tool header; it holds best for
composition changes among the same personalities, which is what these are.

## Lever 1 — bench composition (the big lever)

Proxy vs current bench [neutral, aggressive, conservative]: **22.9% [21.9, 24.0]**.
Target proxy band for 30–40% real: 14.9–19.8%.

| bench | proxy rate | multiplier | projected human | in band? |
|---|---:|---:|---:|---|
| neutral, aggressive, conservative (current) | 22.9% [21.9, 24.0] | ×1.000 | 46.2% (anchor) | no |
| **aggressive, aggressive, conservative** | **19.7% [18.7, 20.8]** | **×0.862** | **39.8% [37.8–41.9]** | **yes (top edge)** |
| aggressive, aggressive, neutral | 20.3% [19.3, 21.4] | ×0.888 | 41.0% | no (just above) |
| aggressive, aggressive, aggressive | 19.1% [18.1, 20.1] | ×0.833 | 38.5% | yes, monotone |
| neutral@0, aggressive@0, conservative@0 | 21.1% [20.1, 22.2] | ×0.921 | 42.6% | no |
| aggressive, aggressive, conservative@0 | 19.4% [18.5, 20.5] | ×0.849 | 39.2% | yes |
| aggressive@0, aggressive@0, conservative@0 | 19.7% [18.7, 20.7] | ×0.860 | 39.7% | yes |

**Composition saturates at ~×0.83–0.86**: even three aggressives — the strongest seat
in every instrument — only projects ~38.5%. Nothing reachable by seating shipped
personalities lands in the band's lower half (30–35%). That is consistent with round
11's structural finding: the remaining human edge (50.4 sets/100 turns vs ~41) is not
reachable by recombining today's planners.

**Round 7's diversity argument, addressed on its own metrics.** The current bench was
chosen for three distinct opponents and the best final-approach dynamics (highest
shot-down, most contested). AAC keeps two personas (double attacker + builder) and
does not trade the drama away — measured on the same 6,000-game runs: shot-down
**50.7% vs 48.0%**, contested games **22.7% vs 22.2%**, avg turns 33.6 vs 33.0. What
it drops is neutral — the measured weakest human-facing seat (10.7% in round 12b's
paired production tables; ~15% corpus-wide).

## Lever 2 — policy parameters (the small lever)

Everything tunable without touching live bot code, priced at real production decision
points (replayeval, whole-trajectory `--at all`, rollouts 12, cluster bootstrap by
game), plus the earlier wrapper results for completeness:

| candidate | vs | delta | 95% CI | verdict vs +3.0pp bar |
|---|---|---:|---|---|
| neutral@0 (holdback off) | neutral | +0.96pp | [+0.53, +1.37] | real, far under bar |
| conservative@0 | conservative | +1.60pp | [+1.08, +2.17] | real, under bar |
| aggressive@0 | aggressive | +0.81pp | [+0.17, +1.47] | real, far under bar |
| rentlev:neutral (round 12 note) | neutral | +0.73pp | [+0.57, +0.88] | real, far under bar |
| rentlev:aggressive | aggressive | +0.33pp | [+0.20, +0.48] | real, far under bar |
| sandbag@0.52:neutral (§3.10j) | neutral | +0.05pp | [0.00, +0.10] | null |
| cashfloor:neutral (round 12b) | neutral | −6.67pp | [−7.97, −5.48] | harmful |

Every surviving parameter is worth ≈+1pp per seat; the bench-level check agrees
(holdback-0 across all three seats moved the proxy only 22.9% → 21.1%, ≈ −3.6pp
projected human — and adds nothing on top of AAC). The seven-instruments-later
conclusion matches round 11's: **constant tuning cannot close the gap composition
leaves.** Reaching 30–35% would need new bot capability (the round-12 closing note's
"a charge that reaches a player through something other than a wild rent" is still the
most promising unbuilt direction; its cheap approximation priced +0.73pp).

## Recommendation

**Change the quick-play bench to [aggressive, aggressive, conservative].** Projected
solo human win rate **≈39.8%** (indicative 37.8–41.9 from proxy sampling alone;
realistically ±4–5pp once the anchor's own 104-game uncertainty is folded in). It is
the mildest change that reaches the requested band, it cannot plausibly overshoot
into the band's frustrating end, it keeps two personalities, and it improves the
final-approach drama metrics round 7 optimized the bench for. Zero bot-code risk; the
§3 bot-vs-bot grid is untouched by construction (no code change to any planner).

Not recommended: 3× aggressive (monotone, for 1.3pp more), holdback dials (real but
too small to matter and they erode the personalities' measured distinctness), any of
the shelved policy ideas (priced above; none clears the bar).

**Chain of evidence and its weakest links, named:** production anchor (46.2%, n=104,
±9pp) → proxy ratio transfer (assumption: relative response transfers; untestable
until post-ship data) → 6,000-game proxy rates (tight, ±1pp). The weakest link is the
transfer assumption, second-weakest the anchor's sample size. The honest claim is
"high-30s, direction certain, magnitude approximate" — and the check is free: ~2
weeks of post-ship production games re-measures the true rate with this same corpus
pipeline.

The prepared change (bench swap in server/handlers.js quick_play, comment updated
with these measurements) sits as the final commit on this branch, **awaiting owner
approval**.
