import { Keypair, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { buyAttempts, isSlippageError } from "../domain/tradeErrors.js";
import { signAndSendVersioned } from "./solana.js";

/**
 * PumpPortal "local transaction" API: returns an unsigned transaction we sign ourselves.
 * Works for bonding-curve and graduated (PumpSwap) coins with pool "auto".
 * PumpPortal charges its own small fee on trades made through this API.
 */
async function tradeLocal(body: Record<string, unknown>): Promise<Uint8Array> {
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`PumpPortal ${body.action} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Unsigned buy transaction for any wallet (used for the creator's optional dev buy after launch). */
export async function buildBuyTx(wallet: PublicKey, mint: PublicKey, solAmount: number, pool = "pump", slippage = config.PUMPPORTAL_SLIPPAGE) {
  return tradeLocal({
    publicKey: wallet.toBase58(),
    action: "buy",
    mint: mint.toBase58(),
    denominatedInSol: "true",
    amount: solAmount,
    slippage,
    priorityFee: config.PUMPPORTAL_PRIORITY_FEE,
    pool,
  });
}

/**
 * Agent buys its own coin with SOL. Uses the bonding curve before graduation and PumpSwap after.
 * If the price moves too much (slippage), it retries with a little more room, then in smaller pieces,
 * and returns how much SOL it actually spent.
 */
export async function agentBuyPumpPortal(agent: Keypair, mint: PublicKey, solAmount: number, graduated: boolean): Promise<{ sig: string; sol: number }> {
  const pool = graduated ? "pump-amm" : "pump";
  let lastErr: unknown;
  for (const a of buyAttempts(solAmount, config.PUMPPORTAL_SLIPPAGE)) {
    try {
      const bytes = await buildBuyTx(agent.publicKey, mint, a.sol, pool, a.slippage);
      return { sig: await signAndSendVersioned(bytes, [agent]), sol: a.sol };
    } catch (e) {
      lastErr = e;
      if (!isSlippageError((e as Error).message)) throw e;
    }
  }
  throw lastErr ?? new Error("Buy failed");
}

/** Claims all pump.fun creator fees owed to the agent wallet (pump.fun claims across coins at once). */
export async function agentCollectCreatorFees(agent: Keypair): Promise<string> {
  const bytes = await tradeLocal({
    publicKey: agent.publicKey.toBase58(),
    action: "collectCreatorFee",
    pool: "pump",
    priorityFee: config.PUMPPORTAL_PRIORITY_FEE,
  });
  return signAndSendVersioned(bytes, [agent]);
}
