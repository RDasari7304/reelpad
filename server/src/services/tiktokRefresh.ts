import { one, query } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { openString, seal } from "../lib/secrets.js";
import { refreshToken, TikTokError } from "./tiktok.js";

/**
 * Refreshes one coin's TikTok access token with its refresh token (valid for a year, and TikTok may
 * rotate it). Returns the new access token, or null when the connection is gone and the creator has
 * to log in again (the account is then marked expired).
 */
export async function refreshAccount(coinId: string): Promise<{ token: string; expiresAt: Date } | null> {
  const row = await one<{ refresh_token_enc: string | null; refresh_expires_at: Date | null }>(
    `SELECT refresh_token_enc, refresh_expires_at FROM tiktok_accounts WHERE coin_id = $1 AND status = 'active'`,
    [coinId],
  );
  if (!row?.refresh_token_enc || (row.refresh_expires_at && row.refresh_expires_at < new Date())) {
    await query(`UPDATE tiktok_accounts SET status = 'expired' WHERE coin_id = $1 AND status = 'active'`, [coinId]);
    return null;
  }
  try {
    const t = await refreshToken(openString(row.refresh_token_enc));
    await query(
      `UPDATE tiktok_accounts SET token_enc = $2, token_expires_at = $3, refresh_token_enc = $4, refresh_expires_at = $5,
              last_refreshed_at = now() WHERE coin_id = $1`,
      [coinId, seal(t.token), t.expiresAt, seal(t.refreshToken), t.refreshExpiresAt],
    );
    return { token: t.token, expiresAt: t.expiresAt };
  } catch (e) {
    logger.warn({ coinId, err: (e as Error).message }, "tiktok token refresh failed");
    if (e instanceof TikTokError && e.isAuth) {
      await query(`UPDATE tiktok_accounts SET status = 'expired' WHERE coin_id = $1`, [coinId]);
      return null;
    }
    throw e;
  }
}

/**
 * TikTok access tokens last 24 hours. Every few minutes the worker refreshes the ones that run out
 * within the next 2 hours, so active coins never lose their connection.
 */
export async function refreshExpiringTokens() {
  const rows = await query<{ coin_id: string }>(
    `SELECT coin_id FROM tiktok_accounts
     WHERE status = 'active' AND token_expires_at < now() + interval '2 hours'
       AND last_refreshed_at < now() - interval '5 minutes'
     ORDER BY token_expires_at LIMIT 100`,
  );
  for (const row of rows.rows) await refreshAccount(row.coin_id).catch(() => {});
  await query(`UPDATE tiktok_accounts SET status = 'expired' WHERE status = 'active' AND refresh_expires_at < now()`);
}
