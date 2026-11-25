// lib/model.ts -- Token Radar's scoring core.
//
// One sealed snapshot goes in; one ordered board comes out. A "launch" here is the token a
// protocol might still issue: the board asks what that token would be worth if the protocol's
// recorded state held still. Nothing is keyed on a protocol's name -- the same arithmetic runs
// over every row, using only the fields the snapshot carries.
//
// The implied value is a product of three factors:
//
//   size     tvl_usd * launchMultiple(tvl_usd)
//            launchMultiple shrinks as TVL grows: BASE_MULTIPLE * (tvl / floor)^(-SCALE_ALPHA).
//            The exponent is concave on purpose -- a launch four times larger does not command
//            four times the fully diluted value, because the multiple the market pays compresses.
//
//   drift    1 + clamped(change_7d) / 100 * GROWTH_WEIGHT
//            Seven-day TVL momentum, floored so a collapse cannot zero a row and capped so a
//            single spike cannot carry it.
//
//   patience ACCRUAL_FLOOR + (1 - ACCRUAL_FLOOR) * min(age_days, ACCRUAL_DAYS) / ACCRUAL_DAYS
//            A protocol that has run tokenless for longer has banked more user value for a launch
//            to convert. A missing listing date falls back to UNKNOWN_AGE_DAYS, not to zero.
//
//   implied  max(1, round(size * drift * patience))
//
// Protocols that already trade have no launch left to price. They never enter the ranked board;
// they are collected separately at their market capitalisation.

/** One protocol exactly as the sealed snapshot records it. */
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

/** The snapshot document: the as-of date, the floor, the protocols and the watchlist slugs. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The eight tuning values the page publishes alongside the board. */
export interface ModelConstants {
  base_multiple: number;
  scale_alpha: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  accrual_floor: number;
  accrual_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.55,
  scale_alpha: 0.25,
  growth_weight: 0.6,
  growth_floor: -60,
  growth_cap: 150,
  accrual_floor: 0.75,
  accrual_days: 1095,
  unknown_age_days: 365,
};

/** The label the dashboard prints for this version of the arithmetic. */
export const MODEL_VERSION = 'radar-2';

/** How many below-floor protocols the early radar appends, taken by TVL. */
export const EARLY_ROWS = 160;

/** How many already-trading protocols the live view carries, taken by market cap. */
export const LIVE_ROWS = 24;

/** One farm instruction: the action, its cost, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** board.json's row: the ranked entry with its full scoring breakdown. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    tvl_multiple: number;
    scale_base_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    accrual_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
  plan: FarmStep[];
}

/** The compact row data.js ships, carrying the plan the page prints as written. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  tvl_multiple: number;
  growth_multiplier: number;
  accrual_multiplier: number;
  plan: FarmStep[];
}

/** An already-trading protocol: shown at the market's value, never scored by the model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The whole dataset the page needs, plus the constants it quotes. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  protocol_count: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Raised when a document is not a snapshot this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** Squeeze `n` into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** `value` when it is a real number, else `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Four decimal places, the precision the page prints and board.json stores. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` up to `asOf`, floored at zero; null when a date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

/** The FDV/TVL multiple a launch can support at this TVL: concave in TVL, anchored at the floor. */
export function scaleMultiple(tvl: number, floor: number, model: ModelConstants): number {
  const anchor = Math.max(1, floor);
  const ratio = Math.max(tvl, 1) / anchor;
  return model.base_multiple * Math.pow(ratio, -model.scale_alpha);
}

/**
 * One protocol's score, factor by factor: the implied value, the three multipliers that produced
 * it, the clamped growth reading, and the age the accrual used (null when no listing date exists).
 */
export interface ValueBreakdown {
  implied: number;
  multiple: number;
  base: number;
  growthPct: number;
  growthMult: number;
  accrualMult: number;
  age: number | null;
}

