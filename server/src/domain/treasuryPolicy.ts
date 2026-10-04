/**
 * Pure decision logic for the treasury agent. No I/O, fully unit-tested.
 * Every SOL amount the agent may spend passes through these caps; nothing else can authorise a trade.
 */
export type Strategy = "hold" | "dip_buyback" | "steady_buyback" | "buy_and_burn";

export interface PolicyInput {
  strategy: Strategy;
  user: { maxSolPerAction: number; maxSolPerDay: number; reserveSol: number; dipPct: number; intervalMin: number };
  platform: { maxSolPerAction: number; maxSolPerDay: number; gasReserveSol: number; minIntervalMin: number };
  solBalance: number;
  spentTodaySol: number;
  minutesSinceLastBuy: number | null;
  priceNow: number | null;
  priceHigh24h: number | null;
}

export type Decision = { action: "buy"; sol: number; reason: string } | { action: "skip"; reason: string };

const MIN_TRADE_SOL = 0.001;
const round6 = (n: number) => Math.floor(n * 1e6) / 1e6;

export function spendCap(i: PolicyInput): number {
  const spendable = i.solBalance - Math.max(i.user.reserveSol, 0) - i.platform.gasReserveSol;
  const dailyLeft = Math.min(i.user.maxSolPerDay, i.platform.maxSolPerDay) - i.spentTodaySol;
  const perAction = Math.min(i.user.maxSolPerAction, i.platform.maxSolPerAction);
  return Math.max(0, Math.min(spendable, dailyLeft, perAction));
}

export function decide(i: PolicyInput): Decision {
  if (i.strategy === "hold") return { action: "skip", reason: "Strategy is hold: the treasury only collects fees." };

  const interval = Math.max(i.user.intervalMin, i.platform.minIntervalMin);
  if (i.minutesSinceLastBuy !== null && i.minutesSinceLastBuy < interval) {
    return { action: "skip", reason: `Cooling down: last buy ${Math.round(i.minutesSinceLastBuy)} min ago (interval ${interval} min).` };
  }

  const cap = spendCap(i);
  if (cap < MIN_TRADE_SOL) {
    const dailyLimit = Math.min(i.user.maxSolPerDay, i.platform.maxSolPerDay);
    const reason =
      i.spentTodaySol >= dailyLimit - MIN_TRADE_SOL
        ? `Daily limit reached (${dailyLimit} SOL).`
        : `Not enough SOL above the ${i.user.reserveSol} SOL reserve.`;
    return { action: "skip", reason };
  }

  let size: number;
  let why: string;
  if (i.strategy === "dip_buyback") {
    if (!i.priceNow || !i.priceHigh24h || i.priceHigh24h <= 0) {
      return { action: "skip", reason: "Not enough price history yet to detect a dip." };
    }
    const drop = ((i.priceHigh24h - i.priceNow) / i.priceHigh24h) * 100;
    if (drop < i.user.dipPct) {
      return { action: "skip", reason: `Price is ${drop.toFixed(1)}% below the 24h high; waiting for a ${i.user.dipPct}% dip.` };
    }
    const scale = Math.min(1, Math.max(0.5, drop / (i.user.dipPct * 2)));
    size = cap * scale;
    why = `Price dipped ${drop.toFixed(1)}% from the 24h high.`;
  } else {
    // steady_buyback and buy_and_burn: small regular buys, at most a quarter of what is spendable.
    const spendable = i.solBalance - i.user.reserveSol - i.platform.gasReserveSol;
    size = Math.min(cap, spendable * 0.25);
    why = i.strategy === "buy_and_burn" ? "Scheduled buy-and-burn." : "Scheduled steady buyback.";
  }

  size = round6(size);
  if (size < MIN_TRADE_SOL) return { action: "skip", reason: "Buy size below the minimum trade size." };
  return { action: "buy", sol: size, reason: why };
}
