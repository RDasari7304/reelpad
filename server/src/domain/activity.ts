/**
 * Coin activity tiers. Most pump.fun coins never take off; the influencer shouldn't keep spending
 * money posting for a coin nobody trades. Each live coin is checked hourly and put in one of three states:
 *
 * - active:  normal posting (the creator's posts-per-day), Reels, comment replies, the Room.
 * - cooling: trading has dried up. A few posts a day, no Reels, still replies to comments.
 * - dormant: no real trading for days. Posting, replies and the Room stop; the treasury is checked
 *            less often. The moment trading comes back the coin is revived and posts a comeback.
 *
 * New coins get a grace period so a slow first day doesn't put them to sleep.
 */
export type Activity = "active" | "cooling" | "dormant";

export interface ActivitySignals {
  ageHours: number;
  /** 24h trading volume in USD, if a chart site has it. */
  volume24hUsd: number | null;
  /** Market cap in USD, if known. */
  mcapUsd: number | null;
  /** Creator fees collected in the last 24h (SOL): fees only exist when people trade. */
  fees24hSol: number;
  /** Largest relative price move across the last 24h of Reelpad's own price records (0.05 = 5%). */
  priceMove24h: number;
  /** Hours since the coin last met the "active" bar (null = never recorded). */
  hoursSinceActive: number | null;
}

export const ACTIVITY = {
  graceHours: 48,
  activeVolumeUsd: 1_000,
  activeMcapUsd: 30_000,
  coolingVolumeUsd: 100,
  dormantAfterHours: 72,
  activeFeesSol: 0.01,
  activePriceMove: 0.1,
} as const;

/** Whether the coin is clearly alive right now. */
export function meetsActiveBar(s: ActivitySignals): boolean {
  if (s.volume24hUsd !== null && s.volume24hUsd >= ACTIVITY.activeVolumeUsd) return true;
  if (s.mcapUsd !== null && s.mcapUsd >= ACTIVITY.activeMcapUsd && (s.volume24hUsd ?? 0) >= ACTIVITY.coolingVolumeUsd) return true;
  if (s.fees24hSol >= ACTIVITY.activeFeesSol) return true;
  // No chart data yet (brand-new or unindexed coin): fall back to price movement on the bonding curve.
  if (s.volume24hUsd === null && s.priceMove24h >= ACTIVITY.activePriceMove) return true;
  return false;
}

export function decideActivity(s: ActivitySignals): Activity {
  if (s.ageHours < ACTIVITY.graceHours) return "active";
  if (meetsActiveBar(s)) return "active";
  const someTrading =
    (s.volume24hUsd !== null && s.volume24hUsd >= ACTIVITY.coolingVolumeUsd) || s.fees24hSol > 0 || s.priceMove24h >= 0.02;
  const quietFor = s.hoursSinceActive ?? s.ageHours;
  if (!someTrading && quietFor >= ACTIVITY.dormantAfterHours) return "dormant";
  return "cooling";
}

/** Posts per day for a state (the creator's own setting applies only while active). */
export function postsPerDayFor(state: Activity, creatorSetting: number): number {
  if (state === "active") return creatorSetting;
  if (state === "cooling") return 3;
  return 0;
}

export const reelsAllowed = (state: Activity) => state === "active";
export const repliesAllowed = (state: Activity) => state !== "dormant";
export const inRoom = (state: Activity) => state !== "dormant";

/** Treasury check interval: dormant coins are checked a few times a day instead of every 15 minutes. */
export const treasuryIntervalMin = (state: Activity, normal: number) => (state === "dormant" ? 360 : normal);

/** Largest relative move between the min and max of a set of prices. */
export function priceMove(prices: number[]): number {
  const p = prices.filter((x) => Number.isFinite(x) && x > 0);
  if (p.length < 2) return 0;
  const lo = Math.min(...p);
  return (Math.max(...p) - lo) / lo;
}