/** Score one protocol under `model`; the shape is ValueBreakdown. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  floor: number,
  model: ModelConstants,
): ValueBreakdown {
  const age = ageDays(asOf, protocol.listed_at);

  const multiple = scaleMultiple(protocol.tvl_usd, floor, model);
  const base = protocol.tvl_usd * multiple;

  // Momentum is read from the snapshot, damped by GROWTH_WEIGHT, and clamped to a sane band.
  const growthPct = clamp(num(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;

  // Patience: an unknown listing date gets a mid-range default rather than a zero penalty.
  const ageForModel = age ?? model.unknown_age_days;
  const accrualMult =
    model.accrual_floor + (1 - model.accrual_floor) * (clamp(ageForModel, 0, model.accrual_days) / model.accrual_days);

  const implied = Math.max(1, Math.round(base * growthMult * accrualMult));
  return { implied, multiple, base, growthPct, growthMult, accrualMult, age };
}

/** A trailing release marker ("Aave V3", "Uniswap v2", "Foo 2.0") marks a pool of another protocol. */
const RELEASE_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** True when the protocol records no token at all -- no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * True when the board may rank the protocol: it holds no token yet, it is not a centralised
 * exchange, and its name carries no release marker. The watchlist itself arrives already screened
 * by the snapshot's own producer; these guards are what the early tail is filtered through.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !RELEASE_SUFFIX.test(p.name);
}

/** Slug-ascending comparison, the deterministic tie-break for equal values and equal TVL. */
function bySlugAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Look protocols up by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/**
 * The ranked rows, strongest first, numbered 1..n.
 *
 * The set is the watchlist (every slug it names that the snapshot actually holds) plus the
 * EARLY_ROWS largest below-floor protocols that pass `isRankable`. Ties in implied value fall
 * back to slug order, so the board is deterministic for a given snapshot.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();

  for (const slug of snapshot.watchlist) {
    const protocol = index.get(slug);
    if (protocol !== undefined) picked.set(slug, protocol);
  }

  const tail = snapshot.protocols
    .filter((p) => !picked.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugAscending(a.slug, b.slug))
    .slice(0, EARLY_ROWS);
  for (const p of tail) picked.set(p.slug, p);

  const scored = [...picked.values()].map((protocol) => {
    const value = impliedValue(protocol, snapshot.as_of, snapshot.floor_usd, model);
    return { protocol, value, plan: farmSteps(protocol, value.age, snapshot.floor_usd) };
  });
  scored.sort((a, b) => b.value.implied - a.value.implied || bySlugAscending(a.protocol.slug, b.protocol.slug));

  return scored.map((entry, i) => {
    const p = entry.protocol;
    const v = entry.value;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: v.age,
      implied_value_usd: v.implied,
      model: {
        tvl_multiple: round4(v.multiple),
        scale_base_usd: Math.round(v.base),
        growth_pct: v.growthPct,
        growth_multiplier: round4(v.growthMult),
        accrual_multiplier: round4(v.accrualMult),
        age_days: v.age,
      },
      farm_steps: entry.plan.map(stepText),
      plan: entry.plan,
    };
  });
}

/** A step as one line: the action, then its cost and time, kept inside the 20..600 character gate. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Check the protocol's own page before you act.`;
  return s;
}

/** The first chain the protocol names, or a neutral stand-in. */
function primaryChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * Order-of-magnitude gas for one plain deposit or swap on a chain, in dollars. Keyed on the chain
 * the snapshot records, never on the protocol name.
 */
const GAS_BY_CHAIN: Array<[RegExp, string]> = [
  [/^ethereum$/i, '$4 to $12 of gas'],
  [/^(arbitrum|optimism|base|ink|unichain|blast|scroll|linea|mode|zora|sonic|berachain)$/i, 'under $0.50 of gas'],
  [/^(solana|sui|algorand|near|aptos|ton|tron)$/i, 'under $0.05 of gas'],
  [/^(binance|bnb|polygon|avalanche|fantom|kava|cronos|core|bsquared|plume|monad|pharos|arc|stellar|ripple|celo)$/i, 'under $1 of gas'],
  [/^bitcoin$/i, '$1 to $3 of fees'],
  [/^lightning$/i, 'a fraction of a cent in fees'],
];

/** The gas phrase for a chain, defaulting to the sub-dollar tier. */
function gasFor(chain: string): string {
  for (const [pattern, phrase] of GAS_BY_CHAIN) if (pattern.test(chain)) return phrase;
  return 'under $1 of gas';
}

