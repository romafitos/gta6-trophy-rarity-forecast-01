// GTA VI trophy rarity forecaster — saturation-ODE model (M7 parameters).
//
// Idea: an earn rate moves for two separate reasons, and they must be
// modelled separately. (1) Dilution: Exophase refreshes its tracked-player
// count P upward, so every rate falls even when nobody earns a trophy.
// (2) Earns: players actually gain trophies, so each trophy's count C
// climbs toward a moving ceiling A_cat * P. Counts therefore follow a
// saturating ODE, dC/dt = k * (A_cat * P - C), never an exponential.
// P jumps by a factor at each Exophase refresh; the jump factor decays
// between refreshes as onboarding saturates. Quantiles are the median
// rate with a logit spread that grows with horizon and refresh risk,
// asymmetric: the upper tail is tighter than the lower tail.
//
// Reads only the case file given on the command line environment,
// writes one forecast file per case, deterministic, stdlib only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

// ---- M7 parameters (fitted on practice proxies + synthetic final-like runs) ----
const INTERVAL_PRIOR_H = 4.5; // expected hours between Exophase refreshes, flat history
const MULT_PRIOR = 5.0; // expected first jump in tracked players, flat history
const G_DECAY = 0.5; // each later refresh jump is this times the previous one
const SIGMA_REFRESH_FLAT = 0.075; // logit spread from refresh timing, flat history
const SIGMA_REFRESH_DATA = 0.25; // same, when refreshes were observed
const SIGMA_CAT_FLAT = 0.075; // per-category logit spread floor, flat history only
const SIGMA_CAT_DATA = 0.15; // same, when refreshes were observed
// V2 change vs M7 (one measured iteration): the flat path's spread is halved.
// Reason: in the flat path the refresh is a near-certain binary event before
// the target (page stale 3.2h vs a ~4.5h interval, refresh due ~10 min before
// target), so conditional on it landing the outcome is near-deterministic —
// M7's 0.22-logit spread was ~20x its own 0.003pp median error. The
// data-driven path (the one the final case takes) is untouched, so the
// final-case forecast is identical to M7's.
const SIGMA_DRIFT = 0.25; // logit spread per sqrt(day) of horizon
const SIGMA_CAT = 0.15; // per-category logit spread floor
const ASYM_LO = 1.0; // spread multiplier below the median
const ASYM_HI = 0.7; // spread multiplier above the median
const K_FLAT_SCALE = 0.25; // flat-history launch-night rates are this fraction of table k
const STEP_H = 0.25; // simulation step, hours

