import { config } from "../config.js";
import { coinPageUrl } from "../domain/links.js";
import { one, query } from "../db/pool.js";
import { openString } from "../lib/secrets.js";
import type { ContentSettings, Persona } from "../domain/schemas.js";

export interface CoinRow {
  id: string;
  creator_wallet: string;
  name: string;
  symbol: string;
  description: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  image_url: string;
  image_ipfs: string;
  metadata_uri: string | null;
  mint: string | null;
  mint_secret_enc: string | null;
  agent_pubkey: string;
  agent_secret_enc: string;
  status: "draft" | "awaiting_signature" | "launching" | "live" | "failed";
  launch_error: string | null;
  launch_tx_sig: string | null;
  pending_message: Buffer | null;
  pending_last_valid_height: string | null;
  dev_buy_sol: string;
  persona: Persona;
  content_settings: ContentSettings;
  treasury_settings: Record<string, unknown>; // legacy; treasury is now automatic buyback-and-burn
  content_paused: boolean;
  treasury_paused: boolean;
  next_post_at: Date | null;
  last_treasury_run_at: Date | null;
  activity_state: "active" | "cooling" | "dormant";
  volume_24h_usd: string | null;
  mcap_usd: string | null;
  activity_changed_at: Date | null;
  created_at: Date;
  launched_at: Date | null;
}

export async function getCoin(id: string): Promise<CoinRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<CoinRow>(`SELECT * FROM coins WHERE id = $1`, [id]);
}

export async function getCoinByIdOrMint(key: string): Promise<CoinRow | null> {
  if (/^[0-9a-f-]{36}$/i.test(key)) return getCoin(key);
  return one<CoinRow>(`SELECT * FROM coins WHERE mint = $1`, [key]);
}

export interface IgAccount {
  igUserId: string;
  username: string;
  token: string;
  expiresAt: Date;
  status: string;
}

export async function getInstagram(coinId: string): Promise<IgAccount | null> {
  const row = await one<{ ig_user_id: string; username: string; token_enc: string; token_expires_at: Date; status: string }>(
    `SELECT ig_user_id, username, token_enc, token_expires_at, status FROM instagram_accounts WHERE coin_id = $1`,
    [coinId],
  );
  if (!row) return null;
  return {
    igUserId: row.ig_user_id,
    username: row.username,
    token: openString(row.token_enc),
    expiresAt: row.token_expires_at,
    status: row.status,
  };
}

export async function markInstagramExpired(coinId: string) {
  await query(`UPDATE instagram_accounts SET status = 'expired' WHERE coin_id = $1`, [coinId]);
}

/** Public representation: never includes encrypted secrets or pending transaction bytes. */
export function publicCoin(c: CoinRow, extra: Record<string, unknown> = {}) {
  return {
    id: c.id,
    creatorWallet: c.creator_wallet,
    name: c.name,
    symbol: c.symbol,
    description: c.description,
    website: c.website ?? (c.mint ? coinPageUrl(config.PUBLIC_URL, c.mint) : null),
    activity: c.activity_state ?? "active",
    activityChangedAt: c.activity_changed_at ?? null,
    twitter: c.twitter,
    telegram: c.telegram,
    imageUrl: c.image_url,
    metadataUri: c.metadata_uri,
    mint: c.mint,
    agentWallet: c.agent_pubkey,
    status: c.status,
    launchError: c.launch_error,
    launchTxSig: c.launch_tx_sig,
    persona: c.persona,
    contentSettings: c.content_settings,
    contentPaused: c.content_paused,
    treasuryPaused: c.treasury_paused,
    nextPostAt: c.next_post_at,
    createdAt: c.created_at,
    launchedAt: c.launched_at,
    ...extra,
  };
}
