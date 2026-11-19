# GTA VI Trophy Rarity Forecast — model M7

[![GTA 6 Trophy Rarity Forecast](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![Rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/romafitos/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![Reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/romafitos/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)

A forecast for every one of GTA VI's 55 PlayStation 5 trophies: the earn
rate each will show on Exophase at 2026-11-26T00:00:00Z, as five quantiles
(5 / 25 / 50 / 75 / 95%). Built for the
[make.fun bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
($250 USDC, Top-20 paid).

## Why rates move — and what the program models

A trophy's earn rate moves for two separate reasons, and the program keeps
them apart:

1. **Dilution.** Exophase refreshes its tracked-player count in jumps
   (on launch night: 638 → 3,868 players). When the player count jumps,
   every rate falls even if nobody earned anything new.
2. **Fresh earns.** Players keep earning trophies, so each trophy's
   *count* climbs toward a moving ceiling that grows with the player
   base — a saturation curve per trophy category, never an exponential
   extrapolation.

The program simulates both forward in counts, not in rates: state is
`(P, C_i)`, the player count and each trophy's earner count, stepped
forward to the target with `dC_i/dt = k_i · (A_cat · P(t) − C_i)`.

## How it works

- **History.** Every read in the case is checked for a refresh (player
  count or any rate changed). With 2+ refreshes, the program learns
  from them: the refresh interval is the median observed gap, the
  player-count multiplier is the median of the last three jumps (its
  excess over 1 halving at each future refresh, so growth saturates
  instead of exploding), and each trophy's `k_i` comes from its latest
  refresh pairs, shrunk 60/40 toward its category median and clamped
  to [0.0005, 0.05]/hour. Only the most recent slopes are used — launch
  slopes are never extrapolated.
- **Flat history** (like the practice cases, where every read is
  identical): the stale window is replayed from the first read, the
  first refresh is expected 4.5 hours after it, the player count jumps
  ×5.0, and `k` uses small launch-night priors scaled ×0.25.
- **Categories.** Each trophy sits in one of ten categories
  (platinum, story chapters, side missions, completion, grind, skill,
  collect, misc) with its own week-1 ceiling `A_cat` and launch-night
  rate `k_flat`, taken from mature-game benchmarks (GTA V, RDR2,
  Elden Ring, God of War, Spider-Man) scaled to week one.
- **Quantiles.** The median is the simulated rate at the target. The
  spread is `σ = √(σ_refresh² + (0.25·√H_days)² + 0.15²)`, applied on
  the logit scale and asymmetric — full width below the median, 0.7×
  above it, because dilution makes the lower tail longer than the
  upper one. A trophy already at 100% is pinned near 100% with a
  symmetric spread, since its rate does not fall at a refresh.

## Measured results (practice proxies)

| proxy | loss |
|---|---|
| A (P=3,868, new cohort earns 4% of old rate) | 0.0408 |
| B (pure dilution) | 0.0977 |
| C (cohort earns 10%) | 0.1193 |
| D (P=3,200) | 0.0774 |
| E (P=4,500) | 0.0644 |
| **Robust mean A–E** | **0.0799** |

House starter on the same proxies: ≈1.51. Two runs on the same case are
byte-identical; runtime is ~0.1 s per case (limit 8 s). The final case
(f00) carries a much richer history — reads every 10 minutes and many
refreshes — so there the data-driven branch above does the work, and
the flat-history priors are only a fallback for a case with no refresh
to learn from.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out`
(`{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}, …]}`) to
the output directory. Node 22, standard library only, no network,
fully deterministic.

## License

MIT — see [LICENSE](LICENSE).
