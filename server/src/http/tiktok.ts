import { randomBytes } from "node:crypto";
import express, { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { enqueue } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { nextPostAt } from "../domain/schedule.js";
import { verifyWebhookSignature } from "../domain/tiktok.js";
import { logger } from "../lib/logger.js";
import { openString, seal } from "../lib/secrets.js";
import { getCoin } from "../services/coins.js";
import { authorizeUrl, exchangeCode, getMe, PUBLISH_SCOPE, revokeToken } from "../services/tiktok.js";
import { requireAuth } from "./auth.js";
import { asyncHandler, HttpError } from "./util.js";

export const tiktokRouter = Router();
const base = () => config.PUBLIC_URL.replace(/\/$/, "");

/** The username a coin is locked to: the TikTok profile it launched with as its pump.fun website. */
export async function lockedUsername(coin: { id: string; status: string; website: string | null }) {
  if (coin.status !== "live" || !coin.website?.includes("tiktok.com/")) return null;
  const r = await one<{ username: string }>(`SELECT username FROM tiktok_access_requests WHERE coin_id = $1`, [coin.id]);
  return r?.username ?? null;
}

/** Step 1: creator clicks "Connect TikTok" on their coin page. */
tiktokRouter.get(
  "/connect",
  requireAuth,
  asyncHandler(async (req, res) => {
    const coinId = z.string().uuid().parse(req.query.coinId);
    const coin = await getCoin(coinId);
    if (!coin || coin.creator_wallet !== req.wallet) throw new HttpError(403, "Only the creator can connect TikTok");
    const state = jwt.sign({ coinId, wallet: req.wallet, n: randomBytes(8).toString("hex") }, config.JWT_SECRET, {
      expiresIn: "15m",
    });
    res.redirect(authorizeUrl(state));
  }),
);

/** Step 2: TikTok redirects back here with ?code&state (or ?error). */
tiktokRouter.get(
  "/callback",
  asyncHandler(async (req, res) => {
    let coinId: string | null = null;
    const fail = (msg: string) =>
      res.redirect(`${base()}${coinId ? `/coin/${coinId}` : "/"}?tt_error=${encodeURIComponent(msg)}`);
    try {
      const state = jwt.verify(String(req.query.state ?? ""), config.JWT_SECRET) as { coinId: string; wallet: string };
      coinId = state.coinId;
      if (req.query.error) return fail(String(req.query.error_description ?? "TikTok connection was cancelled"));

      const coin = await getCoin(state.coinId);
      if (!coin || coin.creator_wallet !== state.wallet) return fail("This coin doesn't belong to the wallet that started the connection");

      // Each step names itself in the error, so a failure says where it happened, not just "request error".
      const step = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (e) {
          logger.warn({ step: name, err: (e as Error).message, coinId }, "tiktok connect step failed");
          throw new Error(`${name}: ${(e as Error).message}`);
        }
      };
      const tokens = await step("Logging in", () => exchangeCode(String(req.query.code ?? "")));
      // Safe diagnostics (never the token itself): what was granted.
      logger.info({ coinId, scopes: tokens.scopes, openId: tokens.openId }, "tiktok login token received");
      if (tokens.scopes.length && !tokens.scopes.includes(PUBLISH_SCOPE)) {
        return fail("Posting permission was not granted. Reconnect and allow Reelpad to post to your TikTok.");
      }
      const me = await step("Reading the TikTok profile", () => getMe(tokens.token));

      // The token's website links to the account it launched with, so only that account can be connected.
      const expected = await lockedUsername(coin);
      if (expected && me.username.toLowerCase() !== expected.toLowerCase()) {
        return fail(`This coin launched with @${expected} as its website. Log in to TikTok as @${expected} to connect it.`);
      }

      const taken = await one(
        `SELECT coin_id FROM tiktok_accounts WHERE open_id = $1 AND status = 'active' AND coin_id <> $2`,
        [me.openId, coin.id],
      );
      if (taken) return fail("That TikTok account is already the influencer for another coin");

      await query(
        `INSERT INTO tiktok_accounts(coin_id, open_id, username, display_name, avatar_url, token_enc, token_expires_at,
                                     refresh_token_enc, refresh_expires_at, status, connected_at, last_refreshed_at, scopes, comments_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',now(),now(),$10,NULL)
         ON CONFLICT (coin_id) DO UPDATE SET open_id = EXCLUDED.open_id, username = EXCLUDED.username,
           display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url,
           token_enc = EXCLUDED.token_enc, token_expires_at = EXCLUDED.token_expires_at,
           refresh_token_enc = EXCLUDED.refresh_token_enc, refresh_expires_at = EXCLUDED.refresh_expires_at, status = 'active',
           connected_at = now(), last_refreshed_at = now(), scopes = EXCLUDED.scopes, comments_error = NULL`,
        // Which permissions were granted: comment replies only run when comment management was allowed.
        [
          coin.id,
          me.openId,
          me.username,
          me.displayName,
          me.picture,
          seal(tokens.token),
          tokens.expiresAt,
          seal(tokens.refreshToken),
          tokens.refreshExpiresAt,
          tokens.scopes,
        ],
      );
      await query(`UPDATE tiktok_access_requests SET status = 'connected' WHERE coin_id = $1`, [coin.id]);
      const hasPosts = await one(`SELECT 1 FROM posts WHERE coin_id = $1 AND status <> 'rejected' LIMIT 1`, [coin.id]);
      if (!hasPosts) {
        // First connection: start the first post (a video when videos are on) right now, not on the next schedule tick,
        // and schedule the regular posts after it.
        const perDay = Math.min(
          config.CONTENT_MAX_POSTS_PER_DAY,
          Math.max(config.CONTENT_MIN_POSTS_PER_DAY, coin.content_settings.postsPerDay ?? config.CONTENT_MIN_POSTS_PER_DAY),
        );
        await query(`UPDATE coins SET next_post_at = $2 WHERE id = $1`, [coin.id, nextPostAt(new Date(), perDay)]);
        await enqueue("content.plan", { coinId: coin.id, trigger: "first" }, { dedupeKey: `plan:${coin.id}`, maxAttempts: 3 });
      } else {
        // Reconnecting after an expiry or disconnect: resume posting within a couple of minutes.
        await query(
          `UPDATE coins SET next_post_at = LEAST(COALESCE(next_post_at, now()), now() + interval '2 minutes') WHERE id = $1`,
          [coin.id],
        );
      }
      res.redirect(`${base()}/coin/${coin.id}?tt=connected`);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "tiktok callback failed");
      return fail((e as Error).message || "TikTok connection failed");
    }
  }),
);

