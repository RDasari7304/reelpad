import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { config } from "../config.js";
import { one, query } from "../db/pool.js";
import type { CoinDraft } from "../domain/schemas.js";
import { logger } from "../lib/logger.js";
import { openKeypair, sealKeypair } from "../lib/secrets.js";
import { getCoin, type CoinRow } from "./coins.js";
import { pinImage, pinMetadata } from "./ipfs.js";
import { normaliseTokenImage } from "./media.js";
import { coinWebsite } from "../domain/links.js";
import { buildLaunchTransaction } from "./pump.js";
import { connection, sendAndConfirmRaw } from "./solana.js";
import { mediaKey, putObject } from "./storage.js";

export class LaunchError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** Step 1: store the draft, image (IPFS + public CDN) and generate the agent + mint keypairs. */
export async function createDraft(wallet: string, draft: CoinDraft, image: Buffer): Promise<CoinRow> {
  const png = await normaliseTokenImage(image);
  const agent = Keypair.generate();
  const mint = Keypair.generate();

  // Every treasury runs the same automatic buyback-and-burn; nothing for the creator to configure.
  const ts = { mode: "buyback_burn" };

  // Insert first to get the coin id for the storage path.
  const row = await one<CoinRow>(
    `INSERT INTO coins(creator_wallet, name, symbol, description, website, twitter, telegram,
                       image_url, image_ipfs, agent_pubkey, agent_secret_enc, mint, mint_secret_enc,
                       persona, content_settings, treasury_settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','pending',$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      wallet,
      draft.name,
      draft.symbol,
      draft.description,
      coinWebsite(config.PUBLIC_URL, mint.publicKey.toBase58(), draft.tiktokUsername), // the influencer's TikTok
      draft.twitter ?? null,
      draft.telegram ?? null,
      agent.publicKey.toBase58(),
      sealKeypair(agent),
      mint.publicKey.toBase58(),
      sealKeypair(mint),
      JSON.stringify(draft.persona),
      JSON.stringify(draft.contentSettings),
      JSON.stringify(ts),
    ],
  );
  const coin = row!;
  try {
    const [imageUrl, ipfs] = await Promise.all([putObject(mediaKey(coin.id, "png"), png, "image/png"), pinImage(png, "image/png")]);
    if (draft.tiktokUsername) {
      await query(`INSERT INTO tiktok_access_requests(coin_id, username) VALUES ($1, $2) ON CONFLICT (coin_id) DO NOTHING`, [
        coin.id,
        draft.tiktokUsername,
      ]);
    }
    return (await one<CoinRow>(`UPDATE coins SET image_url = $2, image_ipfs = $3 WHERE id = $1 RETURNING *`, [coin.id, imageUrl, ipfs]))!;
  } catch (e) {
    await query(`DELETE FROM coins WHERE id = $1`, [coin.id]);
    throw e;
  }
}

/** Step 2: pin metadata and build the create transaction for the creator to sign. */
export async function prepareLaunch(coin: CoinRow, wallet: string) {
  if (coin.creator_wallet !== wallet) throw new LaunchError("Not your coin", 403);
  if (!["draft", "awaiting_signature", "failed"].includes(coin.status)) throw new LaunchError(`Coin is already ${coin.status}`);
  if (!coin.mint_secret_enc) throw new LaunchError("Mint key missing");

  // The website is the influencer's TikTok profile (or the Reelpad page if no account was given),
  // fixed at launch. Re-pin if the username changed before launch.
  const access = await one<{ username: string }>(`SELECT username FROM tiktok_access_requests WHERE coin_id = $1`, [coin.id]);
  const website = coinWebsite(config.PUBLIC_URL, coin.mint!, access?.username);
  const metadataUri =
    (coin.metadata_uri && coin.website === website ? coin.metadata_uri : null) ??
    (await pinMetadata({
      name: coin.name,
      symbol: coin.symbol,
      description: coin.description,
      image: coin.image_ipfs,
      website,
      tiktok: access?.username ? website : undefined,
      twitter: coin.twitter ?? undefined,
      telegram: coin.telegram ?? undefined,
    }));

  const built = await buildLaunchTransaction({
    mint: openKeypair(coin.mint_secret_enc),
    user: new PublicKey(wallet),
    agent: new PublicKey(coin.agent_pubkey),
    name: coin.name,
    symbol: coin.symbol,
    uri: metadataUri,
  });

  await query(
    `UPDATE coins SET metadata_uri = $2, status = 'awaiting_signature', pending_message = $3,
            pending_last_valid_height = $4, launch_error = NULL, website = $5 WHERE id = $1`,
    [coin.id, metadataUri, built.message, built.lastValidBlockHeight, website],
  );
  return {
    transaction: built.transaction,
    mint: coin.mint,
    fees: { platformSol: config.PLATFORM_FEE_SOL, agentGasSol: config.AGENT_GAS_FUND_SOL },
  };
}

/**
 * Step 3: receive the user-signed transaction, verify it is byte-for-byte the one we built,
 * then broadcast and confirm it.
 */
export async function submitLaunch(coinId: string, wallet: string, signedB64: string) {
  const coin = await getCoin(coinId);
  if (!coin) throw new LaunchError("Coin not found", 404);
  if (coin.creator_wallet !== wallet) throw new LaunchError("Not your coin", 403);
  if (coin.status !== "awaiting_signature" || !coin.pending_message) throw new LaunchError("No launch is awaiting signature");

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(signedB64, "base64"));
  } catch {
    throw new LaunchError("Malformed transaction");
  }
  const msg = Buffer.from(tx.message.serialize());
  if (!msg.equals(coin.pending_message)) throw new LaunchError("Transaction was modified after it was built");

  const keys = tx.message.staticAccountKeys;
  const userIdx = keys.findIndex((k) => k.toBase58() === wallet);
  const mintIdx = keys.findIndex((k) => k.toBase58() === coin.mint);
  if (userIdx < 0 || mintIdx < 0) throw new LaunchError("Transaction is missing required signers");
  const ok = (i: number, pk: string) => nacl.sign.detached.verify(msg, tx.signatures[i]!, new PublicKey(pk).toBytes());
  if (!ok(userIdx, wallet)) throw new LaunchError("Wallet signature is invalid");
  if (!ok(mintIdx, coin.mint!)) throw new LaunchError("Mint signature is invalid — rebuild the launch");

  const claimed = await one(
    `UPDATE coins SET status = 'launching' WHERE id = $1 AND status = 'awaiting_signature' RETURNING id`,
    [coinId],
  );
  if (!claimed) throw new LaunchError("Launch already in progress");

  const markLive = async (sig: string) => {
    await query(
      `UPDATE coins SET status = 'live', launch_tx_sig = $2, launched_at = now(), pending_message = NULL,
              mint_secret_enc = NULL, next_post_at = now() + interval '2 minutes' WHERE id = $1`,
      [coinId, sig],
    );
    logger.info({ coinId, sig, mint: coin.mint }, "coin launched");
    return { signature: sig, mint: coin.mint };
  };

  const expectedSig = bs58.encode(tx.signatures[0]!);
  try {
    const sig = await sendAndConfirmRaw(tx.serialize(), Number(coin.pending_last_valid_height ?? 0) || undefined);
    return await markLive(sig);
  } catch (e) {
    // Double-check: the transaction may have landed even though confirmation polling gave up.
    const st = await connection.getSignatureStatus(expectedSig, { searchTransactionHistory: true }).catch(() => null);
    if (st?.value && !st.value.err) return await markLive(expectedSig);
    const message = (e as Error).message;
    // A failed/expired create can be retried with a fresh blockhash; the mint key is kept until success.
    await query(`UPDATE coins SET status = 'failed', launch_error = $2, pending_message = NULL WHERE id = $1`, [
      coinId,
      message.slice(0, 500),
    ]);
    throw new LaunchError(`Launch failed: ${message}`, 502);
  }
}
