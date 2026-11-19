// GTA VI trophy rarity forecast — model M7 (forward ODE in counts).
//
// Idea: a trophy's earn rate moves for two separate reasons — dilution
// (Exophase's tracked-player count P jumps at each refresh, so every rate
// falls even if nobody earns anything) and fresh earns (each trophy's
// count C climbs toward a moving ceiling A_cat * P). We simulate both
// forward from the case history to the target, then put honest logit
// quantiles around the simulated median rate.
//
// Node 22, standard library only, offline, deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// --- M7 parameters (from the experiment record) ---------------------------
const INTERVAL_PRIOR_H = 4.5; // expected hours from first read to first refresh
const MULT_PRIOR = 5.0; // expected player-count jump at that first refresh
const SIGMA_REFRESH_FLAT = 0.15;
const SIGMA_REFRESH_DATA = 0.25;
const SIGMA_DRIFT = 0.25; // per sqrt(day)
const SIGMA_CAT = 0.15;
const SIG_LO_SCALE = 1.0; // spread below the median
const SIG_HI_SCALE = 0.7; // spread above the median (short upper tail)
const K_FLAT_SCALE = 0.25;
const G_DECAY = 0.5; // refresh multiplier decays by this per refresh
const MEDIAN_SHIFT = 0;
const STEP_FLAT_H = 0.25;
const STEP_DATA_H = 1.0;
const K_MIN = 0.0005;
const K_MAX = 0.05;
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

// --- Category ceilings (week-1 plafonds) and flat launch-night rates ------
type Category =
  | 'platinum' | 'story_early' | 'story_mid' | 'story_final'
  | 'story_side' | 'completion' | 'grind' | 'skill' | 'collect' | 'misc';

const CEILING: Record<Category, number> = {
  platinum: 0.003, story_early: 0.55, story_mid: 0.35, story_final: 0.12,
  story_side: 0.25, completion: 0.005, grind: 0.06, skill: 0.10,
  collect: 0.08, misc: 0.15,
};

const K_FLAT: Record<Category, number> = {
  platinum: 0.00005, story_early: 0.0005, story_mid: 0.0004,
  story_final: 0.0002, story_side: 0.0004, completion: 0.00005,
  grind: 0.00015, skill: 0.0003, collect: 0.0002, misc: 0.0004,
};

// Trophy id -> category, from the taxonomy in the model report.
const BY_ID: Record<number, Category> = {
  1: 'platinum',
  3: 'story_early', 4: 'story_early',
  5: 'story_mid', 6: 'story_mid',
  7: 'story_final', 22: 'story_final', 23: 'story_final',
  24: 'story_final', 26: 'story_final', 27: 'story_final',
  8: 'story_side', 9: 'story_side', 10: 'story_side', 11: 'story_side',
  12: 'story_side', 13: 'story_side',
  14: 'completion',
  15: 'grind', 18: 'grind', 19: 'grind', 32: 'grind', 40: 'grind',
  43: 'grind', 52: 'grind', 53: 'grind',
  17: 'skill', 20: 'skill', 33: 'skill', 34: 'skill', 36: 'skill',
  39: 'skill',
  28: 'collect', 30: 'collect', 31: 'collect', 35: 'collect',
  42: 'collect', 54: 'collect', 55: 'collect',
  2: 'misc', 16: 'misc', 21: 'misc', 25: 'misc', 29: 'misc', 37: 'misc',
  38: 'misc', 41: 'misc', 44: 'misc', 45: 'misc', 46: 'misc', 47: 'misc',
  48: 'misc', 49: 'misc', 50: 'misc', 51: 'misc',
};

// --- Small numeric helpers -------------------------------------------------
const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const logisticPct = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function categoryOf(t: Trophy): Category {
  if (t.tier === 'platinum') return 'platinum';
  const known = BY_ID[t.id];
  if (known !== undefined) return known;
  // Fallback for an id outside the table: keyword rules over name+desc.
  const text = `${t.name} ${t.description}`.toLowerCase();
  if (/chapter 1|chapter 2/.test(text)) return 'story_early';
  if (/chapter 3|chapter 4/.test(text)) return 'story_mid';
  if (/final mission/.test(text)) return 'story_final';
  if (/complete .*mission|complete .*heist|complete .*run/.test(text)) return 'story_side';
  if (/100% completion/.test(text)) return 'completion';
  if (/stunt|race|challenge|launder|spend \$|rob \d/.test(text)) return 'grind';
  if (/gold medal|fishing challenge|combat focus|without being detected/.test(text)) return 'skill';
  if (/meditat|collectible|vehicle|properties|explore all/.test(text)) return 'collect';
  return 'misc';
}

