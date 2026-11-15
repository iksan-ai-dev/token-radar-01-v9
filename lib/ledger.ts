// Launch Ledger v9 — the token radar's model.
//
// One sealed snapshot in, one ranked board out. Every number below is
// recomputed from the snapshot on each run: the size curve is an OLS fit
// over the live-token comparables, the category effects are shrunk medians
// of the same fit's residuals, and the age and growth factors use only the
// snapshot's own listed_at / change_7d. No protocol name is special-cased:
// the same functions score every row, watchlist or not.
//
//   implied = TVL x sizeCurve(TVL) x categoryEffect x growthFactor x ageFactor
//   sizeCurve: log10(mcap/TVL) = a + b.log10(TVL), fit at runtime (128 comps)
//   categoryEffect = 10^(median log-ratio x n/(n+4)), 4 pseudo-comps (shrink)
//   growthFactor = 1 + 0.75 x change_7d, clamped to [0.60, 1.60]
//   ageFactor = 0.55 + 0.45 x min(ageDays,730)/730; unknown age = 365 days
//   P25-P75 band: empirical quartiles (lower method) of the residuals that
//   remain after the shrunk category effect; ratio x9.71 on this snapshot.
//
// There is deliberately NO maturity factor: age is the single seasoning
// term. (An earlier version stacked a second age term on top; removing it
// moved Polymarket International from $125.5M to $107.3M and put the top
// three within 7% of each other. The board carries no maturity key.)

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const SHRINK_K = 4; // pseudo-comparables: the shrink strength, stated on the board.

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`; null when the date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((a - b) / DAY_MS));
}

/** 0.55 for a brand-new record, rising linearly to 1.00 at 730 days. */
export function ageFactor(days: number | null): number {
  const d = days ?? 365;
  return 0.55 + 0.45 * (Math.min(d, 730) / 730);
}

/** 1 + 0.75 x the 7-day TVL change, clamped to [0.60, 1.60]; 1.00 when unreported. */
export function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  return Math.max(0.6, Math.min(1.6, 1 + 0.75 * (change7d / 100)));
}

/** A protocol records no token when all three token fields are null. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORY = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * The house rule, applied to every candidate alike (watchlist rows pass it
 * by construction; early rows must pass it too): pre-token, not a bridge /
 * liquid-staking / restaked / CEX product, not a versioned pool, no wrapped
 * or staked word in the name, not named after an exchange.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORY.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

export interface CurveFit {
  intercept: number;
  slope: number;
  levelAt100M: number;
  loo: number;
  flatLoo: number;
  n: number;
}

function ols(xs: number[], ys: number[]): [number, number] {
  const m = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / m;
  const my = ys.reduce((s, v) => s + v, 0) / m;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < m; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const b = sxy / sxx;
  return [my - b * mx, b];
}

/** The size curve, fit at runtime over the live-token comparables. */
export function fitCurve(comps: SnapshotProtocol[]): CurveFit {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const [a, b] = ols(xs, ys);
  // Leave-one-out median error factor, refitting without each comp in turn.
  const errs: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const [a2, b2] = ols(
      xs.filter((_, j) => j !== i),
      ys.filter((_, j) => j !== i),
    );
    const pred = a2 + b2 * xs[i]!;
    errs.push(Math.max(10 ** (pred - ys[i]!), 10 ** (ys[i]! - pred)));
  }
  errs.sort((x, y) => x - y);
  const loo = (errs[Math.floor((errs.length - 1) / 2)]! + errs[Math.ceil((errs.length - 1) / 2)]!) / 2;
  // Flat baseline: one median multiple for every comp.
  const sortedYs = [...ys].sort((x, y) => x - y);
  const flatLog = (sortedYs[Math.floor((sortedYs.length - 1) / 2)]! + sortedYs[Math.ceil((sortedYs.length - 1) / 2)]!) / 2;
  const ferrs = ys
    .map((y) => Math.max(10 ** (flatLog - y), 10 ** (y - flatLog)))
    .sort((x, y) => x - y);
  const flatLoo = (ferrs[Math.floor((ferrs.length - 1) / 2)]! + ferrs[Math.ceil((ferrs.length - 1) / 2)]!) / 2;
  return { intercept: a, slope: b, levelAt100M: 10 ** (a + b * 8), loo, flatLoo, n: xs.length };
}

export interface CategoryEffect {
  n: number;
  raw: number;
  effect: number;
}

/**
 * One effect per category: the median log-ratio of a comp's actual
 * mcap/TVL against the size curve, shrunk toward 1 with SHRINK_K
 * pseudo-comparables. A category with no live comps gets effect 1 (curve
 * only) and is labelled as such on the model screen.
 */
export function categoryEffects(
  comps: SnapshotProtocol[],
  curve: (tvl: number) => number,
): Map<string, CategoryEffect> {
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const c = p.category ?? '(none)';
    const ratio = Math.log10(p.mcap_usd! / p.tvl_usd / curve(p.tvl_usd));
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(ratio);
  }
  const out = new Map<string, CategoryEffect>();
  for (const [c, rs] of byCat) {
    const s = [...rs].sort((x, y) => x - y);
    const med = (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2;
    out.set(c, {
      n: s.length,
      raw: 10 ** med,
      effect: 10 ** (med * (s.length / (s.length + SHRINK_K))),
    });
  }
  return out;
}

/** Lower-method quartile: sorted[floor/ceil-free index] — the empirical CDF's inverse. */
function lowerQuantile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/** P25/P75 multipliers from the residuals left after the shrunk effects. */
export function residualBand(
  comps: SnapshotProtocol[],
  curve: (tvl: number) => number,
  effects: Map<string, CategoryEffect>,
): { q25: number; q75: number; ratio: number } {
  const res = comps
    .map((p) => {
      const e = effects.get(p.category ?? '(none)')?.effect ?? 1;
      return Math.log10(p.mcap_usd! / (p.tvl_usd * curve(p.tvl_usd) * e));
    })
    .sort((x, y) => x - y);
  const q25 = 10 ** lowerQuantile(res, 0.25);
  const q75 = 10 ** lowerQuantile(res, 0.75);
  return { q25, q75, ratio: q75 / q25 };
}

// ---------------------------------------------------------------- farm economics

/** Stated gas estimates per transaction, November 2026 (not snapshot data). */
export const GAS_PER_TX: Record<string, number> = {
  Ethereum: 2.5,
  Tron: 0.5,
  Binance: 0.05,
  Avalanche: 0.05,
  Base: 0.08,
  Arbitrum: 0.1,
  Optimism: 0.08,
  Polygon: 0.02,
  Solana: 0.01,
};
const DEFAULT_GAS = 0.1;

/** The cheapest chain to farm on (top-1's "FARM ON" idea): lowest gas, ties keep list order. */
export function farmChain(p: SnapshotProtocol): string {
  let best = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  let bestGas = GAS_PER_TX[best] ?? DEFAULT_GAS;
  for (const c of p.chains) {
    const g = GAS_PER_TX[c] ?? DEFAULT_GAS;
    if (g < bestGas) {
      best = c;
      bestGas = g;
    }
  }
  return best;
}

/** Working capital for one farm position, from the protocol's own TVL. */
export function ticketFor(tvlUsd: number): number {
  if (tvlUsd >= 1_000_000_000) return 350;
  if (tvlUsd >= 100_000_000) return 150;
  if (tvlUsd >= 25_000_000) return 100;
  return 50;
}

/** Qualifying hold: younger records need the longer window. */
export function holdWeeksFor(age: number | null): number {
  return (age ?? 365) < 730 ? 12 : 8;
}

/** Expected airdrop slice per $1,000 farmed: 7.5% of implied value reaches farmers. */
export function slicePer1k(impliedUsd: number, tvlUsd: number): number {
  return (impliedUsd * 0.075) / (tvlUsd / 1000);
}

/**
 * The farm call. It is deliberately NOT the ranking: rank is launch size,
 * the call is pay per $1,000 farmed. A giant launch dilutes each farmer's
 * slice, so the biggest rows can rank #1 and still pay a thin slice — the
 * board says so in one line above the table.
 */
export function verdictFor(slice: number): 'Worth it' | 'Thin' | 'Low slice' {
  if (slice >= 20) return 'Worth it';
  if (slice >= 5) return 'Thin';
  return 'Low slice';
}

// ---------------------------------------------------------------- farm steps

type Family = 'vault' | 'market' | 'lend' | 'dex' | 'rwa' | 'app';

function familyOf(category: string | null): Family {
  const c = (category ?? '').toLowerCase();
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield') || c.includes('vault') || c.includes('cdp manager')) return 'vault';
  if (c.includes('prediction')) return 'market';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('borrow')) return 'lend';
  if (c.includes('dex') || c.includes('derivativ') || c.includes('basis') || c.includes('perp') || c.includes('option')) return 'dex';
  if (c.includes('rwa') || c.includes('stable')) return 'rwa';
  return 'app';
}

const FAMILY_OPEN: Record<Family, string> = {
  vault: 'Open the vault the protocol routes most TVL through',
  market: 'Fund the account and take a first position in a market you can follow to settlement',
  lend: 'Supply the ticket as collateral, then borrow a small amount against it and keep the health factor above 2',
  dex: 'Swap half the ticket into the pool’s second asset, then add both sides as liquidity',
  rwa: 'Mint the protocol’s yield-bearing asset with the ticket and hold the receipt',
  app: 'Deposit the ticket into the protocol’s main product and complete one full cycle of it',
};

const FAMILY_THIRD: Record<Family, string> = {
  vault: 'Spread the ticket across a second vault on the same chain so the position is not one manager’s record alone',
  market: 'Take a second, smaller position on the other side of a market you already follow, sized so a loss still leaves the week green',
  lend: 'Repay a tenth of the borrow, then supply it again, so the record shows repeated use rather than one parked deposit',
  dex: 'Add liquidity to the main pool a second time with a different pair size, so the record shows two distinct provisions',
  rwa: 'Mint a second, smaller tranche of the yield asset a week later, so the record shows accumulation rather than one purchase',
  app: 'Use a second feature of the app — the one the front page lists next to the first — with a tenth of the ticket',
};

const STEP5 = [
  'At week four, open the protocol’s own points or rewards page and confirm the position is counted; if it is not, redo the qualifying action once and note the date.',
  'After thirty days, export the position history from the protocol’s own page and check the balance, the dates and the chain all match the farm log.',
  'Midway through the hold, check whether the protocol published a snapshot date or a points season; if it did, align the next weekly action to its window.',
];
const STEP6 = [
  'Try the protocol’s second feature with a tenth of the ticket — a vote, a second market, a different vault — because diversified use is what allocation rules usually reward.',
  'Add a second asset to the same position instead of a second position: one wallet, one venue, two assets, so the record stays coherent.',
  'Join the protocol’s public call or vote once, from the same wallet, and keep the receipt; participation is a separate signal from deposits.',
];
const STEP8 = [
  'Keep a farm log — wallet, dates, amounts, transaction ids — so the position can be repeated or unwound without guessing.',
  'Set a calendar reminder for the claim window the protocol announces; a missed window is a lost allocation, whatever the position was worth.',
  'Write the exit rule down before any token exists: withdraw a tenth first, confirm the receipt, then the rest — never all at once on day one.',
];

function hashOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

function money(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(2)}`;
}

