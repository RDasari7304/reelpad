import { createRequire } from "node:module";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config.js";
import { connection, lamports } from "./solana.js";

// Load the CommonJS build: the SDK's ES-module build (via @pump-fun/agent-payments-sdk) does
// `import { BN } from "@coral-xyz/anchor"`, which Node's ESM loader rejects at startup.
const require = createRequire(import.meta.url);
const { PUMP_SDK } = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");

/**
 * Builds the pump.fun create transaction.
 *
 * - `user` (the creator's wallet) pays and signs in the browser.
 * - `creator` is set to the coin's AGENT wallet, so pump.fun creator fees accrue to the agent treasury.
 * - The mint keypair partially signs here; the server never sees the user's key.
 * - One transaction also pays the platform fee and funds the agent wallet with gas.
 *
 * NOTE: this is the only call into @pump-fun/pump-sdk. If a future SDK version renames
 * createV2Instruction or its params, adjust `createInstruction` below.
 */
async function createInstruction(args: {
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  user: PublicKey;
}): Promise<TransactionInstruction> {
  const params = { ...args, mayhemMode: false };
  type Params = Parameters<typeof PUMP_SDK.createV2Instruction>[0];
  return await PUMP_SDK.createV2Instruction(params as unknown as Params);
}

export interface LaunchTx {
  /** base64 transaction, already signed by the mint keypair, awaiting the user's signature */
  transaction: string;
  message: Buffer;
  lastValidBlockHeight: number;
}

export async function buildLaunchTransaction(opts: {
  mint: Keypair;
  user: PublicKey;
  agent: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}): Promise<LaunchTx> {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.LAUNCH_PRIORITY_MICROLAMPORTS }),
    await createInstruction({
      mint: opts.mint.publicKey,
      name: opts.name,
      symbol: opts.symbol,
      uri: opts.uri,
      creator: opts.agent,
      user: opts.user,
    }),
  ];

  if (config.PLATFORM_FEE_SOL > 0) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: opts.user,
        toPubkey: new PublicKey(config.PLATFORM_FEE_WALLET),
        lamports: lamports(config.PLATFORM_FEE_SOL),
      }),
    );
  }
  if (config.AGENT_GAS_FUND_SOL > 0) {
    ixs.push(
      SystemProgram.transfer({ fromPubkey: opts.user, toPubkey: opts.agent, lamports: lamports(config.AGENT_GAS_FUND_SOL) }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: opts.user,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([opts.mint]);

  return {
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    message: Buffer.from(message.serialize()),
    lastValidBlockHeight,
  };
}
