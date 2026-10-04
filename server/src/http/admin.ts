import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { getKillSwitch, setKillSwitch } from "../services/settings.js";
import { todaySpend } from "../services/spend.js";
import { requireAdmin } from "./auth.js";
import { asyncHandler } from "./util.js";

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
      igAppId: config.IG_APP_ID,
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

/** Tester queue: accounts waiting to be added as Instagram testers, and ones invited but not yet connected. */
adminRouter.get(
  "/instagram-requests",
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT r.coin_id, r.username, r.status, r.requested_at, r.invited_at, c.name, c.symbol, c.image_url, c.status AS coin_status
       FROM instagram_access_requests r JOIN coins c ON c.id = r.coin_id
       WHERE r.status IN ('pending','invited')
       ORDER BY r.status = 'pending' DESC, r.requested_at ASC
       LIMIT 200`,
    );
    res.json({
      requests: rows.rows.map((r: any) => ({
        coinId: r.coin_id,
        username: r.username,
        status: r.status,
        requestedAt: r.requested_at,
        invitedAt: r.invited_at,
        coin: { name: r.name, symbol: r.symbol, imageUrl: r.image_url, status: r.coin_status },
      })),
    });
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
