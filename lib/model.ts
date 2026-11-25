// Token Radar's value model: one sealed snapshot in, one ranked board out.
//
// A protocol's "launch" is the token it may one day issue. The board ranks the protocols that
// still record no token by what that token would be worth if each protocol's record stayed as it
// is. Every figure comes from the snapshot itself -- a protocol's TVL, its seven-day TVL change,
// and how long it has run with no token -- and the same function scores every row: no protocol
// name is ever special-cased.
//
//   scale      = tvl_usd x multiple(tvl_usd)
//                multiple(tvl) = BASE_MULTIPLE x (tvl / FLOOR)^(-SCALE_ALPHA)
//                a concave curve: twice the TVL is worth less than twice the token, because the
//                FDV/TVL multiple a launch can support falls as a protocol grows.
//   momentum   = 1 + clamp(change_7d, GROWTH_FLOOR, GROWTH_CAP)/100 x GROWTH_WEIGHT
//                seven-day TVL growth, damped on the way down and capped on the way up.
//   accrual    = ACCRUAL_FLOOR + (1 - ACCRUAL_FLOOR) x min(age_days, ACCRUAL_DAYS)/ACCRUAL_DAYS
//                the patience premium: the longer a protocol has run with no token, the more user
//                value has gathered inside it for a launch to monetise.
//   implied    = max(1, round(scale x momentum x accrual))
//
// Protocols whose token already trades are never scored by this model and never sit in the ranked
// board: they are set aside in a separate live-token table, at the market's own capitalisation.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
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

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
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

/** The dashboard's compact view of one row, with the farm plan the page renders verbatim. */
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

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
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

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The FDV/TVL multiple a launch could support at `tvl`, from the concave scale curve. */
export function scaleMultiple(tvl: number, floor: number, model: ModelConstants): number {
  const reference = Math.max(1, floor);
  const scaled = Math.max(tvl, 1) / reference;
  return model.base_multiple * Math.pow(scaled, -model.scale_alpha);
}

/** The four parts of one protocol's implied value under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  floor: number,
  model: ModelConstants,
): { implied: number; multiple: number; base: number; growthPct: number; growthMult: number; accrualMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const multiple = scaleMultiple(protocol.tvl_usd, floor, model);
  const base = protocol.tvl_usd * multiple;
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const accrualMult = model.accrual_floor + (1 - model.accrual_floor) * (Math.min(Math.max(ageForModel, 0), model.accrual_days) / model.accrual_days);
  const implied = Math.max(1, Math.round(base * growthMult * accrualMult));
  return { implied, multiple, base, growthPct, growthMult, accrualMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * The protocols the board ranks, strongest first, with ranks 1..n. The watchlist is the floor and
 * every one of its slugs is in; the early radar adds pre-token protocols below the floor, by TVL.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, snapshot.floor_usd, model);
    const plan = farmSteps(p, v.age, snapshot.floor_usd);
    return { p, plan, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      tvl_multiple: round4(s.multiple),
      scale_base_usd: Math.round(s.base),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      accrual_multiplier: round4(s.accrualMult),
      age_days: s.age,
    },
    farm_steps: s.plan.map(stepText),
    plan: s.plan,
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Check the protocol's own page before you act.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * Typical one-way gas cost on a chain, in dollars. These are order-of-magnitude planning figures
 * for a plain deposit or swap, keyed on the chain the snapshot names -- never on the protocol.
 */
const CHAIN_GAS: Array<[RegExp, string]> = [
  [/^ethereum$/i, '$4 to $12 of gas'],
  [/^(arbitrum|optimism|base|ink|unichain|blast|scroll|linea|mode|zora|sonic|berachain)$/i, 'under $0.50 of gas'],
  [/^(solana|sui|algorand|near|aptos|ton|tron)$/i, 'under $0.05 of gas'],
  [/^(binance|bnb|polygon|avalanche|fantom|kava|cronos|core|bsquared|plume|monad|pharos|arc|stellar|ripple|celo)$/i, 'under $1 of gas'],
  [/^bitcoin$/i, '$1 to $3 of fees'],
  [/^lightning$/i, 'a fraction of a cent in fees'],
];

