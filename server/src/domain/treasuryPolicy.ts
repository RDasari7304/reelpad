/**
 * Pure decision logic for the automatic buyback-and-burn treasury. No I/O, fully unit-tested.
 *
 * Every coin's agent wallet receives the coin's pump.fun creator fees. On each run the agent spends
 * ALL the SOL above its gas reserve: part buys back the coin itself, part buys back the platform's
 * native coin, and everything bought is burned. Nothing else can authorise a trade.
 */
export interface BuybackInput {
  solBalance: number; // agent wallet SOL right now (after claiming fees)
  minutesSinceLastBuy: number | null;
  limits: {
    gasReserveSol: number; // always kept for transaction fees and token-account rent
    minBuySol: number; // wait until at least this much has accumulated (avoids dust trades)
    intervalMin: number; // minimum minutes between buybacks
  };
}

export type BuybackDecision = { action: "buy"; sol: number; reason: string } | { action: "skip"; reason: string };

const floor6 = (n: number) => Math.floor(n * 1e6) / 1e6;

/** SOL available to spend right now: everything above the gas reserve. */
export function spendable(i: BuybackInput): number {
  return Math.max(0, i.solBalance - i.limits.gasReserveSol);
}

export function decideBuyback(i: BuybackInput): BuybackDecision {
  const { limits } = i;
  if (i.minutesSinceLastBuy !== null && i.minutesSinceLastBuy < limits.intervalMin) {
    return {
      action: "skip",
      reason: `Waiting between buybacks: last one ${Math.round(i.minutesSinceLastBuy)} min ago (every ${limits.intervalMin} min at most).`,
    };
  }
  const sol = floor6(spendable(i));
  if (sol < limits.minBuySol) {
    return {
      action: "skip",
      reason: `Collecting creator fees: ${sol} SOL so far, buys back once ${limits.minBuySol} SOL is available.`,
    };
  }
  return { action: "buy", sol, reason: "Buying back with all collected creator fees, to burn." };
}

/** Smallest trade worth sending; anything below waits for the next run. */
export const MIN_TRADE_SOL = 0.005;

/**
 * Splits one buyback between the coin itself and the native coin so that, over the coin's whole history,
 * the native coin gets exactly `nativeShare` of all SOL spent (a skipped tiny native slice is caught up later).
 */
export function splitBuyback(opts: {
  total: number;
  nativeShare: number; // 0..1
  spentOwnSol: number; // all-time SOL spent buying the coin itself
  spentNativeSol: number; // all-time SOL spent buying the native coin
}): { own: number; native: number } {
  const share = Math.min(1, Math.max(0, opts.nativeShare));
  const total = floor6(Math.max(0, opts.total));
  if (share === 0 || total <= 0) return { own: total, native: 0 };
  const owed = share * (opts.spentOwnSol + opts.spentNativeSol + total) - opts.spentNativeSol;
  let native = floor6(Math.min(total, Math.max(0, owed)));
  let own = floor6(total - native);
  // Don't send dust: a slice too small to trade folds into the other one.
  if (native < MIN_TRADE_SOL) {
    own = total;
    native = 0;
  } else if (own < MIN_TRADE_SOL) {
    native = total;
    own = 0;
  }
  return { own, native };
}
