import { one } from "../db/pool.js";

export interface AccessRequestView {
  username: string;
  status: "pending" | "invited" | "connected";
  requestedAt: Date;
  invitedAt: Date | null;
}

/**
 * Creates or updates a coin's TikTok sandbox (target user) request.
 * Re-submitting the same username keeps its progress; a different username starts over as pending.
 */
export async function upsertAccessRequest(coinId: string, username: string): Promise<AccessRequestView> {
  const row = await one<{ username: string; status: AccessRequestView["status"]; requested_at: Date; invited_at: Date | null }>(
    `INSERT INTO tiktok_access_requests(coin_id, username) VALUES ($1, $2)
     ON CONFLICT (coin_id) DO UPDATE SET
       status = CASE WHEN tiktok_access_requests.username = EXCLUDED.username THEN tiktok_access_requests.status ELSE 'pending' END,
       invited_at = CASE WHEN tiktok_access_requests.username = EXCLUDED.username THEN tiktok_access_requests.invited_at ELSE NULL END,
       requested_at = CASE WHEN tiktok_access_requests.username = EXCLUDED.username THEN tiktok_access_requests.requested_at ELSE now() END,
       username = EXCLUDED.username
     RETURNING username, status, requested_at, invited_at`,
    [coinId, username],
  );
  return { username: row!.username, status: row!.status, requestedAt: row!.requested_at, invitedAt: row!.invited_at };
}
