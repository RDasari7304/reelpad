import { config } from "../config.js";
import { enqueue, PermanentError } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { captionViolations, finalizeCaption } from "../domain/caption.js";
import { CONTENT_RULES, personaBrief, visualStyleText } from "../domain/persona.js";
import { chooseFormat, firstPostFormat, nextPostAt, type Format } from "../domain/schedule.js";
import { logger } from "../lib/logger.js";
import { structured } from "./ai/claude.js";
import { generateImage, generateVideo } from "./ai/fal.js";
import { getCoin, getInstagram, markInstagramExpired, type CoinRow } from "./coins.js";
import { containerStatus, InstagramError, publish } from "./instagram.js";
import { rehostImageForInstagram, rehostVideo } from "./media.js";
import { getKillSwitch } from "./settings.js";
import { reserveSpend } from "./spend.js";

interface PostPlan {
  concept: string;
  caption: string;
  hashtags: string[];
  image_prompts: string[];
  video_prompt?: string;
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    concept: { type: "string", description: "One sentence: the idea of this post." },
    caption: { type: "string", description: "The Instagram caption in the character's voice, without hashtags. Max ~600 characters." },
    hashtags: { type: "array", items: { type: "string" }, description: "Up to 5 relevant hashtags without the # sign." },
    image_prompts: {
      type: "array",
      items: { type: "string" },
      description:
        "Image-generation prompts. Each describes one scene featuring the character from the reference image. No text in images.",
    },
    video_prompt: { type: "string", description: "For reels only: the motion/camera direction for a 5-second clip." },
  },
  required: ["concept", "caption", "hashtags", "image_prompts"],
};

function formatInstructions(format: Format) {
  switch (format) {
    case "image":
      return "Format: single image post. Provide exactly 1 image prompt.";
    case "carousel":
      return "Format: carousel. Provide 3 to 5 image prompts that tell a short visual story in order.";
    case "reel":
      return "Format: 5-second vertical Reel. Provide exactly 1 image prompt for the opening keyframe (vertical 9:16 composition) and a video_prompt describing the motion.";
  }
}

async function recentContext(coin: CoinRow) {
  const posts = await query<{ format: string; concept: string; caption: string }>(
    `SELECT format, concept, caption FROM posts WHERE coin_id = $1 AND status IN ('published','ready','awaiting_approval')
     ORDER BY created_at DESC LIMIT 8`,
    [coin.id],
  );
  const actions = await query<{ kind: string; sol_amount: string | null; token_amount: string | null; reason: string; created_at: Date; dry_run: boolean }>(
    `SELECT kind, sol_amount, token_amount, reason, created_at, dry_run FROM treasury_actions
     WHERE coin_id = $1 AND status IN ('done','simulated') ORDER BY created_at DESC LIMIT 5`,
    [coin.id],
  );
  return {
    recentPosts: posts.rows.map((p) => `- [${p.format}] ${p.concept}`).join("\n") || "(no posts yet — this is the first one, introduce yourself)",
    treasury:
      actions.rows
        .map(
          (a) =>
            `- ${a.created_at.toISOString().slice(0, 16)} ${a.kind}${a.sol_amount ? ` ${a.sol_amount} SOL` : ""}${a.token_amount ? ` ${a.token_amount} tokens` : ""}${a.dry_run ? " (simulation)" : ""}: ${a.reason}`,
        )
        .join("\n") || "(no treasury actions yet)",
  };
}

async function planWithClaude(coin: CoinRow, format: Format, note?: string): Promise<PostPlan> {
  const ctx = await recentContext(coin);
  const system = `${personaBrief(coin, coin.persona)}\n\n${CONTENT_RULES}`;
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = [
      `Plan your next Instagram post.`,
      formatInstructions(format),
      note ? `Reason for this post: ${note}` : "",
      `Your recent posts (don't repeat these ideas):\n${ctx.recentPosts}`,
      `Recent treasury activity (only mention it if relevant, and only these facts):\n${ctx.treasury}`,
      `Coin mint address: ${coin.mint}`,
      feedback,
    ]
      .filter(Boolean)
      .join("\n\n");
    const plan = await structured<PostPlan>({
      system,
      user,
      toolName: "plan_post",
      toolDescription: "Return the plan for one Instagram post.",
      schema: PLAN_SCHEMA,
    });
    plan.caption = String(plan.caption ?? "").trim();
    plan.hashtags = Array.isArray(plan.hashtags) ? plan.hashtags.map(String) : [];
    plan.image_prompts = Array.isArray(plan.image_prompts) ? plan.image_prompts.map(String).filter(Boolean) : [];
    const violations = captionViolations(plan.caption);
    if (violations.length === 0 && plan.caption && plan.image_prompts.length) return plan;
    feedback = `Your previous caption broke the rules (${violations.join(", ") || "missing image prompts"}). Rewrite it without that.`;
  }
  throw new PermanentError("Could not produce a caption that passes the content rules");
}