/**
 * Eight concrete steps per protocol, each carrying its own cost and time.
 * The text is built from the protocol's own record (name, family, farm
 * chain, ticket, hold, gas) — never from a hand-written list of names.
 * Steps 5, 6 and 8 rotate through three variants by slug hash so no step
 * reads verbatim across the whole board.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number): string[] {
  const chain = farmChain(p);
  const ticket = ticketFor(p.tvl_usd);
  const hold = holdWeeksFor(age);
  const holdDays = hold * 7;
  const gas = GAS_PER_TX[chain] ?? DEFAULT_GAS;
  const gas90 = 10 * gas;
  const handsOn = Math.round(((5 + 15 + 20 + 15 + 10 + 20 + 10 + 10 * hold) / 60) * 10) / 10;
  const fam = familyOf(p.category);
  const h = hashOf(p.slug);
  const steps: string[] = [
    `Use a fresh wallet that holds only the $${ticket} you plan to farm with, and keep its seed phrase offline on paper. Cost: no fee to set up. Time: 5 minutes.`,
    `${FAMILY_OPEN[fam]} on ${chain} with $${ticket}. Cost: $${ticket} of capital plus about ${money(gas)} of gas. Time: 15 minutes to set up.`,
    `${FAMILY_THIRD[fam]} on ${chain}. Cost: no new capital, about ${money(gas)} of gas. Time: 20 minutes.`,
    `Make one qualifying action each week for ${hold} weeks — a deposit, a borrow, a swap or a vote — varying the amount each time so the pattern reads as organic use. Cost: about ${money(gas)} of gas a week. Time: 10 minutes a week.`,
    `${STEP5[h % 3]} Cost: no fee to check. Time: 10 minutes.`,
    `${STEP6[(h >> 2) % 3]} Cost: about ${money(gas)} of gas. Time: 15 minutes.`,
    `Stress-test the exit: withdraw a tenth of the $${ticket} position, confirm the receipt lands, then put it back if the position still qualifies. Cost: about ${money(gas)} of gas. Time: 20 minutes.`,
    `${STEP8[(h >> 4) % 3]} Hold the position at least ${holdDays} days in total; gas for 90 days runs about ${money(gas90)} and hands-on time about ${handsOn} hours. Cost: the $${ticket} stays in the position. Time: 10 minutes.`,
  ];
  return steps.map((s) => {
    const t = s.trim();
    if (t.length > 600) return `${t.slice(0, 597)}...`;
    return t;
  });
}

// ---------------------------------------------------------------- the board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  age_factor: number;
  growth_factor: number;
  curve_multiple: number;
  category_effect: number;
  category_n: number;
  category_raw: number | null;
  implied_value_usd: number;
  p25_usd: number;
  p75_usd: number;
  slice_per_1k: number;
  ticket_usd: number;
  hold_weeks: number;
  farm_chain: string;
  gas_90d_usd: number;
  hands_on_hours: number;
  verdict: 'Worth it' | 'Thin' | 'Low slice';
  tier: 'Watchlist' | 'Above floor' | 'Early find';
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  floor_usd: number;
  curve: { intercept: number; slope: number; level_at_100m: number; loo: number; flat_loo: number; n: number };
  band: { q25: number; q75: number; ratio: number };
  categories: { name: string; n: number; raw: number | null; effect: number }[];
  counts: { scanned: number; ranked: number; watchlist: number; early: number; below_floor: number; above_floor: number; trading: number; set_aside: number; total_implied_usd: number };
  rows: BoardRow[];
  comps: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number }[];
  live: LiveRow[];
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const fit = fitCurve(comps);
  const curve = (tvl: number): number => 10 ** (fit.intercept + fit.slope * Math.log10(tvl));
  const effects = categoryEffects(comps, curve);
  const band = residualBand(comps, curve, effects);

  const wl = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => isRankable(p));
  const scored = chosen.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const af = ageFactor(age);
    const gf = growthFactor(p.change_7d);
    const cat = p.category ?? '(none)';
    const eff = effects.get(cat);
    const curveMult = curve(p.tvl_usd);
    const catEffect = eff?.effect ?? 1;
    const implied = Math.max(1, Math.round(p.tvl_usd * curveMult * catEffect * gf * af));
    const slice = round2(slicePer1k(implied, p.tvl_usd));
    const chain = farmChain(p);
    const gas = GAS_PER_TX[chain] ?? DEFAULT_GAS;
    const hold = holdWeeksFor(age);
    return {
      p,
      age,
      af,
      gf,
      curveMult,
      catEffect,
      catN: eff?.n ?? 0,
      catRaw: eff?.raw ?? null,
      implied,
      slice,
      chain,
      hold,
    };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => {
    const p = s.p;
    const tier: BoardRow['tier'] = wl.has(p.slug)
      ? 'Watchlist'
      : p.tvl_usd >= snapshot.floor_usd
        ? 'Above floor'
        : 'Early find';
    const gas = GAS_PER_TX[s.chain] ?? DEFAULT_GAS;
    const handsOn = Math.round(((5 + 15 + 20 + 15 + 10 + 20 + 10 + 10 * s.hold) / 60) * 10) / 10;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: s.age,
      age_factor: round4(s.af),
      growth_factor: round4(s.gf),
      curve_multiple: round4(s.curveMult),
      category_effect: round4(s.catEffect),
      category_n: s.catN,
      category_raw: s.catRaw === null ? null : round4(s.catRaw),
      implied_value_usd: s.implied,
      p25_usd: Math.round(s.implied * band.q25),
      p75_usd: Math.round(s.implied * band.q75),
      slice_per_1k: s.slice,
      ticket_usd: ticketFor(p.tvl_usd),
      hold_weeks: s.hold,
      farm_chain: s.chain,
      gas_90d_usd: round2(10 * gas),
      hands_on_hours: handsOn,
      verdict: verdictFor(s.slice),
      tier,
      farm_steps: farmSteps(p, s.age, s.implied),
    };
  });

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, 12)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));

  const categories = [...effects.entries()]
    .map(([name, e]) => ({ name, n: e.n, raw: round4(e.raw), effect: round4(e.effect) }))
    .sort((a, b) => (b.effect - a.effect) || a.name.localeCompare(b.name));
  // Categories on the board with no live comps: curve only, effect 1.
  const boardCats = new Set(board.map((r) => r.category ?? '(none)'));
  for (const c of boardCats) {
    if (!effects.has(c)) categories.push({ name: c, n: 0, raw: null, effect: 1 });
  }
  // Categories of the live-token table, so every label resolves in data.js.
  for (const p of live) {
    const c = p.category ?? '(none)';
    if (!categories.some((x) => x.name === c)) {
      const e = effects.get(c);
      categories.push({ name: c, n: e?.n ?? 0, raw: e ? round4(e.raw) : null, effect: e ? round4(e.effect) : 1 });
    }
  }
  categories.sort((a, b) => (b.effect - a.effect) || a.name.localeCompare(b.name));

  const early = board.filter((r) => r.tier !== 'Watchlist');
  const trading = snapshot.protocols.filter((p) => !isPreToken(p)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    curve: {
      intercept: round4(fit.intercept),
      slope: round4(fit.slope),
      level_at_100m: round4(fit.levelAt100M),
      loo: round4(fit.loo),
      flat_loo: round4(fit.flatLoo),
      n: fit.n,
    },
    band: { q25: round4(band.q25), q75: round4(band.q75), ratio: round4(band.ratio) },
    categories,
    counts: {
      scanned: snapshot.protocols.length,
      ranked: board.length,
      watchlist: snapshot.watchlist.length,
      early: early.length,
      below_floor: early.filter((r) => r.tier === 'Early find').length,
      above_floor: early.filter((r) => r.tier === 'Above floor').length,
      trading,
      set_aside: snapshot.protocols.length - board.length - trading,
      total_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
    },
    rows: board,
    comps: comps.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
    })),
    live,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

// ---------------------------------------------------------------- data.js

/**
 * The dashboard's whole dataset as one compact script (index 9 of each row
 * is the implied value, so the page and board.json can be checked against
 * each other). Row: [rank, slug, name, catIdx, chains, tvlK, ch7, age,
 * curve, implied, effect, growth, ageF, slice, ticket, hold, verdict,
 * tier]. Comp: [slug, catIdx, tvlK, mcapK]. P25/P75 are not stored per row:
 * the page multiplies the implied value by the band's quartiles. Rows are
 * one per line so the dossier can show them even if a later file is cut.
 */