/** Working capital for one position, sized from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 300;
  if (p.tvl_usd >= 250_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 75;
}

/** How long the position should sit: younger protocols need longer qualifying windows. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 120) return 90;
  if (age < 365) return 60;
  return 45;
}

/**
 * The one action that puts money inside the protocol, phrased for the category the snapshot
 * records. Branch order matters: the most specific categories are tested first.
 */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator') || c.includes('curator')) return `Deposit $${capital} into a ${name}-curated vault on ${chain} and let the curator's allocation work for you.`;
  if (c.includes('capital alloc') || c.includes('allocator')) return `Put $${capital} through ${name}'s on-chain allocation vault on ${chain} and keep the receipt token it issues.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} as collateral, then borrow a small amount against it.`;
  if (c.includes('dex') || c.includes('swap')) return `Swap once, then provide $${capital} of two-sided liquidity to ${name}'s deepest pool on ${chain}.`;
  if (c.includes('yield') || c.includes('leveraged')) return `Add $${capital} of liquidity to ${name}'s main yield pool on ${chain} and let it auto-compound.`;
  if (c.includes('rwa') || c.includes('tokeniz')) return `Mint $${capital} of ${name}'s tokenised yield asset on ${chain} and hold it through one full payout cycle.`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('bridge') || c.includes('canonical')) return `Move $${capital} to ${chain} through ${name}, then deploy the bridged funds once inside its app.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Post $${capital} as margin on ${name} and open one small, fully collateralised position.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold the receipt.`;
  if (c.includes('insurance') || c.includes('cover')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy to expiry.`;
  if (c.includes('payment') || c.includes('lightning')) return `Open a channel or account with ${name}, route $${capital} of payments through it, and keep the node online.`;
  if (c.includes('governance') || c.includes('incentive')) return `Stake $${capital} in ${name}'s incentive programme on ${chain} and vote on every proposal while it runs.`;
  if (c.includes('chain') || c.includes('infrastructure')) return `Run or delegate to ${name} on ${chain}: bond $${capital} or stake through its own app and hold the position.`;
  if (c.includes('cedefi')) return `Deposit $${capital} through ${name}'s CeDeFi product on ${chain} and hold across one rebalance.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * Seven steps per row, then a one-line rationale -- each step with its cost and its duration.
 * Every phrase is derived from the protocol's record: category, chains, TVL, age.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, floor: number): FarmStep[] {
  const chain = primaryChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const action = coreAction(p, capital, chain);
  const young = age !== null && age < 180;
  const growth = p.change_7d === null ? 'no seven-day figure recorded' : `${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}% TVL over seven days`;
  const ageLine = age === null ? 'no listing date on record' : `${age} days without a token`;

  return [
    {
      text: `Open a wallet used only for this farm, keep its seed phrase offline, and fund it with the working capital plus a little extra for fees.`,
      cost: `${gas} to fund and activate`,
      time: '10 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital plus ${gas}`,
      time: '15 to 30 minutes',
    },
    {
      text: `Repeat one qualifying action every week -- a deposit, a withdrawal, a swap, a repayment or a vote -- so the address reads as an active user from one snapshot to the next.`,
      cost: `${gas} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Leave the position untouched for at least ${hold} days${young ? ' -- the protocol is under six months old, and early users get watched most closely' : ''}.`,
      cost: `the $${capital} stays deployed`,
      time: `${hold} days`,
    },
    {
      text: `Write down any points balance, testnet quest or airdrop claim the protocol shows each week, and note the date each threshold was crossed.`,
      cost: 'free to check',
      time: '5 minutes a week',
    },
    {
      text: `Claim anything owed only from the protocol's own app or a link it publishes itself; never pay a third party to unlock an airdrop.`,
      cost: 'no fee to claim',
      time: '10 minutes',
    },
    {
      text: `Log the wallet address, every transaction hash, the dates and the amounts, so the position can be proved or unwound cleanly later.`,
      cost: 'nothing but the record',
      time: '5 minutes',
    },
    {
      text: `Why this protocol: $${p.tvl_usd.toLocaleString('en-US')} of TVL, ${growth}, ${ageLine} -- a launch would price value that already exists.`,
      cost: 'no spend, just the read',
      time: 'one line',
    },
  ];
}

/** Already-trading protocols, largest market cap first, for the dashboard's live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Squeeze a board row into the compact shape data.js carries, plan included verbatim. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    tvl_multiple: row.model.tvl_multiple,
    growth_multiplier: row.model.growth_multiplier,
    accrual_multiplier: row.model.accrual_multiplier,
    plan: row.plan,
  };
}

/** The full dashboard payload, built from one snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    protocol_count: snapshot.protocols.length,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Parse a snapshot's text, refusing anything the model could not score honestly. */
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

  const protocols = o.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = entry as Record<string, unknown>;
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

/**
 * The first reason a board would fail the gate, or null when it would pass: watchlist coverage,
 * contiguous ranks, descending value, at least two distinct values, and usable farm steps.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }

  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;

  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }

  for (const row of board) {
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${row.slug} has ${steps.length} farm steps`;
    for (const step of steps) if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `${row.slug} has implied value ${row.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script tag's worth of text -- no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
