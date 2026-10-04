import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { instagramUsernameSchema } from "../domain/schemas.js";
import { upsertAccessRequest } from "../services/instagramAccess.js";
import { getKillSwitch, setKillSwitch } from "../services/settings.js";
import { todaySpend } from "../services/spend.js";
import { requireAdmin } from "./auth.js";
import { asyncHandler, HttpError } from "./util.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const [counts, posts, failedJobs, recentFailures] = await Promise.all([
      query(`SELECT status, count(*)::int AS n FROM coins GROUP BY status`),
      query(`SELECT status, count(*)::int AS n FROM posts WHERE created_at > now() - interval '24 hours' GROUP BY status`),
      query(`SELECT type, count(*)::int AS n FROM jobs WHERE status = 'failed' AND updated_at > now() - interval '24 hours' GROUP BY type`),
      query(
        `SELECT id, type, last_error, updated_at FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20`,
      ),
    ]);
    res.json({
      killSwitch: await getKillSwitch(),
      aiSpendToday: await todaySpend(),
      aiBudget: config.DAILY_AI_BUDGET_USD,
      treasuryDryRun: config.TREASURY_DRY_RUN,
      igAccessMode: config.IG_ACCESS_MODE,
      coins: counts.rows,
      posts24h: posts.rows,
      failedJobs24h: failedJobs.rows,
      recentFailures: recentFailures.rows,
    });
  }),
);

adminRouter.post(
  "/kill-switch",
  asyncHandler(async (req, res) => {
    const patch = z
      .object({ content: z.boolean().optional(), treasury: z.boolean().optional(), launches: z.boolean().optional() })
      .parse(req.body);
    res.json({ killSwitch: await setKillSwitch(patch) });
  }),
);

type AccessState = "none" | "pending" | "invited" | "connected" | "expired" | "disconnected";

function accessState(r: { req_status: string | null; ig_status: string | null }): AccessState {
  if (r.ig_status === "active") return "connected";
  if (r.ig_status === "expired") return "expired";
  if (r.ig_status === "revoked") return "disconnected";
  if (r.req_status === "pending" || r.req_status === "invited") return r.req_status;
  return "none";
}

/**
 * Every coin created so far, with its creator and where it is in the Instagram access flow.
 * Used to add creators as Instagram Testers by hand while the Meta app is unapproved.
 */
adminRouter.get(
  "/coins",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim()}%` : null;
    const [rows, testers] = await Promise.all([
      query(
        `SELECT c.id, c.name, c.symbol, c.image_url, c.mint, c.creator_wallet, c.status, c.created_at, c.launched_at,
                r.username AS req_username, r.status AS req_status, r.requested_at, r.invited_at,
                i.username AS ig_username, i.status AS ig_status
         FROM coins c
         LEFT JOIN instagram_access_requests r ON r.coin_id = c.id
         LEFT JOIN instagram_accounts i ON i.coin_id = c.id
         WHERE ($1::text IS NULL OR c.name ILIKE $1 OR c.symbol ILIKE $1 OR c.creator_wallet ILIKE $1
                OR r.username ILIKE $1 OR i.username ILIKE $1 OR c.mint ILIKE $1)
         ORDER BY c.created_at DESC
         LIMIT 500`,
        [q],
      ),
      query<{ n: number }>(`SELECT count(*)::int AS n FROM instagram_access_requests WHERE status IN ('invited','connected')`),
    ]);
    res.json({
      accessMode: config.IG_ACCESS_MODE,
      metaRolesUrl: config.META_APP_ID
        ? `https://developers.facebook.com/apps/${encodeURIComponent(config.META_APP_ID)}/roles/roles/`
        : "https://developers.facebook.com/apps/",
      testersUsed: testers.rows[0]?.n ?? 0,
      coins: rows.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        imageUrl: r.image_url,
        mint: r.mint,
        creatorWallet: r.creator_wallet,
        status: r.status,
        createdAt: r.created_at,
        launchedAt: r.launched_at,
        access: {
          state: accessState(r),
          username: r.ig_status === "active" ? r.ig_username : (r.req_username ?? r.ig_username ?? null),
          requestedAt: r.requested_at,
          invitedAt: r.invited_at,
        },
      })),
    });
  }),
);

/** Admin sets or corrects a coin's Instagram username (e.g. the creator sent it by DM). */
adminRouter.put(
  "/coins/:id/instagram-access",
  asyncHandler(async (req, res) => {
    const coinId = z.string().uuid().parse(req.params.id);
    const { username } = z.object({ username: instagramUsernameSchema }).parse(req.body);
    const exists = await query(`SELECT 1 FROM coins WHERE id = $1`, [coinId]);
    if (!exists.rowCount) throw new HttpError(404, "Coin not found");
    res.json({ instagramAccess: await upsertAccessRequest(coinId, username) });
  }),
);

adminRouter.post(
  "/instagram-requests/:coinId/invited",
  asyncHandler(async (req, res) => {
    const coinId = z.string().uuid().parse(req.params.coinId);
    const { invited } = z.object({ invited: z.boolean().default(true) }).parse(req.body ?? {});
    await query(
      `UPDATE instagram_access_requests SET status = $2, invited_at = CASE WHEN $2 = 'invited' THEN now() ELSE NULL END
       WHERE coin_id = $1 AND status <> 'connected'`,
      [coinId, invited ? "invited" : "pending"],
    );
    res.json({ ok: true });
  }),
);

adminRouter.post(
  "/coins/:id/pause",
  asyncHandler(async (req, res) => {
    const { content, treasury } = z.object({ content: z.boolean(), treasury: z.boolean() }).parse(req.body);
    await query(`UPDATE coins SET content_paused = $2, treasury_paused = $3 WHERE id = $1`, [req.params.id, content, treasury]);
    res.json({ ok: true });
  }),
);