// --- Case shape -------------------------------------------------------------
interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
}
interface Read {
  at: string;
  players_tracked: number;
  trophies_earned?: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  trophies: Trophy[];
  history: Read[];
}

// A read counts as a refresh when the player count or any rate moved.
function refreshIndices(history: Read[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const cur = history[i];
    if (cur.players_tracked !== prev.players_tracked) { out.push(i); continue; }
    let moved = false;
    for (let j = 0; j < cur.rates.length; j++) {
      if (cur.rates[j] !== prev.rates[j]) { moved = true; break; }
    }
    if (moved) out.push(i);
  }
  return out;
}

// One Euler step of the count ODE for every trophy.
function stepCounts(
  counts: number[], players: number, ks: number[],
  cats: Category[], dtH: number,
): void {
  for (let i = 0; i < counts.length; i++) {
    const ceiling = CEILING[cats[i]] * players;
    counts[i] += ks[i] * (ceiling - counts[i]) * dtH;
    if (counts[i] < 0) counts[i] = 0;
  }
}

// Simulate forward. `refreshAt` lists (offset hours from start, multiplier)
// for each refresh inside the window; between refreshes P is constant.
function simulate(
  counts: number[], players: number, ks: number[], cats: Category[],
  totalH: number, stepH: number,
  refreshAt: Array<{ atH: number; mult: number }>,
): { counts: number[]; players: number } {
  const c = [...counts];
  let p = players;
  let t = 0;
  let next = 0;
  const ordered = [...refreshAt].sort((a, b) => a.atH - b.atH);
  while (t < totalH - 1e-9) {
    const dt = Math.min(stepH, totalH - t);
    // Apply any refresh whose time falls inside this step first.
    while (next < ordered.length && ordered[next].atH <= t + 1e-9) {
      p *= ordered[next].mult;
      next++;
    }
    stepCounts(c, p, ks, cats, dt);
    t += dt;
  }
  // A refresh exactly at the end still dilutes the target rate.
  while (next < ordered.length && ordered[next].atH <= totalH + 1e-9) {
    p *= ordered[next].mult;
    next++;
  }
  return { counts: c, players: p };
}

