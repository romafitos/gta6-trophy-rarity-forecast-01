# GTA VI Trophy Rarity Forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/romafitos/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/romafitos/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Built for the [gta6-trophy-rarity-forecast-01 bounty on make.fun](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

Forecasts, for every GTA VI PlayStation 5 trophy, its earn rate on
Exophase at a case's target time, as five quantiles (5%, 25%, 50%, 75%,
95%).

## How it works

An earn rate moves for two separate reasons, modelled separately:

1. **Dilution.** Exophase refreshes its tracked-player count upward, so
   every rate falls even when nobody earns a trophy.
2. **Earns.** Players actually gain trophies, so each trophy's count
   climbs toward a moving ceiling.

Counts follow a saturating ODE, `dC/dt = k * (A_cat * P - C)`, where `P`
is the tracked-player count, `A_cat` a per-category week-one ceiling,
and `k` a per-trophy rate. `P` jumps by a factor at each Exophase
refresh; the jump factor decays between refreshes as onboarding
saturates.

- **Flat history** (no refresh observed yet): the stale window is
  replayed from the first read; the first refresh is expected 4.5 hours
  after the first read, with players ×5.0, and launch-night rates from
  the category table.
- **Rich history** (≥2 refreshes): the refresh interval, jump factor,
  and per-trophy rates are learned from the most recent refresh pairs,
  shrunk toward the category median and clamped.
- **Quantiles:** the median is the simulated rate at the target; the
  logit spread grows with horizon and refresh risk and is asymmetric
  (tighter above the median). A trophy held by ~100% of players is
  pinned at 100% — refreshes never dilute it.

## Run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network, deterministic.

## V2 (r3 variant)

Same model as M7, except the flat-history spread is halved
(`σ_refresh` 0.15 → 0.075, per-category floor 0.15 → 0.075). In the
flat path the refresh is a near-certain binary event before the target,
so conditional on it landing the outcome is near-deterministic. The
data-driven path — the one the final case takes — is unchanged.

## License

MIT — see LICENSE.