function gasFor(chain: string): string {
  for (const [pattern, cost] of CHAIN_GAS) if (pattern.test(chain)) return cost;
  return 'under $1 of gas';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 300;
  if (p.tvl_usd >= 250_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 75;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 120) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The category's core action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator') || c.includes('curator')) return `Deposit $${capital} into a ${name}-curated vault on ${chain}, then leave the curator's allocation to work.`;
  if (c.includes('capital alloc') || c.includes('allocator')) return `Deposit $${capital} through ${name}'s on-chain allocation vault on ${chain} and hold the receipt token.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC as collateral to ${name} on ${chain}, then borrow a small amount against it.`;
  if (c.includes('dex') || c.includes('swap')) return `Swap once and then provide $${capital} of two-sided liquidity to ${name}'s deepest pool on ${chain}.`;
  if (c.includes('yield') || c.includes('leveraged')) return `Provide $${capital} of liquidity to ${name}'s main yield pool on ${chain} and auto-compound it.`;
  if (c.includes('rwa') || c.includes('tokeniz')) return `Mint $${capital} of ${name}'s tokenised yield asset on ${chain} and hold it through one payout cycle.`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt.`;
  if (c.includes('bridge') || c.includes('canonical')) return `Bridge $${capital} to ${chain} through ${name}, then use the bridged funds once inside its app.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Deposit $${capital} as margin on ${name} and open one small, fully-collateralised position.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold the receipt.`;
  if (c.includes('insurance') || c.includes('cover')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy to expiry.`;
  if (c.includes('payment') || c.includes('lightning')) return `Open a channel or account with ${name}, route $${capital} of payments through it, and keep the node online.`;
  if (c.includes('governance') || c.includes('incentive')) return `Stake $${capital} in ${name}'s incentive programme on ${chain} and vote in every proposal while it runs.`;
  if (c.includes('chain') || c.includes('infrastructure')) return `Run or delegate to ${name} on ${chain}: bond $${capital} or stake through its own app and keep the position.`;
  if (c.includes('cedefi')) return `Deposit $${capital} through ${name}'s CeDeFi product on ${chain} and hold through one rebalance.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven concrete steps, each with what it costs and how long it takes.
 * Derived from the protocol's own record -- category, chains, TVL, age -- never from a name list.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, floor: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const action = actionFor(p, capital, chain);
  const hot = age !== null && age < 180;
  return [
    {
      text: `Open a fresh wallet for this farm and keep its seed phrase offline; fund it with the capital plus a little for fees.`,
      cost: `${gas} to fund and activate`,
      time: '10 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital plus ${gas}`,
      time: '15 to 30 minutes',
    },
    {
      text: `Make one qualifying action each week -- a deposit, a withdrawal, a swap, a borrow repayment or a vote -- so the wallet stays active across snapshots.`,
      cost: `${gas} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Leave the position in place for at least ${hold} days${hot ? ' -- this protocol is under six months old, so early users are watched most closely' : ''}.`,
      cost: `the $${capital} stays deployed`,
      time: `${hold} days`,
    },
    {
      text: `Track your deposit value and any points or rewards balance weekly, and note the date you crossed each threshold.`,
      cost: 'free to check',
      time: '5 minutes a week',
    },
    {
      text: `Claim rewards only from the protocol's own app or a link it publishes; never pay anyone to unlock an airdrop.`,
      cost: 'no fee to claim',
      time: '10 minutes',
    },
    {
      text: `Log the wallet address, every transaction hash, the dates and the amounts, so you can prove the position or unwind it cleanly.`,
      cost: 'nothing but the record',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
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

/** A board row's compact form for data.js, with the farm plan the page renders verbatim. */
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

/** Everything the dashboard renders, from the snapshot. */
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

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
