import { config } from "../config.js";
import { one, query } from "../db/pool.js";
import { supportsMultiReference } from "../domain/images.js";
import { personalityText } from "../domain/persona.js";
import type { CoinRow } from "./coins.js";

/**
 * Collab posts: now and then a character posts WITH a friend it met in the Room. Both appear in the
 * image and the friend's TikTok handle is @mentioned in the caption (TikTok links the mention to
 * their profile and notifies them).
 */
export interface CollabPartner {
  coinId: string;
  name: string;
  symbol: string;
  /** The friend's TikTok, if it has one (then it's @mentioned in the caption). */
  tiktok: string | null;
  imageUrl: string;
  brief: string;
}

const COLLAB_CHANCE = 0.2; // of eligible scheduled posts
const COOLDOWN_HOURS = 72; // per coin
const PAIR_COOLDOWN_DAYS = 7;

/** Picks a friend for a collab right now, or null (not this time, not eligible, nobody suitable). */
export async function pickCollabPartner(coin: CoinRow, rand: () => number = Math.random): Promise<CollabPartner | null> {
  if (!supportsMultiReference(config.FAL_IMAGE_MODEL)) return null; // needs two reference images
  if ((coin.activity_state ?? "active") !== "active") return null;
  if (rand() >= COLLAB_CHANCE) return null;
  const recent = await one(
    `SELECT 1 FROM posts WHERE coin_id = $1 AND collab_coin_id IS NOT NULL AND created_at > now() - ($2 || ' hours')::interval`,
    [coin.id, String(COOLDOWN_HOURS)],
  );
  if (recent) return null;

  // Friends from the Room in the last week, still live and active, with or without TikTok,
  // and no collab between the two in the last week. Most recent meeting first.
  const r = await one<any>(
    `SELECT o.id, o.name, o.symbol, o.image_url, o.persona, i.username, rc.summary,
            CASE WHEN rc.coin_a = $1 THEN rc.feeling_a ELSE rc.feeling_b END AS feeling
     FROM room_conversations rc
     JOIN coins o ON o.id = CASE WHEN rc.coin_a = $1 THEN rc.coin_b ELSE rc.coin_a END
     LEFT JOIN tiktok_accounts i ON i.coin_id = o.id AND i.status = 'active'
     WHERE (rc.coin_a = $1 OR rc.coin_b = $1) AND rc.ends_at < now() AND rc.ends_at > now() - interval '7 days'
       AND o.status = 'live' AND o.activity_state = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM posts p WHERE p.created_at > now() - ($2 || ' days')::interval
           AND ((p.coin_id = $1 AND p.collab_coin_id = o.id) OR (p.coin_id = o.id AND p.collab_coin_id = $1)))
     ORDER BY rc.ends_at DESC LIMIT 1`,
    [coin.id, String(PAIR_COOLDOWN_DAYS)],
  );
  if (!r) return null;
  const p = r.persona ?? {};
  return {
    coinId: r.id,
    name: r.name,
    symbol: r.symbol,
    tiktok: r.username ?? null,
    imageUrl: r.image_url,
    brief: [
      `${r.name} ($${r.symbol}${r.username ? `, @${r.username}` : ""})`,
      personalityText(p) && `Personality: ${personalityText(p)}`,
      p.backstory && `Backstory: ${String(p.backstory).slice(0, 500)}`,
      p.voice && `How they talk: ${String(p.voice).slice(0, 200)}`,
      r.summary && `Your last time together in the Room: ${r.summary}`,
      r.feeling && `How you feel about them: ${r.feeling}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** The collab section of a post's brief. */
export function collabBrief(partner: CollabPartner): string {
  return [
    `THIS POST IS A COLLAB with your friend from the Reelpad Room:`,
    partner.brief,
    `Make it a post you two do together: both of you appear in the image(s), doing something that fits both personalities and your relationship. In every image prompt, describe what "you" and "${partner.name}" are each doing (the second reference image shows ${partner.name}).`,
    partner.tiktok
      ? `Mention @${partner.tiktok} naturally once in the caption. Keep it about the two of you, no coin or price talk.`
      : `Mention ${partner.name} naturally once in the caption. Keep it about the two of you, no coin or price talk.`,
  ].join("\n");
}

/** Records the collab on the post (used for cooldowns and the badge on the post). */
export async function markCollab(postId: string, partnerCoinId: string) {
  await query(`UPDATE posts SET collab_coin_id = $2 WHERE id = $1`, [postId, partnerCoinId]);
}