tiktokRouter.post(
  "/disconnect",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { coinId } = z.object({ coinId: z.string().uuid() }).parse(req.body);
    const coin = await getCoin(coinId);
    if (!coin || coin.creator_wallet !== req.wallet) throw new HttpError(403, "Only the creator can do this");
    const row = await one<{ token_enc: string; status: string }>(`SELECT token_enc, status FROM tiktok_accounts WHERE coin_id = $1`, [coinId]);
    if (row?.status === "active") await revokeToken(openString(row.token_enc)).catch(() => {});
    await query(
      `UPDATE tiktok_accounts SET status = 'revoked', token_enc = 'revoked', refresh_token_enc = NULL WHERE coin_id = $1`,
      [coinId],
    );
    res.json({ ok: true });
  }),
);

// ---- TikTok webhook (set the callback URL in the TikTok developer portal → Webhooks) ----

/** Mounted ahead of the JSON body parser (see index.ts), because the signature covers the raw body. */
export const tiktokWebhook = [
  express.text({ type: "*/*", limit: "100kb" }),
  asyncHandler(async (req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";
    if (!verifyWebhookSignature(String(req.get("TikTok-Signature") ?? ""), raw, config.TIKTOK_CLIENT_SECRET)) {
      throw new HttpError(401, "Invalid signature");
    }
    const event = JSON.parse(raw) as { event?: string; user_openid?: string };
    // The creator removed Reelpad from their TikTok account (or TikTok revoked access): drop the token.
    if (event.event === "authorization.removed" && event.user_openid) {
      await query(
        `UPDATE tiktok_accounts SET status = 'revoked', token_enc = 'revoked', refresh_token_enc = NULL WHERE open_id = $1`,
        [event.user_openid],
      );
    }
    res.json({ ok: true });
  }),
];
