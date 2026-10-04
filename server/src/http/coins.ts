import { PublicKey } from "@solana/web3.js";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { enqueue } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import {
  coinDraftSchema,
  contentSettingsSchema,
  instagramUsernameSchema,
  personaSchema,
} from "../domain/schemas.js";
import { getCoin, getCoinByIdOrMint, publicCoin, type CoinRow } from "../services/coins.js";
import { upsertAccessRequest } from "../services/instagramAccess.js";
import { createDraft, prepareLaunch, submitLaunch } from "../services/launch.js";
import { buildBuyTx } from "../services/pumpportal.js";
import { getKillSwitch } from "../services/settings.js";
import { getSolBalance } from "../services/solana.js";
import { requireAuth } from "./auth.js";
import { asyncHandler, HttpError } from "./util.js";

export const coinsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, "Image must be PNG, JPEG, WEBP or GIF"));
  },
});

const draftLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

async function ownedCoin(id: string, wallet: string | undefined): Promise<CoinRow> {
  const coin = await getCoin(id);
  if (!coin) throw new HttpError(404, "Coin not found");
  if (coin.creator_wallet !== wallet) throw new HttpError(403, "Only the creator can do this");
  return coin;
}

async function instagramSummary(coinId: string) {
  return one<{ username: string; status: string; profile_picture_url: string | null }>(
    `SELECT username, status, profile_picture_url FROM instagram_accounts WHERE coin_id = $1`,
    [coinId],
  );
}

async function accessRequest(coinId: string) {
  return one<{ username: string; status: string; requested_at: Date; invited_at: Date | null }>(
    `SELECT username, status, requested_at, invited_at FROM instagram_access_requests WHERE coin_id = $1`,
    [coinId],
  );
}

// ---- public reads ----

coinsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 30) || 30, 60);
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : null;
    const rows = await query(
      `SELECT c.*, i.username AS ig_username,
              (SELECT media FROM posts p WHERE p.coin_id = c.id AND p.status = 'published' ORDER BY published_at DESC LIMIT 1) AS last_media,
              (SELECT count(*) FROM posts p WHERE p.coin_id = c.id AND p.status = 'published')::int AS post_count
       FROM coins c LEFT JOIN instagram_accounts i ON i.coin_id = c.id AND i.status = 'active'
       WHERE c.status = 'live' AND ($2::timestamptz IS NULL OR c.launched_at < $2)
       ORDER BY c.launched_at DESC LIMIT $1`,
      [limit, before && !isNaN(before.getTime()) ? before : null],
    );
    res.json({
      coins: rows.rows.map((r: any) =>
        publicCoin(r, {
          instagram: r.ig_username ? { username: r.ig_username } : null,
          lastImage: (r.last_media ?? []).find((m: any) => m.type === "image")?.url ?? null,
          postCount: r.post_count,
        }),
      ),
    });
  }),
);

coinsRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await query<CoinRow>(`SELECT * FROM coins WHERE creator_wallet = $1 ORDER BY created_at DESC`, [req.wallet]);
    res.json({ coins: rows.rows.map((c) => publicCoin(c)) });
  }),
);

coinsRouter.get(
  "/:key",
  asyncHandler(async (req, res) => {
    const coin = await getCoinByIdOrMint(String(req.params.key));
    if (!coin || (coin.status !== "live" && coin.creator_wallet !== req.wallet)) throw new HttpError(404, "Coin not found");
    const isOwner = coin.creator_wallet === req.wallet;
    const [ig, request] = await Promise.all([instagramSummary(coin.id), isOwner ? accessRequest(coin.id) : null]);
    res.json({
      coin: publicCoin(coin, {
        // The handle only shows while the account is connected. After a disconnect it's gone for everyone;
        // the owner still learns about an expired connection so they can log in again.
        instagram:
          ig?.status === "active"
            ? { username: ig.username, status: ig.status, picture: ig.profile_picture_url }
            : ig?.status === "expired" && isOwner
              ? { username: ig.username, status: ig.status, picture: null }
              : null,
        instagramAccess: request
          ? { username: request.username, status: request.status, requestedAt: request.requested_at, invitedAt: request.invited_at }
          : null,
        isOwner,
      }),
    });
  }),
);

coinsRouter.get(
  "/:id/posts",
  asyncHandler(async (req, res) => {
    const coin = await getCoin(String(req.params.id));
    if (!coin) throw new HttpError(404, "Coin not found");
    const isOwner = coin.creator_wallet === req.wallet;
    const rows = await query(
      `SELECT id, format, status, trigger, concept, caption, media, permalink, error, progress, stage, created_at, published_at
       FROM posts WHERE coin_id = $1 ${isOwner ? "" : "AND status = 'published'"}
       ORDER BY created_at DESC LIMIT 60`,
      [coin.id],
    );
    res.json({ posts: rows.rows });
  }),
);

