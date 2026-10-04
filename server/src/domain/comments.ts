/**
 * Rules for the influencer's comment replies. Pure and unit-tested; the service layer does the I/O.
 *
 * Instagram's API can read comments and post replies, but it has no way to like a comment.
 * The influencer's "like" is a short reaction reply (a single emoji), which is what people do anyway.
 */
import { captionViolations, limitEmojis } from "./caption.js";

export const REPLY_MAX_CHARS = 300;
export const MAX_COMMENT_AGE_HOURS = 72;
export const MAX_REPLIES_PER_USER_PER_DAY = 3;
export const MAX_OWN_REPLIES_PER_THREAD_USER = 3;
/** The influencer is selective: it only answers comments it finds interesting (scored 0–10 by Claude). */
export const INTEREST_THRESHOLD = 7;
/** Someone talking back to the influencer in a thread gets a little more benefit of the doubt. */
export const TALKBACK_THRESHOLD = 5;
/** At most this many emoji-only reactions per round, so it doesn't heart everything. */
export const MAX_REACTS_PER_ROUND = 1;

const LOW_EFFORT = new Set([
  "nice", "cool", "lfg", "gm", "gn", "first", "lol", "lmao", "wow", "fire", "based", "bullish", "send it", "wagmi",
  "love it", "love this", "so cute", "cute", "great", "amazing", "awesome", "yes", "yess", "w", "huge", "ok", "omg",
  "let's go", "lets go", "to the moon", "moon", "pump it", "hi", "hello", "hey", "gm fam", "nice one", "great post",
]);

/**
 * Comments with nothing to answer: emoji-only, one or two generic words, "gm", "lfg", "first".
 * These are skipped for free (no AI call) unless the person is talking back to the influencer.
 */
export function isLowEffort(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, " ")
    .replace(/@[\w.]+/g, " ")
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true; // emoji or punctuation only
  if (LOW_EFFORT.has(t)) return true;
  const words = t.split(" ");
  return words.length <= 2 && words.every((w) => w.length <= 4 && !/\d/.test(w)) && !/\?/.test(text);
}

/** Whether a Claude decision clears the bar to actually post. */
export function worthPosting(d: { action: string; interest: number }, talkback: boolean): boolean {
  if (d.action === "skip") return false;
  const bar = talkback ? TALKBACK_THRESHOLD : INTEREST_THRESHOLD;
  return Number.isFinite(d.interest) && d.interest >= bar;
}

export const REACTIONS = ["❤️", "🔥", "😂", "🙏", "👀", "🫡", "💜", "😭", "🤝", "✨"];

export interface StoredComment {
  id: string;
  parentId: string | null;
  mediaId: string;
  username: string;
  text: string;
  timestamp: Date;
  likeCount: number;
  isOwn: boolean;
  status: "new" | "replied" | "skipped" | "failed" | "own";
}

/** How long after a comment appears the influencer may answer it (2–12 min), so replies don't fire like a bot. */
export function humanDelayMinutes(commentId: string): number {
  let h = 0;
  for (let i = 0; i < commentId.length; i++) h = (h * 31 + commentId.charCodeAt(i)) >>> 0;
  return 2 + (h % 11);
}

/** Instagram threads are one level deep: a reply to a reply is posted under the top-level comment. */
export const replyTargetId = (c: Pick<StoredComment, "id" | "parentId">) => c.parentId ?? c.id;

const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(com|io|xyz|net|org|app|fun|gg|me|co|link|site|online|top|vip)\b\S*/gi;
const SPAM_PATTERNS: Array<[RegExp, string]> = [
  [/\b(dm|message|inbox)\s+(me|us)\b/i, "asks to DM"],
  [/\bcheck\s+(my|our)\s+(page|profile|bio|account)\b/i, "self-promotion"],
  [/\b(promo(te|tion)?|collab|shoutout|s\/o)\b.{0,40}\b(dm|price|rate|cheap)\b/i, "promotion offer"],
  [/\b(airdrop|claim (your|now|free)|free (sol|crypto|tokens?)|giveaway winner|wallet connect|seed phrase|private key|recover(y)? (your )?wallet)\b/i, "crypto scam"],
  [/\b(followers|likes|views)\s+(for|at)\s+\$?\d/i, "sells engagement"],
  [/\b(sugar (daddy|mommy)|onlyfans|xxx|nudes?)\b/i, "adult spam"],
  [/\b(earn|make)\s+\$?\d[\d,]*\s*(\/|per|a)\s*(day|week|hour)\b/i, "income scam"],
];

/** Cheap pre-filter before any AI call: obvious spam and scams are skipped for free. */
export function spamReason(text: string): string | null {
  if (LINK.test(text)) {
    LINK.lastIndex = 0;
    return "contains a link";
  }
  LINK.lastIndex = 0;
  for (const [re, why] of SPAM_PATTERNS) if (re.test(text)) return why;
  if (/(.)\1{14,}/u.test(text)) return "character flood";
  if (/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text)) return "contains a wallet or contract address";
  return null;
}