// Estimate per-trophy k from the latest refresh pairs, shrunk toward the
// category median and clamped. Returns null when there is no usable pair.
function estimateKs(
  c: Case, cats: Category[], refreshIdx: number[],
): number[] | null {
  const n = c.trophies.length;
  const raw: Array<number | null> = new Array(n).fill(null);
  // Consecutive refresh reads form the pairs; keep the latest three.
  const pairs: Array<[number, number]> = [];
  for (let j = 1; j < refreshIdx.length; j++) pairs.push([refreshIdx[j - 1], refreshIdx[j]]);
  const latest = pairs.slice(-3);
  if (latest.length === 0) return null;
  for (let i = 0; i < n; i++) {
    const estimates: number[] = [];
    for (const [a, b] of latest) {
      const ra = c.history[a];
      const rb = c.history[b];
      const rateA = ra.rates[i];
      const rateB = rb.rates[i];
      if (rateA === null || rateB === null) continue;
      const dtH = (Date.parse(rb.at) - Date.parse(ra.at)) / 3600000;
      if (dtH <= 0) continue;
      const cA = (rateA * ra.players_tracked) / 100;
      const cB = (rateB * rb.players_tracked) / 100;
      const pMid = (ra.players_tracked + rb.players_tracked) / 2;
      const cMid = (cA + cB) / 2;
      const denom = CEILING[cats[i]] * pMid - cMid;
      if (denom <= 0) continue;
      estimates.push(((cB - cA) / dtH) / denom);
    }
    if (estimates.length > 0) raw[i] = median(estimates);
  }
  if (raw.every((v) => v === null)) return null;
  // Category medians for the 60/40 shrink.
  const catMedian = new Map<Category, number>();
  const allKnown = raw.filter((v): v is number => v !== null);
  for (const cat of Object.keys(CEILING) as Category[]) {
    const vals = raw.filter((v, i) => v !== null && cats[i] === cat) as number[];
    if (vals.length > 0) catMedian.set(cat, median(vals));
  }
  const globalMedian = median(allKnown);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const centre = catMedian.get(cats[i]) ?? globalMedian;
    const base = raw[i] ?? centre;
    const shrunk = 0.6 * base + 0.4 * centre;
    out.push(Math.min(K_MAX, Math.max(K_MIN, shrunk)));
  }
  return out;
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const n = c.trophies.length;
  const cats = c.trophies.map(categoryOf);
  const horizonH = c.horizon_minutes / 60;
  const horizonDays = c.horizon_minutes / 1440;
  const first = c.history[0];
  const last = c.history[c.history.length - 1];
  const refreshIdx = refreshIndices(c.history);
  const pinned = last.rates.map((r) => r !== null && r >= 99.99);

  let counts: number[];
  let players: number;
  let sigmaRefresh: number;
  let ks: number[];

  if (refreshIdx.length >= 2) {
    // Data-driven branch: learn from the latest refreshes, simulate from
    // the checkpoint in 1-hour steps.
    const estimated = estimateKs(c, cats, refreshIdx);
    ks = estimated ?? cats.map((cat) => K_FLAT[cat] * K_FLAT_SCALE);
    counts = last.rates.map((r, i) =>
      Math.round(((r ?? 0) * last.players_tracked) / 100));
    players = last.players_tracked;
    const gaps: number[] = [];
    const mults: number[] = [];
    for (let j = 1; j < refreshIdx.length; j++) {
      gaps.push(
        (Date.parse(c.history[refreshIdx[j]].at) -
          Date.parse(c.history[refreshIdx[j - 1]].at)) / 3600000,
      );
    }
    for (const idx of refreshIdx) {
      const prev = c.history[idx - 1];
      if (prev.players_tracked > 0) {
        mults.push(c.history[idx].players_tracked / prev.players_tracked);
      }
    }
    const intervalH = median(gaps);
    const g = median(mults.slice(-3));
    const refreshAt: Array<{ atH: number; mult: number }> = [];
    let when = intervalH;
    // The refresh multiplier decays toward 1 (no growth), never below it:
    // each refresh adds 1 + excess, with the excess halving per refresh,
    // so the tracked-player count saturates instead of collapsing.
    let excess = g - 1;
    while (when <= horizonH + 1e-9) {
      refreshAt.push({ atH: when, mult: 1 + excess });
      when += intervalH;
      excess *= G_DECAY;
    }
    const sim = simulate(counts, players, ks, cats, horizonH, STEP_DATA_H, refreshAt);
    counts = sim.counts;
    players = sim.players;
    sigmaRefresh = SIGMA_REFRESH_DATA;
  } else {
    // Flat branch: no refresh to learn from. Replay the stale window from
    // the first read (stale time + horizon), first refresh expected
    // INTERVAL_PRIOR_H after the first read, P x MULT_PRIOR, k = k_flat.
    const staleH = (Date.parse(c.at) - Date.parse(first.at)) / 3600000;
    const totalH = staleH + horizonH;
    ks = cats.map((cat) => K_FLAT[cat] * K_FLAT_SCALE);
    counts = first.rates.map((r, i) =>
      Math.round(((r ?? 0) * first.players_tracked) / 100));
    players = first.players_tracked;
    const refreshAt: Array<{ atH: number; mult: number }> = [];
    let when = INTERVAL_PRIOR_H;
    // Multiplier decays toward 1 (see data-driven branch): the first
    // refresh jumps P x MULT_PRIOR, later ones add a halving excess.
    let excess = MULT_PRIOR - 1;
    while (when <= totalH + 1e-9) {
      refreshAt.push({ atH: when, mult: 1 + excess });
      when += INTERVAL_PRIOR_H;
      excess *= G_DECAY;
    }
    const sim = simulate(counts, players, ks, cats, totalH, STEP_FLAT_H, refreshAt);
    counts = sim.counts;
    players = sim.players;
    sigmaRefresh = SIGMA_REFRESH_FLAT;
  }

  const sigma = Math.sqrt(
    sigmaRefresh * sigmaRefresh +
    (SIGMA_DRIFT * Math.sqrt(horizonDays)) ** 2 +
    SIGMA_CAT * SIGMA_CAT,
  );

  return c.trophies.map((t, i) => {
    let qs: number[];
    if (pinned[i]) {
      // A 100% trophy does not fall at a refresh: pin near 100% with a
      // symmetric spread around logit(99.99).
      const base = logit(99.99);
      qs = Z.map((z) => round4(logisticPct(base + z * sigma)));
    } else {
      const medianRate = clampPct((100 * counts[i]) / players);
      const base = logit(medianRate) + MEDIAN_SHIFT;
      qs = Z.map((z) => {
        const scale = z < 0 ? SIG_LO_SCALE : z > 0 ? SIG_HI_SCALE : 1;
        return round4(logisticPct(base + z * sigma * scale));
      });
    }
    // Keep quantiles non-decreasing and inside [0, 100] after rounding.
    const clean: number[] = [];
    for (const q of qs) {
      const prev = clean.length > 0 ? clean[clean.length - 1] : 0;
      clean.push(Math.min(100, Math.max(prev, Math.min(100, Math.max(0, q)))));
    }
    return { id: t.id, q: clean };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