coinsRouter.get(
  "/:id/treasury",
  asyncHandler(async (req, res) => {
    const coin = await getCoin(String(req.params.id));
    if (!coin || coin.status !== "live") throw new HttpError(404, "Coin not found");
    const agent = new PublicKey(coin.agent_pubkey);
    const [solBal, actions, prices, totals] = await Promise.all([
      getSolBalance(agent).catch(() => null),
      query(
        `SELECT kind, sol_amount, token_amount, tx_sig, status, reason, dry_run, created_at FROM treasury_actions
         WHERE coin_id = $1 AND status <> 'skipped' ORDER BY created_at DESC LIMIT 50`,
        [coin.id],
      ),
      query(
        `SELECT ts, price_sol FROM price_snapshots WHERE coin_id = $1 AND ts > now() - interval '7 days' ORDER BY ts`,
        [coin.id],
      ),
      one<{ fees: string | null; spent: string | null; burned: string | null; burns: number }>(
        `SELECT
           sum(sol_amount) FILTER (WHERE kind = 'claim_fees' AND status = 'done')::text AS fees,
           sum(sol_amount) FILTER (WHERE kind = 'buy' AND status = 'done')::text AS spent,
           sum(token_amount::numeric) FILTER (WHERE kind = 'burn' AND status = 'done')::text AS burned,
           count(*) FILTER (WHERE kind = 'burn' AND status = 'done')::int AS burns
         FROM treasury_actions WHERE coin_id = $1`,
        [coin.id],
      ),
    ]);
    res.json({
      agentWallet: coin.agent_pubkey,
      solBalance: solBal,
      totals: {
        feesCollectedSol: Number(totals?.fees ?? 0),
        boughtBackSol: Number(totals?.spent ?? 0),
        tokensBurned: Number(totals?.burned ?? 0),
        burns: totals?.burns ?? 0,
      },
      rules: {
        minBuySol: config.TREASURY_MIN_BUY_SOL,
        buyIntervalMin: config.TREASURY_BUY_INTERVAL_MIN,
        maxSolPerBuy: config.TREASURY_MAX_SOL_PER_ACTION,
        maxSolPerDay: config.TREASURY_MAX_SOL_PER_DAY,
        gasReserveSol: config.TREASURY_GAS_RESERVE_SOL,
      },
      paused: coin.treasury_paused,
      dryRun: config.TREASURY_DRY_RUN,
      actions: actions.rows,
      prices: prices.rows.map((p: any) => ({ t: p.ts, p: Number(p.price_sol) })),
    });
  }),
);

// ---- launch flow ----

coinsRouter.post(
  "/",
  requireAuth,
  draftLimiter,
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if ((await getKillSwitch()).launches) throw new HttpError(503, "Launches are paused right now");
    if (!req.file) throw new HttpError(400, "Upload a token image");
    let data: unknown;
    try {
      data = JSON.parse(String(req.body.data ?? "{}"));
    } catch {
      throw new HttpError(400, "Malformed form data");
    }
    const draft = coinDraftSchema.parse(data);
    const coin = await createDraft(req.wallet!, draft, req.file.buffer);
    res.status(201).json({ coin: publicCoin(coin, { isOwner: true }) });
  }),
);

coinsRouter.post(
  "/:id/launch-tx",
  requireAuth,
  asyncHandler(async (req, res) => {
    if ((await getKillSwitch()).launches) throw new HttpError(503, "Launches are paused right now");
    const coin = await ownedCoin(String(req.params.id), req.wallet);
    res.json(await prepareLaunch(coin, req.wallet!));
  }),
);

coinsRouter.post(
  "/:id/submit",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { transaction } = z.object({ transaction: z.string().min(100).max(4000) }).parse(req.body);
    res.json(await submitLaunch(String(req.params.id), req.wallet!, transaction));
  }),
);

coinsRouter.post(
  "/:id/dev-buy-tx",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sol } = z.object({ sol: z.number().min(0.001).max(50) }).parse(req.body);
    const coin = await ownedCoin(String(req.params.id), req.wallet);
    if (coin.status !== "live" || !coin.mint) throw new HttpError(400, "Coin is not live yet");
    const bytes = await buildBuyTx(new PublicKey(req.wallet!), new PublicKey(coin.mint), sol, "auto");
    res.json({ transaction: Buffer.from(bytes).toString("base64") });
  }),
);

// ---- creator controls ----

coinsRouter.patch(
  "/:id/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const coin = await ownedCoin(String(req.params.id), req.wallet);
    const body = z
      .object({
        persona: personaSchema.optional(),
        contentSettings: contentSettingsSchema.optional(),
        contentPaused: z.boolean().optional(),
      })
      .parse(req.body);
    // The treasury is automatic buyback-and-burn: creators can't change or pause it (admins can, from Admin).
    const updated = await one<CoinRow>(
      `UPDATE coins SET
         persona = COALESCE($2, persona),
         content_settings = COALESCE($3, content_settings),
         content_paused = COALESCE($4, content_paused)
       WHERE id = $1 RETURNING *`,
      [
        coin.id,
        body.persona ? JSON.stringify(body.persona) : null,
        body.contentSettings ? JSON.stringify(body.contentSettings) : null,
        body.contentPaused ?? null,
      ],
    );
    res.json({ coin: publicCoin(updated!, { isOwner: true }) });
  }),
);