interface TrophyDef {
  id: number;
  name: string;
  description: string;
  tier: string;
}
interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned?: number;
  rates: Array<number | null>;
}
interface Case {
  levels: number[];
  horizon_minutes: number;
  trophies: TrophyDef[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const logit = (pct: number): number => {
  const c = clamp(pct, 0.01, 99.99);
  return Math.log(c / (100 - c));
};
const logistic = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? 0 : n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// ---- Category taxonomy: week-one ceiling A_cat and launch-night rate k_flat ----
// Ceilings are week-one priors scaled from mature-game benchmarks (story
// trophies reach 40-60% of their mature rate by day 7; platinum ~0.1-0.2%
// mature). k_flat is the launch-night hourly rate toward the ceiling.
interface CatParam { a: number; k: number }
const CAT: Record<string, CatParam> = {
  platinum: { a: 0.003, k: 0.00005 },
  story_early: { a: 0.55, k: 0.0005 },
  story_mid: { a: 0.35, k: 0.0004 },
  story_final: { a: 0.12, k: 0.0002 },
  story_side: { a: 0.25, k: 0.0004 },
  completion: { a: 0.005, k: 0.00005 },
  grind: { a: 0.06, k: 0.00015 },
  skill: { a: 0.1, k: 0.0003 },
  collect: { a: 0.08, k: 0.0002 },
  misc: { a: 0.15, k: 0.0004 },
};
// The six named side missions, by their description text.
const SIDE_MISSIONS = new Set([
  'Complete Breakfast Run.',
  'Complete The Cartel Heist.',
  "Complete Child's Play.",
  'Complete Headliners.',
  'Complete VCIA Takedown.',
  'Complete Operation Savage Glory.',
]);

function classify(t: TrophyDef): string {
  const text = `${t.name} ${t.description}`;
  const low = text.toLowerCase();
  if (t.tier === 'platinum') return 'platinum';
  if (/100%\s*completion/i.test(text)) return 'completion';
  if (/chapter 1|chapter 2/i.test(text)) return 'story_early';
  if (/chapter 3|chapter 4/i.test(text)) return 'story_mid';
  if (/final mission/i.test(text)) return 'story_final';
  if (/gold medal|fishing challenge|combat focus/i.test(low)) return 'skill';
  if (/stunt|race|challenges?|launder/i.test(low)) return 'grind';
  if (/meditat|card|waink|vehicle|discover|explore|garage|register/i.test(low)) return 'collect';
  if (SIDE_MISSIONS.has(t.description.trim())) return 'story_side';
  if (/partner|without being detected|wanted level/i.test(low)) return 'skill';
  return 'misc';
}

// ---- Simulation ----
// State: tracked players P and per-trophy counts C. Step forward in small
// steps; at each scheduled refresh time P jumps by the scheduled factor.
function simulate(
  p0: number,
  c0: number[],
  k: number[],
  aCeil: number[],
  totalH: number,
  refreshTimes: number[],
  refreshMults: number[],
): { p: number; c: number[] } {
  let p = p0;
  const c = [...c0];
  let t = 0;
  let ri = 0;
  while (t < totalH - 1e-9) {
    const nextEvent = ri < refreshTimes.length ? refreshTimes[ri] : Infinity;
    const dt = Math.min(STEP_H, totalH - t, nextEvent - t > 1e-9 ? nextEvent - t : STEP_H);
    const step = Math.max(dt, 0);
    if (step > 0) {
      for (let i = 0; i < c.length; i++) {
        const target = aCeil[i] * p;
        c[i] += k[i] * (target - c[i]) * step;
        if (c[i] < 0) c[i] = 0;
      }
      t += step;
    }
    if (ri < refreshTimes.length && t >= refreshTimes[ri] - 1e-9) {
      p *= refreshMults[ri];
      ri++;
    }
    if (step <= 0 && ri >= refreshTimes.length) break;
  }
  return { p, c };
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const n = c.trophies.length;
  const cats = c.trophies.map(classify);
  const aCeil = cats.map((cat) => CAT[cat].a);
  const kFlat = cats.map((cat) => CAT[cat].k * K_FLAT_SCALE);
  const hist = c.history;
  const last = hist[hist.length - 1];
  const first = hist[0];
  const horizonH = c.horizon_minutes / 60;
  const horizonDays = horizonH / 24;

  // Reconstruct counts per read: C = round(rate * P / 100).
  const counts = hist.map((r) =>
    r.rates.map((rate) => (rate === null ? 0 : Math.round((rate * r.players_tracked) / 100))),
  );
  const timeH = hist.map((r) => Date.parse(r.at) / 3600000);
  const slotH = hist.map((r) => Date.parse(r.slot) / 3600000);

  // A refresh is a read where the player count or any rate changed.
  const refreshIdx: number[] = [];
  for (let j = 1; j < hist.length; j++) {
    const changed =
      hist[j].players_tracked !== hist[j - 1].players_tracked ||
      hist[j].rates.some((rate, i) => rate !== hist[j - 1].rates[i]);
    if (changed) refreshIdx.push(j);
  }

  let endP: number;
  let endC: number[];
  let sigmaRefresh: number;
  let sigmaCat: number;

  if (refreshIdx.length >= 2) {
    // ---- Data-driven path: learn interval, jump factor and rates from refreshes.
    const gaps: number[] = [];
    const mults: number[] = [];
    for (const j of refreshIdx) {
      gaps.push(slotH[j] - slotH[j - 1]);
      mults.push(hist[j].players_tracked / hist[j - 1].players_tracked);
    }
    const interval = median(gaps);
    const g = median(mults.slice(-3));
    // Future refresh times after the checkpoint, every `interval` hours.
    const refreshTimes: number[] = [];
    const refreshMults: number[] = [];
    for (let m = 1; ; m++) {
      const rt = m * interval;
      if (rt > horizonH) break;
      refreshTimes.push(rt);
      refreshMults.push(g * Math.pow(G_DECAY, m - 1));
    }
    // Per-trophy rate k from the last <=3 refresh pairs, shrunk 60/40
    // toward the category median, clamped to a sane hourly band.
    const kRaw: number[] = [];
    for (let i = 0; i < n; i++) {
      const ests: number[] = [];
      for (const j of refreshIdx.slice(-3)) {
        const dt = Math.max(timeH[j] - timeH[j - 1], 0.25);
        const pMid = (hist[j].players_tracked + hist[j - 1].players_tracked) / 2;
        const cMid = (counts[j][i] + counts[j - 1][i]) / 2;
        const denom = aCeil[i] * pMid - cMid;
        if (denom > 1) ests.push((counts[j][i] - counts[j - 1][i]) / dt / denom);
      }
      kRaw.push(ests.length > 0 ? median(ests) : kFlat[i]);
    }
    const k: number[] = kRaw.map((ki, i) => {
      const peers = kRaw.filter((_, j) => cats[j] === cats[i]);
      const shrunk = 0.6 * ki + 0.4 * median(peers);
      return clamp(shrunk, 0.0005, 0.05);
    });
    const startC = counts[counts.length - 1];
    const res = simulate(last.players_tracked, startC, k, aCeil, horizonH, refreshTimes, refreshMults);
    endP = res.p;
    endC = res.c;
    sigmaRefresh = SIGMA_REFRESH_DATA;
    sigmaCat = SIGMA_CAT_DATA;
  } else {
    // ---- Flat-history path: replay the stale window from the first read.
    // The first refresh is expected INTERVAL_PRIOR_H after the first read;
    // later ones repeat on that interval with decaying jump factors.
    // Total span runs from the first read to the TARGET (checkpoint + horizon),
    // not merely to the last read: the last read predates the checkpoint.
    const checkpointH = Date.parse(c.at) / 3600000;
    const firstH = timeH[0];
    const staleH = checkpointH - firstH;
    const totalH = staleH + horizonH;
    const refreshTimes: number[] = [];
    const refreshMults: number[] = [];
    for (let m = 1; ; m++) {
      const rt = m * INTERVAL_PRIOR_H;
      if (rt > totalH) break;
      refreshTimes.push(rt);
      refreshMults.push(MULT_PRIOR * Math.pow(G_DECAY, m - 1));
    }
    const startC = counts[0];
    const res = simulate(first.players_tracked, startC, kFlat, aCeil, totalH, refreshTimes, refreshMults);
    endP = res.p;
    endC = res.c;
    sigmaRefresh = SIGMA_REFRESH_FLAT;
    sigmaCat = SIGMA_CAT_FLAT;
  }

  const sigma = Math.sqrt(
    sigmaRefresh * sigmaRefresh +
      Math.pow(SIGMA_DRIFT * Math.sqrt(horizonDays), 2) +
      sigmaCat * sigmaCat,
  );

  return c.trophies.map((t, i) => {
    const lastRate = last.rates[i];
    if (lastRate !== null && lastRate >= 99.99) {
      // A trophy everybody holds stays held: refreshes never dilute it.
      return { id: t.id, q: [100, 100, 100, 100, 100] };
    }
    const r = (100 * endC[i]) / endP;
    const l = logit(r);
    const q = Z.map((z) => {
      const s = z < 0 ? sigma * ASYM_LO : z > 0 ? sigma * ASYM_HI : sigma;
      return round4(clamp(logistic(l + z * s), 0, 100));
    });
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}`);
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
