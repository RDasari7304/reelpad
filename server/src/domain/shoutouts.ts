import { spamReason } from "./comments.js";

/**
 * Burn-for-a-Shoutout: a holder burns some of the coin and the influencer records them a personal
 * shoutout (a talking video or a photo with a note), like a celebrity video message, paid for by
 * permanently removing coins from supply instead of by money changing hands.
 */

export type ShoutoutFormat = "video" | "photo";

export const RECIPIENT_MAX = 40;
export const REQUEST_MIN = 8;
export const REQUEST_MAX = 220;
/** How long a quote (token amount at the current price) stays valid. */
export const QUOTE_MINUTES = 15;

const MONEY_TALK = /\b(buy|sell|pump|dump|moon|price|market ?cap|mcap|100x|1000x|ape in|send me|airdrop|giveaway|presale|contract address)\b/i;

export type Check = { ok: true; value: string } | { ok: false; error: string };

const tidy = (s: unknown) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** Who the shoutout is for: a first name, nickname or @handle. */
export function cleanRecipient(raw: unknown): Check {
  const v = tidy(raw).replace(/^@+/, "@");
  if (v.length < 2) return { ok: false, error: "Who is it for? Add a name." };
  if (v.length > RECIPIENT_MAX) return { ok: false, error: `Keep the name under ${RECIPIENT_MAX} characters.` };
  if (!/^[\p{L}\p{N}@_.' -]+$/u.test(v)) return { ok: false, error: "Use letters, numbers and spaces in the name." };
  if (spamReason(v)) return { ok: false, error: "That name can't be used." };
  return { ok: true, value: v };
}

/** What the shoutout is about: the occasion, an inside joke, what to say. */
export function cleanRequest(raw: unknown): Check {
  const v = tidy(raw);
  if (v.length < REQUEST_MIN) return { ok: false, error: "Say a little about what the shoutout is for." };
  if (v.length > REQUEST_MAX) return { ok: false, error: `Keep it under ${REQUEST_MAX} characters.` };
  const spam = spamReason(v);
  if (spam) return { ok: false, error: `That request can't be used (${spam}).` };
  if (MONEY_TALK.test(v)) return { ok: false, error: "Shoutouts can't be about prices, trading or promotions." };
  return { ok: true, value: v };
}

/**
 * The number of tokens (in raw units) to burn for a shoutout worth `solValue` SOL at `priceSol`
 * SOL per whole token. Rounded UP to a clean number so the amount looks deliberate, never under value.
 */
export function quoteTokens(priceSol: number, solValue: number, decimals: number): bigint {
  if (!(priceSol > 0) || !(solValue > 0)) throw new Error("No price available for this coin right now");
  const whole = solValue / priceSol;
  // Round up to 2 significant figures: 123,456 -> 130,000.
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(whole)) - 1);
  const rounded = Math.max(1, Math.ceil(whole / mag) * mag);
  return BigInt(Math.round(rounded)) * 10n ** BigInt(decimals);
}

export const formatTokens = (raw: bigint, decimals: number) => Number(raw / 10n ** BigInt(decimals)).toLocaleString("en-US");

/** A token instruction as returned by getParsedTransaction (outer or inner). */
export interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: Record<string, any> } | string;
}

/**
 * Total raw tokens of `mint` burned by `wallet` in a transaction's instructions (Token and Token-2022,
 * burn and burnChecked). Anything else in the transaction is ignored.
 */
export function burnedBy(ixs: ParsedIx[], mint: string, wallet: string): bigint {
  let total = 0n;
  for (const ix of ixs) {
    if (!ix || typeof ix.parsed !== "object" || !ix.parsed) continue;
    const { type, info } = ix.parsed;
    if ((type !== "burn" && type !== "burnChecked") || !info) continue;
    if (info.mint !== mint) continue;
    if (info.authority !== wallet && info.multisigAuthority !== wallet) continue;
    const amount = info.tokenAmount?.amount ?? info.amount;
    try {
      total += BigInt(String(amount));
    } catch {
      /* malformed amount: ignore */
    }
  }
  return total;
}
