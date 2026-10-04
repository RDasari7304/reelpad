/**
 * Pure decision logic for the automatic buyback-and-burn treasury. No I/O, fully unit-tested.
 *
 * Every coin's agent wallet receives the coin's pump.fun creator fees. On each run the agent spends
 * the SOL above its gas reserve on buying the coin back (the bought coins are then burned),
 * within platform-wide caps. Nothing else can authorise a trade.
 */
export interface BuybackInput {
  solBalance: number; // agent wallet SOL right now (after claiming fees)
  spentTodaySol: number; // SOL spent on buybacks in the last 24h
  minutesSinceLastBuy: number | null;
  limits: {
    gasReserveSol: number; // always kept for transaction fees and token-account rent
    minBuySol: number; // wait until at least this much has accumulated (avoids dust trades)
    maxSolPerBuy: number;
    maxSolPerDay: number;
    intervalMin: number; // minimum minutes between buybacks
  };
}

export type BuybackDecision = { action: "buy"; sol: number; reason: string } | { action: "skip"; reason: string };

const floor6 = (n: number) => Math.floor(n * 1e6) / 1e6;

/** SOL available to spend right now, after the gas reserve and the caps. */
export function spendable(i: BuybackInput): number {
  const aboveReserve = i.solBalance - i.limits.gasReserveSol;
  const dailyLeft = i.limits.maxSolPerDay - i.spentTodaySol;
  return Math.max(0, Math.min(aboveReserve, dailyLeft, i.limits.maxSolPerBuy));
}

export function decideBuyback(i: BuybackInput): BuybackDecision {
  const { limits } = i;
  if (i.minutesSinceLastBuy !== null && i.minutesSinceLastBuy < limits.intervalMin) {
    return {
      action: "skip",
      reason: `Waiting between buybacks: last one ${Math.round(i.minutesSinceLastBuy)} min ago (every ${limits.intervalMin} min at most).`,
    };
  }
  if (i.spentTodaySol >= limits.maxSolPerDay - 1e-9) {
    return { action: "skip", reason: `Daily buyback limit reached (${limits.maxSolPerDay} SOL). Fees carry over to tomorrow.` };
  }
  const sol = floor6(spendable(i));
  if (sol < limits.minBuySol) {
    const accumulated = Math.max(0, i.solBalance - limits.gasReserveSol);
    return {
      action: "skip",
      reason: `Collecting creator fees: ${floor6(accumulated)} SOL so far, buys back once ${limits.minBuySol} SOL is available.`,
    };
  }
  return { action: "buy", sol, reason: "Buying back with collected creator fees, to burn." };
}