coinsRouter.post(
  "/:id/posts/generate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const coin = await ownedCoin(String(req.params.id), req.wallet);
    if (coin.status !== "live") throw new HttpError(400, "Coin is not live");
    const manualToday = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM posts WHERE coin_id = $1 AND trigger = 'manual' AND created_at > now() - interval '24 hours'`,
      [coin.id],
    );
    if ((manualToday?.n ?? 0) >= 3) throw new HttpError(429, "Manual post limit reached (3 per day)");
    const note = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {}).note;
    const queued = await enqueue("content.plan", { coinId: coin.id, trigger: "manual", note }, { dedupeKey: `plan:${coin.id}` });
    res.json({ queued });
  }),
);

/**
 * Tester mode: the creator tells us which Instagram account to add as a tester.
 * Submitting a different username resets the request to pending.
 */
coinsRouter.put(
  "/:id/instagram-access",
  requireAuth,
  asyncHandler(async (req, res) => {
    const coin = await ownedCoin(String(req.params.id), req.wallet);
    const { username } = z.object({ username: instagramUsernameSchema }).parse(req.body);
    res.json({ instagramAccess: await upsertAccessRequest(coin.id, username) });
  }),
);

coinsRouter.post(
  "/:id/treasury/run",
  requireAuth,
  asyncHandler(async (req, res) => {
    const coin = await ownedCoin(String(req.params.id), req.wallet);
    const queued = await enqueue("treasury.run", { coinId: coin.id }, { dedupeKey: `treasury:${coin.id}` });
    res.json({ queued });
  }),
);

// ---- post moderation (creator) ----

export const postsRouter = Router();

async function ownedPost(postId: string, wallet?: string) {
  if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new HttpError(404, "Post not found");
  const post = await one<{ id: string; coin_id: string; status: string; creator_wallet: string }>(
    `SELECT p.id, p.coin_id, p.status, c.creator_wallet FROM posts p JOIN coins c ON c.id = p.coin_id WHERE p.id = $1`,
    [postId],
  );
  if (!post) throw new HttpError(404, "Post not found");
  if (post.creator_wallet !== wallet) throw new HttpError(403, "Only the creator can do this");
  return post;
}

postsRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await ownedPost(String(req.params.id), req.wallet);
    if (post.status !== "awaiting_approval") throw new HttpError(400, "Only posts awaiting approval can be edited");
    const { caption } = z.object({ caption: z.string().min(1).max(2200) }).parse(req.body);
    await query(`UPDATE posts SET caption = $2 WHERE id = $1`, [post.id, caption]);
    res.json({ ok: true });
  }),
);

postsRouter.post(
  "/:id/approve",
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await ownedPost(String(req.params.id), req.wallet);
    if (post.status !== "awaiting_approval") throw new HttpError(400, "Post is not awaiting approval");
    await query(`UPDATE posts SET status = 'ready', progress = 90, stage = 'Queued to post' WHERE id = $1`, [post.id]);
    await enqueue("content.publish", { postId: post.id }, { dedupeKey: `pub:${post.id}`, maxAttempts: 4 });
    res.json({ ok: true });
  }),
);

postsRouter.post(
  "/:id/reject",
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await ownedPost(String(req.params.id), req.wallet);
    if (!["awaiting_approval", "ready", "failed"].includes(post.status)) throw new HttpError(400, "Post can't be rejected now");
    await query(`UPDATE posts SET status = 'rejected' WHERE id = $1`, [post.id]);
    res.json({ ok: true });
  }),
);

postsRouter.post(
  "/:id/retry",
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await ownedPost(String(req.params.id), req.wallet);
    if (post.status !== "failed") throw new HttpError(400, "Only failed posts can be retried");
    const state = await one<{ has_media: boolean; has_plan: boolean }>(
      `SELECT jsonb_array_length(media) > 0 AS has_media, plan IS NOT NULL AS has_plan FROM posts WHERE id = $1`,
      [post.id],
    );
    if (state?.has_media) {
      await query(`UPDATE posts SET status = 'ready', error = NULL, progress = 90, stage = 'Queued to post' WHERE id = $1`, [post.id]);
      await enqueue("content.publish", { postId: post.id }, { dedupeKey: `pub:${post.id}`, maxAttempts: 4 });
    } else if (!state?.has_plan) {
      // Failed while planning: plan it again, reusing this same card.
      await query(
        `UPDATE posts SET status = 'planned', error = NULL, progress = 5, stage = 'Coming up with the idea', created_at = now() WHERE id = $1`,
        [post.id],
      );
      await enqueue("content.plan", { coinId: post.coin_id, trigger: "manual" }, { dedupeKey: `plan:${post.coin_id}`, maxAttempts: 3 });
    } else {
      await query(
        `UPDATE posts SET status = 'generating', error = NULL, progress = 20, stage = 'Starting the visuals again' WHERE id = $1`,
        [post.id],
      );
      await enqueue("content.generate", { postId: post.id }, { dedupeKey: `gen:${post.id}`, maxAttempts: 3 });
    }
    res.json({ ok: true });
  }),
);
