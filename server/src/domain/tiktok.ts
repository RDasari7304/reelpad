import { createHmac, timingSafeEqual } from "node:crypto";

/** TikTok username rules: letters, numbers, periods and underscores, 2 to 24 characters, not ending in a period. Pure, unit-tested. */
export const TIKTOK_USERNAME_MESSAGE = "TikTok usernames use letters, numbers, periods and underscores (2-24, not ending in a period)";

/** Returns the normalised username (no @, lowercase), or null if it isn't a valid TikTok username. */
export function normalizeTikTokUsername(input: string): string | null {
  const u = input.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{2,24}$/.test(u) && !u.endsWith(".") ? u : null;
}

/** The configured visibility if the account allows it, otherwise the most public one it does allow. */
export function pickPrivacy(options: string[], wanted: string): string {
  if (options.includes(wanted)) return wanted;
  for (const p of ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]) if (options.includes(p)) return p;
  return options[0] ?? "SELF_ONLY";
}

export const postUrl = (username: string, postId: string, kind: "video" | "photo") => `https://www.tiktok.com/@${username}/${kind}/${postId}`;

/** TikTok photo posts take a title of up to 90 characters; the full text goes in the description. */
export function photoTitle(caption: string): string {
  const first = caption.split("\n")[0]!.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
  return first.length > 90 ? `${first.slice(0, 89).replace(/\s+\S*$/, "")}…` : first;
}

/** TikTok signs each webhook: header "TikTok-Signature: t=<unix>,s=<hex HMAC-SHA256 of `${t}.${body}` with the client secret>". */
export function verifyWebhookSignature(header: string, rawBody: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!parts.s || !Number.isFinite(t) || Math.abs(nowSec - t) > 5 * 60) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest();
  const actual = Buffer.from(parts.s, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * TikTok returns published post IDs as bare 64-bit JSON numbers, which JSON.parse would round. Quotes the
 * numbers in "publicaly_available_post_id" (TikTok's spelling) so they stay exact strings.
 */
export function quotePostIds(json: string): string {
  return json.replace(/("publicaly_available_post_id"\s*:\s*\[)([^\]]*)\]/g, (_m, head: string, list: string) => `${head}${list.replace(/-?\d+/g, (n) => `"${n}"`)}]`);
}
