import { Keypair, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { chunkAmounts } from "../domain/tradeErrors.js";
import { logger } from "../lib/logger.js";
import { agentBuyPumpPortal } from "./pumpportal.js";
import { signAndSendVersioned, WSOL_MINT } from "./solana.js";

/**
 * Buying a coin with the agent wallet's SOL.
 *
 * - Large amounts go out in pieces (TRADE_CHUNK_SOL each), so no single trade moves a thin pool so far
 *   that it fails on slippage, and a sandwich bot gets less from any one trade.
 * - Graduated coins (PumpSwap) go through Jupiter: first with Jupiter's automatic slippage, then with
 *   fixed 15% and 30% if the price moved. PumpPortal is the last resort.
 * - Coins still on the bonding curve go through PumpPortal first, then Jupiter.
 * - If some pieces land and a later one fails, what was bought is returned (and burned); the rest of the
 *   SOL simply waits for the next run.
 */
const JUP_BASE = () => (config.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
const jupHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(config.JUPITER_API_KEY ? { "x-api-key": config.JUPITER_API_KEY } : {}),
});

/** slippageBps = null → Jupiter's dynamic slippage. */
async function jupiterBuy(agent: Keypair, mint: PublicKey, sol: number, slippageBps: number | null): Promise<string> {
  const lamports = Math.floor(sol * 1e9);
  const q = new URL(`${JUP_BASE()}/quote`);
  q.searchParams.set("inputMint", WSOL_MINT);
  q.searchParams.set("outputMint", mint.toBase58());
  q.searchParams.set("amount", String(lamports));
  q.searchParams.set("slippageBps", String(slippageBps ?? Math.round(config.PUMPPORTAL_SLIPPAGE * 100)));
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
      ...(slippageBps === null ? { dynamicSlippage: true } : {}),
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "veryHigh" } },
    }),
  });
  if (!sr.ok) throw new Error(`Jupiter swap failed (${sr.status}): ${(await sr.text()).slice(0, 200)}`);
  const { swapTransaction } = (await sr.json()) as { swapTransaction?: string };
  if (!swapTransaction) throw new Error("Jupiter returned no transaction");
  return signAndSendVersioned(new Uint8Array(Buffer.from(swapTransaction, "base64")), [agent]);
}

export interface Fill {
  sig: string;
  sol: number;
  via: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One piece: try each route in order until one lands. */
async function buyPiece(agent: Keypair, mint: PublicKey, sol: number, graduated: boolean): Promise<Fill> {
  const jup = (bps: number | null) => async (): Promise<Fill> => ({
    sig: await jupiterBuy(agent, mint, sol, bps),
    sol,
    via: bps === null ? "jupiter" : `jupiter ${bps / 100}%`,
  });
  const pp = async (): Promise<Fill> => ({ ...(await agentBuyPumpPortal(agent, mint, sol, graduated)), via: "pumpportal" });
  const routes = graduated ? [jup(null), jup(1500), jup(3000), pp] : [pp, jup(1500), jup(3000)];
  let first: unknown;
  for (const route of routes) {
    try {
      return await route();
    } catch (e) {
      first ??= e;
      logger.warn({ mint: mint.toBase58(), sol, err: (e as Error).message.slice(0, 300) }, "buy route failed, trying the next");
    }
  }
  throw first ?? new Error("Buy failed");
}

/** Buys `sol` worth of `mint`, in pieces. Returns every piece that landed; throws only if none did. */
export async function buyToken(agent: Keypair, mint: PublicKey, sol: number, graduated: boolean): Promise<Fill[]> {
  const fills: Fill[] = [];
  for (const [i, piece] of chunkAmounts(sol, config.TRADE_CHUNK_SOL).entries()) {
    if (i > 0) await sleep(3000); // let the pool settle between pieces
    try {
      fills.push(await buyPiece(agent, mint, piece, graduated));
    } catch (e) {
      if (!fills.length) throw e;
      logger.warn({ mint: mint.toBase58(), bought: fills.length, err: (e as Error).message.slice(0, 200) }, "stopped after a partial buy");
      break;
    }
  }
  return fills;
}
