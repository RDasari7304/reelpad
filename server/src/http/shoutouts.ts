import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import { one } from "../db/pool.js";
import { getCoin, getCoinByIdOrMint, publicCoin } from "../services/coins.js";
import {
  cancelShoutout,
  confirmShoutout,
  createShoutout,
  publicShoutout,
  retryShoutout,
  ShoutoutError,
  shoutoutPricing,
  shoutoutsView,
} from "../services/shoutouts.js";
import { requireAuth } from "./auth.js";
import { asyncHandler, HttpError } from "./util.js";

/** Burn-for-a-Shoutout: fans burn the coin and the influencer records them a personal shoutout. */
export const shoutoutsRouter = Router();

const createLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 8, standardHeaders: true, legacyHeaders: false });

function friendly(e: unknown): never {
  if (e instanceof ShoutoutError) throw new HttpError(400, e.message);
  throw e;
}

/** Prices (in the coin), the coin's shoutout wall, and the viewer's own shoutouts. */
shoutoutsRouter.get(
  "/coins/:key/shoutouts",
  asyncHandler(async (req, res) => {
    const coin = await getCoinByIdOrMint(String(req.params.key));
    if (!coin || coin.status !== "live" || !coin.mint) throw new HttpError(404, "Coin not found");
    res.set("Cache-Control", "no-store");
    const [pricing, view] = await Promise.all([shoutoutPricing(coin).catch(() => null), shoutoutsView(coin.id, req.wallet)]);
    res.json({ pricing, ...view });
  }),
);

/** Requests a shoutout: screens it, then returns the burn transaction for the fan's wallet to sign. */
shoutoutsRouter.post(
  "/coins/:id/shoutouts",
  createLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const coin = await getCoin(String(req.params.id));
    if (!coin || coin.status !== "live" || !coin.mint) throw new HttpError(404, "Coin not found");
    const body = z
      .object({
        recipient: z.string().max(200),
        request: z.string().max(2000),
        format: z.enum(["video", "photo"]),
        public: z.boolean().default(true),
      })
      .parse(req.body);
    try {
      res.json(await createShoutout(coin, req.wallet!, body));
    } catch (e) {
      friendly(e);
    }
  }),
);

/** The fan sent the burn: verify it on-chain and start recording. */
shoutoutsRouter.post(
  "/shoutouts/:id/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { signature } = z.object({ signature: z.string().max(120) }).parse(req.body);
    try {
      await confirmShoutout(String(req.params.id), req.wallet!, signature);
    } catch (e) {
      friendly(e);
    }
    const s = await one(`SELECT * FROM shoutouts WHERE id = $1`, [String(req.params.id)]);
    res.json({ shoutout: publicShoutout(s, req.wallet) });
  }),
);

shoutoutsRouter.post(
  "/shoutouts/:id/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    await cancelShoutout(String(req.params.id), req.wallet!);
    res.json({ ok: true });
  }),
);

shoutoutsRouter.post(
  "/shoutouts/:id/retry",
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      await retryShoutout(String(req.params.id), req.wallet!, config.ADMIN_WALLETS.includes(req.wallet!));
    } catch (e) {
      friendly(e);
    }
    res.json({ ok: true });
  }),
);

/** One shoutout, for its shareable page. Private (not on the wall) ones are still viewable by link. */
shoutoutsRouter.get(
  "/shoutouts/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Shoutout not found");
    const s = await one<any>(`SELECT * FROM shoutouts WHERE id = $1 AND status <> 'expired'`, [id]);
    if (!s || (s.status === "awaiting_burn" && s.wallet !== req.wallet)) throw new HttpError(404, "Shoutout not found");
    const coin = await getCoin(s.coin_id);
    if (!coin) throw new HttpError(404, "Shoutout not found");
    res.set("Cache-Control", "no-store");
    res.json({ shoutout: publicShoutout(s, req.wallet), coin: publicCoin(coin) });
  }),
);
