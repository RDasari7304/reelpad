import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import { z } from "zod";
import { config, isProd } from "../config.js";
import { one, query } from "../db/pool.js";
import { asyncHandler, HttpError } from "./util.js";

const COOKIE = "session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      wallet?: string;
    }
  }
}

export function signInMessage(wallet: string, nonce: string) {
  return [
    `Sign in to ${config.APP_NAME}`,
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    "",
    "This request will not trigger a transaction or cost any fees.",
  ].join("\n");
}

const isWallet = (s: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(s).toBytes());
  } catch {
    return false;
  }
};

export function readSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as { sub: string };
      req.wallet = payload.sub;
    } catch {
      /* invalid/expired session: treat as signed out */
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.wallet) return next(new HttpError(401, "Connect and sign in with your wallet first"));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.wallet || !config.ADMIN_WALLETS.includes(req.wallet)) return next(new HttpError(403, "Admins only"));
  next();
}

export const authRouter = Router();

authRouter.post(
  "/nonce",
  asyncHandler(async (req, res) => {
    const { wallet } = z.object({ wallet: z.string().refine(isWallet, "Invalid wallet") }).parse(req.body);
    const nonce = randomBytes(16).toString("hex");
    await query(`DELETE FROM auth_nonces WHERE expires_at < now()`);
    await query(`INSERT INTO auth_nonces(nonce, wallet, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`, [nonce, wallet]);
    res.json({ nonce, message: signInMessage(wallet, nonce) });
  }),
);

authRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const body = z.object({ wallet: z.string(), nonce: z.string(), signature: z.string() }).parse(req.body);
    const row = await one(
      `UPDATE auth_nonces SET used = true WHERE nonce = $1 AND wallet = $2 AND NOT used AND expires_at > now() RETURNING nonce`,
      [body.nonce, body.wallet],
    );
    if (!row) throw new HttpError(401, "Sign-in request expired. Try again.");
    let sig: Uint8Array;
    try {
      sig = bs58.decode(body.signature);
    } catch {
      throw new HttpError(400, "Malformed signature");
    }
    const msg = new TextEncoder().encode(signInMessage(body.wallet, body.nonce));
    if (!nacl.sign.detached.verify(msg, sig, new PublicKey(body.wallet).toBytes())) {
      throw new HttpError(401, "Signature verification failed");
    }
    const token = jwt.sign({ sub: body.wallet }, config.JWT_SECRET, { expiresIn: "7d" });
    res.cookie(COOKIE, token, { httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 7 * 86400_000, path: "/" });
    res.json({ wallet: body.wallet, isAdmin: config.ADMIN_WALLETS.includes(body.wallet) });
  }),
);

authRouter.get("/me", (req, res) => {
  res.json({ wallet: req.wallet ?? null, isAdmin: !!req.wallet && config.ADMIN_WALLETS.includes(req.wallet) });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});
