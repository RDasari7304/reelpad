import { Keypair, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { isSlippageError } from "../domain/tradeErrors.js";
import { logger } from "../lib/logger.js";
import { agentBuyPumpPortal } from "./pumpportal.js";
import { signAndSendVersioned, WSOL_MINT } from "./solana.js";

/**
 * Buying a coin with the agent wallet's SOL.
 *
 * Graduated coins (trading on PumpSwap) go through Jupiter first: it quotes PumpSwap with the current
 * fee schedule and sets slippage itself, which fixes the "exceeded slippage" failures PumpPortal's
 * PumpSwap transactions were hitting. Coins still on the bonding curve go through PumpPortal first.
 * Either way, if the first route fails the other one is tried.
 */
const JUP_BASE = () => (config.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
const jupHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(config.JUPITER_API_KEY ? { "x-api-key": config.JUPITER_API_KEY } : {}),
});

async function jupiterBuy(agent: Keypair, mint: PublicKey, sol: number): Promise<string> {
  const lamports = Math.floor(sol * 1e9);
  const q = new URL(`${JUP_BASE()}/quote`);
  q.searchParams.set("inputMint", WSOL_MINT);
  q.searchParams.set("outputMint", mint.toBase58());
  q.searchParams.set("amount", String(lamports));
  q.searchParams.set("slippageBps", String(Math.round(config.PUMPPORTAL_SLIPPAGE * 100)));
  q.searchParams.set("restrictIntermediateTokens", "true");
  const qr = await fetch(q, { headers: jupHeaders() });
  if (!qr.ok) throw new Error(`Jupiter quote failed (${qr.status}): ${(await qr.text()).slice(0, 200)}`);
  const quote = await qr.json();

  const sr = await fetch(`${JUP_BASE()}/swap`, {
    method: "POST",
    headers: jupHeaders(),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: agent.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // Jupiter simulates the swap and picks a slippage that will land, within sane bounds.
      dynamicSlippage: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "veryHigh" } },
    }),
  });
  if (!sr.ok) throw new Error(`Jupiter swap failed (${sr.status}): ${(await sr.text()).slice(0, 200)}`);
  const { swapTransaction } = (await sr.json()) as { swapTransaction?: string };
  if (!swapTransaction) throw new Error("Jupiter returned no transaction");
  return signAndSendVersioned(new Uint8Array(Buffer.from(swapTransaction, "base64")), [agent]);
}

export interface Bought {
  sig: string;
  sol: number;
  via: "jupiter" | "pumpportal";
}

/** Buys `sol` worth of `mint` with the agent wallet; tries the best route for the coin, then the other. */
export async function buyToken(agent: Keypair, mint: PublicKey, sol: number, graduated: boolean): Promise<Bought> {
  const viaJupiter = async (): Promise<Bought> => ({ sig: await jupiterBuy(agent, mint, sol), sol, via: "jupiter" });
  const viaPumpPortal = async (): Promise<Bought> => ({ ...(await agentBuyPumpPortal(agent, mint, sol, graduated)), via: "pumpportal" });
  const routes = graduated ? [viaJupiter, viaPumpPortal] : [viaPumpPortal, viaJupiter];
  let first: unknown;
  for (const [i, route] of routes.entries()) {
    try {
      return await route();
    } catch (e) {
      first ??= e;
      logger.warn({ mint: mint.toBase58(), route: i === 0 ? "primary" : "fallback", err: (e as Error).message.slice(0, 300) }, "buy route failed");
      // A transaction that may have landed must never be sent twice through another route.
      if (/timed out|not confirmed|unknown status/i.test((e as Error).message) && !isSlippageError((e as Error).message)) throw e;
    }
  }
  throw first ?? new Error("Buy failed");
}