/** Things a reply must never contain, on top of the caption rules (no promises, price calls or "buy now"). */
const REPLY_BANNED: Array<[RegExp, string]> = [
  [/\b(dm|message|inbox)\s+me\b/i, "asks people to DM"],
  [/\b(send|transfer)\s+(me|us)\b/i, "asks for money"],
  [/\b(seed phrase|private key|wallet connect|airdrop)\b/i, "wallet or airdrop talk"],
  [/\b(not|isn'?t|no)\s+financial advice\b.*\b(buy|ape)\b/i, "buy call dressed as NFA"],
  [/\b(price|market cap|mc|mcap)\s+(will|gonna|going to)\b/i, "predicts price"],
  [/\b(as an ai( language model)?|i'?m (just )?an ai model|my (system )?prompt|my instructions)\b/i, "breaks character"],
];

export function replyViolations(text: string): string[] {
  const out = [...captionViolations(text), ...REPLY_BANNED.filter(([re]) => re.test(text)).map(([, w]) => w)];
  if (LINK.test(text)) out.push("contains a link");
  LINK.lastIndex = 0;
  if (/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text)) out.push("contains an address");
  return [...new Set(out)];
}

/**
 * Tidies a reply for Instagram: one line-ish, no hashtags or links, at most one emoji, no tagging of
 * anyone except the person being answered, and the @mention up front when answering inside a thread.
 */
export function cleanReply(raw: string, opts: { username: string; mention: boolean }): string {
  const user = opts.username.replace(/^@/, "");
  let s = String(raw ?? "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(LINK, "")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/@([\w.]+)/g, (m, h: string) => (h.toLowerCase() === user.toLowerCase() ? m : h))
    .replace(/\s+/g, " ")
    .trim();
  LINK.lastIndex = 0;
  s = limitEmojis(s, 1);
  const lead = new RegExp(`^@${user.replace(/\./g, "\\.")}\\b[,:]?\\s*`, "i");
  s = s.replace(lead, "");
  if (opts.mention) s = `@${user} ${s}`;
  if (s.length > REPLY_MAX_CHARS) s = `${s.slice(0, REPLY_MAX_CHARS - 1).replace(/\s+\S*$/, "")}…`;
  return s.trim();
}

/** A reaction must be one emoji from the set; anything else falls back to a heart. */
export function cleanReaction(raw: string): string {
  const t = String(raw ?? "").trim();
  return REACTIONS.find((r) => t.startsWith(r)) ?? "❤️";
}

export interface Selection {
  reply: StoredComment[];
  /** Skipped for free, with a reason, before any AI call. */
  skip: Array<{ comment: StoredComment; reason: string }>;
}

/**
 * Picks which comments to answer this round:
 * - top-level comments from other people, and replies inside a thread the influencer already joined
 *   (that's someone talking back to it);
 * - old enough to look human, young enough to still matter;
 * - not too many per person per day, and not endless back-and-forth in one thread;
 * - conversations first, then questions, then the most-liked, oldest first.
 */
export function selectForReply(
  all: StoredComment[],
  now: Date,
  opts: { batch: number; repliedTodayByUser: Map<string, number> },
): Selection {
  const byParent = new Map<string, StoredComment[]>();
  for (const c of all) if (c.parentId) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const skip: Selection["skip"] = [];
  const candidates: Array<{ c: StoredComment; score: number }> = [];
  const perUser = new Map(opts.repliedTodayByUser);

  for (const c of all) {
    if (c.status !== "new" || c.isOwn) continue;
    const ageMin = (now.getTime() - c.timestamp.getTime()) / 60_000;
    if (ageMin > MAX_COMMENT_AGE_HOURS * 60) {
      skip.push({ comment: c, reason: "too old to answer" });
      continue;
    }
    if (ageMin < humanDelayMinutes(c.id)) continue; // not yet; next round
    const spam = spamReason(c.text);
    if (spam) {
      skip.push({ comment: c, reason: `spam: ${spam}` });
      continue;
    }
    if (!c.text.trim()) {
      skip.push({ comment: c, reason: "empty" });
      continue;
    }
    if (!c.parentId && isLowEffort(c.text)) {
      skip.push({ comment: c, reason: "not interesting enough to answer" });
      continue;
    }
    let conversational = false;
    if (c.parentId) {
      // A reply in a thread: answer only if the influencer is part of that conversation already.
      const thread = byParent.get(c.parentId) ?? [];
      const ownBefore = thread.filter((x) => x.isOwn && x.timestamp <= c.timestamp);
      if (ownBefore.length === 0) continue; // fans talking to each other: leave it
      const ownToUser = thread.filter((x) => x.isOwn && x.text.toLowerCase().startsWith(`@${c.username.toLowerCase()}`)).length;
      if (ownToUser >= MAX_OWN_REPLIES_PER_THREAD_USER) {
        skip.push({ comment: c, reason: "long back-and-forth already" });
        continue;
      }
      conversational = true;
    } else {
      // Top-level: skip if the influencer already answered this comment.
      const answered = (byParent.get(c.id) ?? []).some((x) => x.isOwn);
      if (answered) {
        skip.push({ comment: c, reason: "already answered" });
        continue;
      }
    }
    const u = c.username.toLowerCase();
    if ((perUser.get(u) ?? 0) >= MAX_REPLIES_PER_USER_PER_DAY) {
      skip.push({ comment: c, reason: "answered this person enough today" });
      continue;
    }
    const question = /\?\s*$|^(who|what|when|where|why|how|is|are|do|does|did|can|could|will|would|should)\b/i.test(c.text.trim());
    const score = (conversational ? 1000 : 0) + (question ? 300 : 0) + Math.min(c.likeCount, 50) * 4 - ageMin / 60;
    candidates.push({ c, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const reply: StoredComment[] = [];
  for (const { c } of candidates) {
    if (reply.length >= opts.batch) break;
    const u = c.username.toLowerCase();
    if ((perUser.get(u) ?? 0) >= MAX_REPLIES_PER_USER_PER_DAY) continue;
    perUser.set(u, (perUser.get(u) ?? 0) + 1);
    reply.push(c);
  }
  return { reply, skip };
}

/** How many replies are left right now, given hourly and daily caps. */
export function replyBudget(used: { hour: number; day: number }, caps: { perHour: number; perDay: number }): number {
  return Math.max(0, Math.min(caps.perHour - used.hour, caps.perDay - used.day));
}
