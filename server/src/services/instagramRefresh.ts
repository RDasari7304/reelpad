import { query } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { openString, seal } from "../lib/secrets.js";
import { InstagramError, refreshToken } from "./instagram.js";

/**
 * Long-lived Instagram tokens last 60 days and can be refreshed once they're 24h old.
 * Refresh weekly (or when within 10 days of expiry) so active coins never lose their connection.
 */
export async function refreshExpiringTokens() {
  const rows = await query<{ coin_id: string; token_enc: string }>(
    `SELECT coin_id, token_enc FROM instagram_accounts
     WHERE status = 'active' AND last_refreshed_at < now() - interval '24 hours'
       AND (last_refreshed_at < now() - interval '7 days' OR token_expires_at < now() + interval '10 days')
     LIMIT 100`,
  );
  for (const row of rows.rows) {
    try {
      const { token, expiresAt } = await refreshToken(openString(row.token_enc));
      await query(
        `UPDATE instagram_accounts SET token_enc = $2, token_expires_at = $3, last_refreshed_at = now() WHERE coin_id = $1`,
        [row.coin_id, seal(token), expiresAt],
      );
    } catch (e) {
      if (e instanceof InstagramError && e.isAuth) {
        await query(`UPDATE instagram_accounts SET status = 'expired' WHERE coin_id = $1`, [row.coin_id]);
      }
      logger.warn({ coinId: row.coin_id, err: (e as Error).message }, "instagram token refresh failed");
    }
  }
  await query(`UPDATE instagram_accounts SET status = 'expired' WHERE status = 'active' AND token_expires_at < now()`);
}