export function dataScript(radar: RadarData): string {
  const catIdx = new Map<string, number>();
  radar.categories.forEach((c, i) => catIdx.set(c.name, i));
  const ci = (c: string | null): number => catIdx.get(c ?? '(none)') ?? -1;
  const rows = radar.rows.map((r) => [
    r.rank,
    r.slug,
    r.name,
    ci(r.category),
    [...new Set([r.farm_chain, ...r.chains])].slice(0, 2).join(','),
    Math.round(r.tvl_usd / 1000),
    r.change_7d === null ? null : round2(r.change_7d),
    r.age_days,
    r.curve_multiple,
    r.implied_value_usd,
    r.category_effect,
    r.growth_factor,
    r.age_factor,
    r.slice_per_1k,
    r.ticket_usd,
    r.hold_weeks,
    r.verdict === 'Worth it' ? 2 : r.verdict === 'Thin' ? 1 : 0,
    r.tier === 'Watchlist' ? 0 : r.tier === 'Above floor' ? 1 : 2,
  ]);
  const comps = radar.comps.map((p) => [p.slug, ci(p.category), Math.round(p.tvl_usd / 1000), Math.round(p.mcap_usd / 1000)]);
  const live = radar.live.map((p) => [p.slug, p.name, ci(p.category), Math.round(p.tvl_usd / 1000), Math.round(p.mcap_usd / 1000)]);
  const cc = radar.counts;
  const meta = {
    asOf: radar.as_of,
    floorM: radar.floor_usd / 1e6,
    curve: radar.curve,
    band: radar.band,
    cats: radar.categories.map((c) => [c.name, c.n, c.raw === null ? null : Math.round(c.raw * 100) / 100, c.effect]),
    counts: { sc: cc.scanned, rk: cc.ranked, wl: cc.watchlist, er: cc.early, bf: cc.below_floor, af: cc.above_floor, tr: cc.trading, sa: cc.set_aside, ti: cc.total_implied_usd },
  };
  const rowsJson = rows.map((r) => JSON.stringify(r)).join(',\n');
  const compsJson = comps.map((c) => JSON.stringify(c)).join(',');
  const liveJson = live.map((c) => JSON.stringify(c)).join(',');
  return `window.RADAR=${JSON.stringify(meta).slice(0, -1)},"rows":[\n${rowsJson}\n],"comps":[${compsJson}],"live":[${liveJson}]};\n`;
}
