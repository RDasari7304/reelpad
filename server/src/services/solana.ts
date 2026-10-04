import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config.js";

export const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");

export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const sol = (lamports: number | bigint) => Number(lamports) / LAMPORTS_PER_SOL;
export const lamports = (solAmount: number) => Math.round(solAmount * LAMPORTS_PER_SOL);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Broadcast a signed transaction and keep re-sending until it confirms or its blockhash expires.
 */
export async function sendAndConfirmRaw(raw: Uint8Array, lastValidBlockHeight?: number): Promise<string> {
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
  const lvbh = lastValidBlockHeight ?? (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;

  while (true) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return signature;
    }
    const height = await connection.getBlockHeight("confirmed");
    if (height > lvbh) throw new Error(`Transaction expired before confirming (${signature})`);
    await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(2000);
  }
}

export async function signAndSendVersioned(bytes: Uint8Array, signers: Keypair[]): Promise<string> {
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign(signers);
  return sendAndConfirmRaw(tx.serialize());
}

export async function signAndSendLegacy(tx: Transaction, signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  return sendAndConfirmRaw(tx.serialize(), lastValidBlockHeight);
}

export async function getSolBalance(owner: PublicKey): Promise<number> {
  return sol(await connection.getBalance(owner, "confirmed"));
}

export async function getTokenBalance(owner: PublicKey, mint: PublicKey) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  let raw = 0n;
  let decimals = 6;
  let account: PublicKey | null = null;
  const accounts: Array<{ pubkey: PublicKey; raw: bigint }> = [];
  for (const acc of res.value) {
    const info = (acc.account.data as any).parsed?.info?.tokenAmount;
    if (!info) continue;
    const amount = BigInt(info.amount);
    raw += amount;
    decimals = info.decimals;
    account ??= acc.pubkey;
    if (amount > 0n) accounts.push({ pubkey: acc.pubkey, raw: amount });
  }
  return { raw, decimals, ui: Number(raw) / 10 ** decimals, account, accounts };
}

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}

/**
 * Reads the pump.fun bonding curve account directly.
 * Layout: 8-byte discriminator, then u64 virtual_token_reserves, u64 virtual_sol_reserves,
 * u64 real_token_reserves, u64 real_sol_reserves, u64 token_total_supply, bool complete.
 */
export async function readBondingCurve(mint: PublicKey) {
  const info = await connection.getAccountInfo(bondingCurvePda(mint), "confirmed");
  if (!info || info.data.length < 49) return null;
  const d = info.data;
  const virtualTokenReserves = d.readBigUInt64LE(8);
  const virtualSolReserves = d.readBigUInt64LE(16);
  const complete = d.readUInt8(48) === 1;
  return { virtualTokenReserves, virtualSolReserves, complete };
}

/** Price in SOL per whole token. Uses the bonding curve, or Jupiter once the coin has graduated. */
export async function getPriceSol(mint: PublicKey): Promise<{ priceSol: number; graduated: boolean } | null> {
  const curve = await readBondingCurve(mint);
  if (curve && !curve.complete && curve.virtualTokenReserves > 0n) {
    const priceSol = sol(curve.virtualSolReserves) / (Number(curve.virtualTokenReserves) / 1e6);
    return { priceSol, graduated: false };
  }
  try {
    const ids = `${mint.toBase58()},${WSOL_MINT}`;
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { usdPrice?: number }>;
    const tokenUsd = json[mint.toBase58()]?.usdPrice;
    const solUsd = json[WSOL_MINT]?.usdPrice;
    if (!tokenUsd || !solUsd) return null;
    return { priceSol: tokenUsd / solUsd, graduated: true };
  } catch {
    return null;
  }
}