/** Job: decide format + plan a post. */
export async function planPost(coinId: string, trigger: string, note?: string) {
  const kill = await getKillSwitch();
  if (kill.content) return logger.info({ coinId }, "content kill switch on; skipping plan");
  const coin = await getCoin(coinId);
  if (!coin || coin.status !== "live" || coin.content_paused) return;
  const ig = await getInstagram(coinId);
  if (!ig || ig.status !== "active") return logger.info({ coinId }, "no active Instagram account; skipping");

  const recent = await query<{ format: Format }>(
    `SELECT format FROM posts WHERE coin_id = $1 ORDER BY created_at DESC LIMIT 3`,
    [coinId],
  );
  const reels = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM posts WHERE coin_id = $1 AND format = 'reel' AND status <> 'rejected'
     AND created_at > now() - interval '7 days'`,
    [coinId],
  );
  const reelsCap = Math.min(coin.content_settings.reelsPerWeek, config.CONTENT_MAX_REELS_PER_WEEK);
  // The very first post (queued the moment Instagram connects) leads with a Reel when Reels are on.
  const isFirst = recent.rows.length === 0;
  const format = isFirst
    ? firstPostFormat(coin.content_settings.formats, reelsCap)
    : chooseFormat({
        allowed: coin.content_settings.formats,
        reelsThisWeek: Number(reels?.n ?? 0),
        reelsPerWeek: reelsCap,
        recent: recent.rows.map((r) => r.format),
      });
  if (isFirst && !note) {
    note = "This is your very first post. Introduce yourself to Instagram in character: who you are and what your world is like.";
  }

  if (!(await reserveSpend(config.COST_LLM_USD))) throw new Error("Daily AI budget reached");
  const plan = await planWithClaude(coin, format, note);
  const post = await one<{ id: string }>(
    `INSERT INTO posts(coin_id, format, status, trigger, concept, plan, cost_usd)
     VALUES ($1, $2, 'generating', $3, $4, $5, $6) RETURNING id`,
    [coinId, format, trigger, plan.concept, JSON.stringify(plan), config.COST_LLM_USD],
  );
  await enqueue("content.generate", { postId: post!.id }, { dedupeKey: `gen:${post!.id}`, maxAttempts: 3 });
}

/** Job: generate media for a planned post and store it permanently. */
export async function generatePost(postId: string) {
  const post = await one<{ id: string; coin_id: string; format: Format; plan: PostPlan; status: string }>(
    `SELECT id, coin_id, format, plan, status FROM posts WHERE id = $1`,
    [postId],
  );
  if (!post || post.status !== "generating") return;
  const coin = await getCoin(post.coin_id);
  if (!coin) return;

  const style = visualStyleText(coin.persona);
  const prompts = post.plan.image_prompts.slice(0, post.format === "carousel" ? 5 : 1);
  if (post.format === "carousel" && prompts.length < 2) throw new PermanentError("Carousel plan has fewer than 2 images");
  const cost = prompts.length * config.COST_IMAGE_USD + (post.format === "reel" ? config.COST_VIDEO_USD : 0);
  if (!(await reserveSpend(cost))) throw new Error("Daily AI budget reached");

  const fullPrompt = (p: string) =>
    `${p}. Keep the main character identical to the reference image. Style: ${style}. No text, captions, logos or watermarks.`;

  const media: Array<{ type: "image" | "video"; url: string; key: string; role?: string }> = [];
  if (post.format === "reel") {
    const keyframe = await generateImage(fullPrompt(prompts[0]!), coin.image_url, "9:16");
    const cover = await rehostImageForInstagram(keyframe, coin.id, "9:16");
    const videoRemote = await generateVideo(`${post.plan.video_prompt ?? "subtle cinematic motion"}. ${style}.`, keyframe);
    const video = await rehostVideo(videoRemote, coin.id);
    media.push({ type: "video", ...video }, { type: "image", role: "cover", ...cover });
  } else {
    for (const p of prompts) {
      const remote = await generateImage(fullPrompt(p), coin.image_url, "1:1");
      media.push({ type: "image", ...(await rehostImageForInstagram(remote, coin.id, "1:1")) });
    }
  }

  const caption = finalizeCaption(
    post.plan.caption,
    [...post.plan.hashtags.slice(0, 5), ...coin.content_settings.hashtags, coin.symbol],
    config.CAPTION_FOOTER,
  );
  const next = coin.content_settings.autoPublish ? "ready" : "awaiting_approval";
  await query(
    `UPDATE posts SET media = $2, caption = $3, status = $4, cost_usd = cost_usd + $5 WHERE id = $1`,
    [postId, JSON.stringify(media), caption, next, cost],
  );
  if (next === "ready") await enqueue("content.publish", { postId }, { dedupeKey: `pub:${postId}`, maxAttempts: 4 });
}

/** Job: publish a ready post to Instagram. */
export async function publishPost(postId: string) {
  const kill = await getKillSwitch();
  if (kill.content) throw new Error("Content kill switch is on");
  const post = await one<{
    id: string;
    coin_id: string;
    format: Format;
    caption: string;
    media: any[];
    status: string;
    ig_container_id: string | null;
  }>(`SELECT id, coin_id, format, caption, media, status, ig_container_id FROM posts WHERE id = $1`, [postId]);
  if (!post || !["ready", "publishing"].includes(post.status)) return;
  const ig = await getInstagram(post.coin_id);
  if (!ig || ig.status !== "active") throw new PermanentError("Instagram account is not connected");

  // Retry safety: if a previous attempt already published this container, don't post it twice.
  if (post.ig_container_id && (await containerStatus(post.ig_container_id, ig.token)) === "PUBLISHED") {
    await query(`UPDATE posts SET status = 'published', published_at = COALESCE(published_at, now()) WHERE id = $1`, [postId]);
    return;
  }

  await query(`UPDATE posts SET status = 'publishing' WHERE id = $1`, [postId]);
  const mediaUrls =
    post.format === "reel"
      ? [post.media.find((m) => m.type === "video")?.url, post.media.find((m) => m.role === "cover")?.url].filter(Boolean)
      : post.media.filter((m) => m.type === "image").map((m) => m.url);

  try {
    const result = await publish(
      { igUserId: ig.igUserId, token: ig.token, format: post.format, caption: post.caption, mediaUrls },
      (containerId) => query(`UPDATE posts SET ig_container_id = $2 WHERE id = $1`, [postId, containerId]).then(() => {}),
    );
    await query(
      `UPDATE posts SET status = 'published', ig_media_id = $2, permalink = $3, published_at = now(), error = NULL WHERE id = $1`,
      [postId, result.mediaId, result.permalink],
    );
  } catch (e) {
    if (e instanceof InstagramError && e.isAuth) {
      await markInstagramExpired(post.coin_id);
      await query(`UPDATE posts SET status = 'failed', error = $2 WHERE id = $1`, [postId, "Instagram connection expired — reconnect"]);
      throw new PermanentError(e.message);
    }
    await query(`UPDATE posts SET status = 'ready', error = $2 WHERE id = $1`, [postId, (e as Error).message.slice(0, 500)]);
    throw e;
  }
}

/** Marks a post failed after its job exhausts retries. */
export async function markPostFailed(postId: string, message: string) {
  await query(`UPDATE posts SET status = 'failed', error = $2 WHERE id = $1 AND status <> 'published'`, [postId, message.slice(0, 500)]);
}

/** Called every minute: enqueue plans for coins whose next post is due. */
export async function scheduleDuePosts() {
  const due = await query<{ id: string; content_settings: { postsPerDay: number } }>(
    `SELECT c.id, c.content_settings FROM coins c
     JOIN instagram_accounts i ON i.coin_id = c.id AND i.status = 'active'
     WHERE c.status = 'live' AND NOT c.content_paused AND (c.next_post_at IS NULL OR c.next_post_at <= now())
     LIMIT 50`,
  );
  for (const c of due.rows) {
    const perDay = Math.min(c.content_settings.postsPerDay ?? 1, config.CONTENT_MAX_POSTS_PER_DAY);
    await query(`UPDATE coins SET next_post_at = $2 WHERE id = $1`, [c.id, nextPostAt(new Date(), perDay)]);
    await enqueue("content.plan", { coinId: c.id, trigger: "schedule" }, { dedupeKey: `plan:${c.id}`, maxAttempts: 3 });
  }
}
