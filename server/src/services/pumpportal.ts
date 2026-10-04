import { Keypair, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
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
export async function buildBuyTx(wallet: PublicKey, mint: PublicKey, solAmount: number, pool = "pump") {
  return tradeLocal({
    publicKey: wallet.toBase58(),
    action: "buy",
    mint: mint.toBase58(),
    denominatedInSol: "true",
    amount: solAmount,
    slippage: config.PUMPPORTAL_SLIPPAGE,
    priorityFee: config.PUMPPORTAL_PRIORITY_FEE,
    pool,
  });
}

/** Agent buys its own coin with SOL. */
export async function agentBuy(agent: Keypair, mint: PublicKey, solAmount: number): Promise<string> {
  const bytes = await buildBuyTx(agent.publicKey, mint, solAmount, "auto");
  return signAndSendVersioned(bytes, [agent]);
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
