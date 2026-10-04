/**
 * Turns raw Solana/PumpPortal errors into one readable line for the Treasury tab, and spots
 * the errors worth retrying with a smaller buy.
 */
const SLIPPAGE = [
  /0x1774\b/i, // pump-amm (PumpSwap) 6004 ExceededSlippage
  /0x1772\b/i, // pump bonding curve 6002 TooMuchSolRequired
  /slippage/i,
  /TooMuchSolRequired/i,
];

export const isSlippageError = (msg: string) => SLIPPAGE.some((r) => r.test(msg));

export function friendlyTradeError(msg: string): string {
  if (isSlippageError(msg)) return "The price moved more than allowed during the buy (slippage), so it was cancelled. It retries later with a smaller amount.";
  if (/insufficient (funds|lamports)|0x1\b/i.test(msg)) return "Not enough SOL in the treasury for this buy and its fees.";
  if (/blockhash not found|block height exceeded|expired/i.test(msg)) return "The network was busy and the buy expired before it landed. It retries automatically.";
  if (/PumpPortal .* failed \((\d+)\)/i.test(msg)) return `The trading service couldn't build the buy (${msg.match(/\((\d+)\)/)?.[1]}). It retries automatically.`;
  const first = msg.split(/Logs:|\n/)[0]!.trim();
  return first.length > 200 ? `${first.slice(0, 197)}…` : first;
}

/** Attempts for one buyback: same size with more slippage, then smaller pieces. */
export function buyAttempts(sol: number, baseSlippage: number): Array<{ sol: number; slippage: number }> {
  const round = (n: number) => Math.floor(n * 1e4) / 1e4;
  return [
    { sol: round(sol), slippage: baseSlippage },
    { sol: round(sol), slippage: Math.max(baseSlippage, 30) },
    { sol: round(sol / 2), slippage: Math.max(baseSlippage, 30) },
    { sol: round(sol / 4), slippage: Math.max(baseSlippage, 40) },
  ].filter((a) => a.sol >= 0.005);
}
