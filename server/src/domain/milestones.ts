/**
 * Milestones: real events the character reacts to with a post. Each is recorded once (by kind + key),
 * so the same milestone is never celebrated twice.
 *
 * The post states the fact and celebrates in character. It never predicts the price, names a next
 * target, or suggests buying (the usual content rules still apply).
 */
export type MilestoneKind = "graduated" | "ath" | "mcap" | "record_burn";

export interface Milestone {
  kind: MilestoneKind;
  /** Dedupe key within the kind (e.g. the market-cap level "100000"). */
  key: string;
  /** What happened, for the post's brief. */
  note: string;
}

export const MCAP_LEVELS = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000];

export const fmtUsd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M` : `$${Math.round(n / 1e3)}K`;

const RULE =
  "State it as a plain fact and celebrate it in character, thanking the people who made it happen. Never predict the price, name a next target, or suggest buying.";

/** The coin just finished its bonding curve and moved to PumpSwap. */
export function graduationMilestone(wasGraduated: boolean, isGraduated: boolean): Milestone | null {
  if (wasGraduated || !isGraduated) return null;
  return {
    kind: "graduated",
    key: "1",
    note: `Big moment: your coin just graduated from pump.fun's bonding curve to PumpSwap. ${RULE}`,
  };
}

/** Highest market-cap level crossed that hasn't been celebrated yet (only the top one, to avoid a burst). */
export function mcapMilestone(mcapUsd: number | null, celebrated: Set<string>): Milestone | null {
  if (!mcapUsd || !Number.isFinite(mcapUsd)) return null;
  const crossed = MCAP_LEVELS.filter((l) => mcapUsd >= l && !celebrated.has(String(l)));
  if (!crossed.length) return null;
  const level = crossed[crossed.length - 1]!;
  return {
    kind: "mcap",
    key: String(level),
    note: `Your coin's market cap just passed ${fmtUsd(level)} for the first time. ${RULE}`,
  };
}

/**
 * A new all-time high: at least 25% above the previous high, on a coin older than 6 hours (launch-day
 * pumps don't count), and at most one ATH post a day (the key is the UTC date).
 */
export function athMilestone(opts: { priceSol: number; prevHighSol: number | null; ageHours: number; now: Date }): Milestone | null {
  const { priceSol, prevHighSol, ageHours, now } = opts;
  if (!prevHighSol || ageHours < 6 || !(priceSol > prevHighSol * 1.25)) return null;
  return {
    kind: "ath",
    key: now.toISOString().slice(0, 10),
    note: `Your coin just hit a new all-time high. ${RULE}`,
  };
}

/** The biggest burn so far (from the third burn on, so the first couple don't each count as a "record"). */
export function recordBurnMilestone(tokens: number, prevMax: number | null, burnsBefore: number, symbol: string): Milestone | null {
  if (burnsBefore < 2 || !prevMax || !(tokens > prevMax * 1.1)) return null;
  return {
    kind: "record_burn",
    key: String(Math.round(tokens)),
    note: `Your treasury just made its biggest burn yet: ${Math.round(tokens).toLocaleString("en-US")} $${symbol} bought back with creator fees and burned. ${RULE}`,
  };
}
