import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { enqueue } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { nextPostAt } from "../domain/schedule.js";
import { logger } from "../lib/logger.js";
import { seal } from "../lib/secrets.js";
import { getCoin } from "../services/coins.js";
import { authorizeUrl, exchangeCode, getMe, toLongLived } from "../services/instagram.js";
import { requireAuth } from "./auth.js";
import { asyncHandler, HttpError } from "./util.js";

export const instagramRouter = Router();
const base = () => config.PUBLIC_URL.replace(/\/$/, "");

/** Step 1: creator clicks "Connect Instagram" on their coin page. */
instagramRouter.get(
  "/connect",
  requireAuth,
  asyncHandler(async (req, res) => {
    const coinId = z.string().uuid().parse(req.query.coinId);
    const coin = await getCoin(coinId);
    if (!coin || coin.creator_wallet !== req.wallet) throw new HttpError(403, "Only the creator can connect Instagram");
    const state = jwt.sign({ coinId, wallet: req.wallet, n: randomBytes(8).toString("hex") }, config.JWT_SECRET, {
      expiresIn: "15m",
    });
    res.redirect(authorizeUrl(state));
  }),
);

/** Step 2: Instagram redirects back here with ?code&state (or ?error). */
instagramRouter.get(
  "/callback",
  asyncHandler(async (req, res) => {
    let coinId: string | null = null;
    const fail = (msg: string) =>
      res.redirect(`${base()}${coinId ? `/coin/${coinId}` : "/"}?ig_error=${encodeURIComponent(msg)}`);
    try {
      const state = jwt.verify(String(req.query.state ?? ""), config.JWT_SECRET) as { coinId: string; wallet: string };
      coinId = state.coinId;
      if (req.query.error) return fail(String(req.query.error_description ?? "Instagram connection was cancelled"));

      const coin = await getCoin(state.coinId);
      if (!coin || coin.creator_wallet !== state.wallet) return fail("This coin doesn't belong to the wallet that started the connection");

      const { shortToken, permissions } = await exchangeCode(String(req.query.code ?? ""));
      if (!permissions.includes("instagram_business_content_publish")) {
        return fail("Publishing permission was not granted. Reconnect and allow content publishing.");
      }
      const { token, expiresAt } = await toLongLived(shortToken);
      const me = await getMe(token);
      if (me.accountType && !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(me.accountType.toUpperCase())) {
        return fail("This Instagram account must be a Professional (Creator or Business) account");
      }

      const taken = await one(
        `SELECT coin_id FROM instagram_accounts WHERE ig_user_id = $1 AND status = 'active' AND coin_id <> $2`,
        [me.igUserId, coin.id],
      );
      if (taken) return fail("That Instagram account is already the influencer for another coin");

      await query(
        `INSERT INTO instagram_accounts(coin_id, ig_user_id, username, account_type, profile_picture_url, token_enc, token_expires_at, status, connected_at, last_refreshed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',now(),now())
         ON CONFLICT (coin_id) DO UPDATE SET ig_user_id = EXCLUDED.ig_user_id, username = EXCLUDED.username,
           account_type = EXCLUDED.account_type, profile_picture_url = EXCLUDED.profile_picture_url,
           token_enc = EXCLUDED.token_enc, token_expires_at = EXCLUDED.token_expires_at, status = 'active',
           connected_at = now(), last_refreshed_at = now()`,
        [coin.id, me.igUserId, me.username, me.accountType, me.picture, seal(token), expiresAt],
      );
      await query(`UPDATE instagram_access_requests SET status = 'connected' WHERE coin_id = $1`, [coin.id]);
      const hasPosts = await one(`SELECT 1 FROM posts WHERE coin_id = $1 AND status <> 'rejected' LIMIT 1`, [coin.id]);
      if (!hasPosts) {
        // First connection: start the first post (a Reel when Reels are on) right now, not on the next schedule tick,
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
      res.redirect(`${base()}/coin/${coin.id}?ig=connected`);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "instagram callback failed");
      return fail((e as Error).message || "Instagram connection failed");
    }
  }),
);

instagramRouter.post(
  "/disconnect",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { coinId } = z.object({ coinId: z.string().uuid() }).parse(req.body);
    const coin = await getCoin(coinId);
    if (!coin || coin.creator_wallet !== req.wallet) throw new HttpError(403, "Only the creator can do this");
    await query(`UPDATE instagram_accounts SET status = 'revoked', token_enc = 'revoked' WHERE coin_id = $1`, [coinId]);
    res.json({ ok: true });
  }),
);

// ---- Meta-required callbacks (configure these URLs in the Meta App Dashboard) ----

function parseSignedRequest(signed: string): { user_id?: string } | null {
  const [sigB64, payloadB64] = signed.split(".");
  if (!sigB64 || !payloadB64) return null;
  const expected = createHmac("sha256", config.IG_APP_SECRET).update(payloadB64).digest();
  const actual = Buffer.from(sigB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

const urlencoded = express.urlencoded({ extended: false });

instagramRouter.post(
  "/deauthorize",
  urlencoded,
  asyncHandler(async (req, res) => {
    const payload = parseSignedRequest(String(req.body.signed_request ?? ""));
    if (!payload?.user_id) throw new HttpError(400, "Invalid signed_request");
    await query(`UPDATE instagram_accounts SET status = 'revoked', token_enc = 'revoked' WHERE ig_user_id = $1`, [payload.user_id]);
    res.json({ ok: true });
  }),
);

instagramRouter.post(
  "/data-deletion",
  urlencoded,
  asyncHandler(async (req, res) => {
    const payload = parseSignedRequest(String(req.body.signed_request ?? ""));
    if (!payload?.user_id) throw new HttpError(400, "Invalid signed_request");
    await query(`DELETE FROM instagram_accounts WHERE ig_user_id = $1`, [payload.user_id]);
    const code = randomBytes(8).toString("hex");
    res.json({ url: `${base()}/data-deletion?code=${code}`, confirmation_code: code });
  }),
);
