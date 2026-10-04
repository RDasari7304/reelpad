import { config } from "../config.js";
import { enqueue, PermanentError } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { captionViolations, finalizeCaption } from "../domain/caption.js";
import { CONTENT_RULES, personaBrief, visualStyleText } from "../domain/persona.js";
import { chooseFormat, firstPostFormat, nextPostAt, type Format } from "../domain/schedule.js";
import { captionOpener, pickVariety, type Variety } from "../domain/variety.js";
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
  setting: string;
  /** The character's own memory of this post: what happened and how it felt. Fed into later posts. */
  memory: string;
  /** How the character feels right now, in a few words. */
  mood: string;
  /** Something it's looking forward to or left unresolved, which later posts can pick up. */
  next_thread: string;
  /** Chosen by pickVariety and stored so later posts can avoid repeating it. */
  variety?: Variety;
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
    video_prompt: {
      type: "string",
      description: "For reels: the motion/camera direction for a 5-second clip. For other formats, an empty string.",
    },
    setting: {
      type: "string",
      description: "Where this post takes place, in 2 to 6 words (e.g. 'rooftop garden at night'). Must differ from recent settings.",
    },
    memory: {
      type: "string",
      description: "First person, one or two sentences: what you'll remember about this moment and how it made you feel.",
    },
    mood: { type: "string", description: "How you feel right now, in 1 to 4 words." },
    next_thread: {
      type: "string",
      description: "Something you're looking forward to, planning, or left unresolved, which a future post could pick up. One sentence.",
    },
  },
  required: ["concept", "caption", "hashtags", "image_prompts", "video_prompt", "setting", "memory", "mood", "next_thread"],
  additionalProperties: false,
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

function timeAgo(d: Date): string {
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 60) return `${Math.max(1, min)} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Real facts about the character's life so far, so it feels aware of time and its own history. */
function lifeFacts(coin: CoinRow, published: number, burns: number, burned: number, lastPostAt: Date | null): string {
  const now = new Date();
  const day = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const hour = now.getUTCHours();
  const part = hour < 5 ? "late night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
  const ageDays = coin.launched_at ? Math.floor((now.getTime() - coin.launched_at.getTime()) / 86_400_000) : 0;
  return [
    `It's ${day} ${part} (UTC).`,
    ageDays === 0 ? "You came to life today." : `You've existed for ${ageDays} day${ageDays === 1 ? "" : "s"}.`,
    `You've posted ${published} time${published === 1 ? "" : "s"} on Instagram so far.`,
    lastPostAt ? `Your last post was ${timeAgo(lastPostAt)}.` : "",
    burns > 0 ? `Your treasury has burned ${Math.round(burned).toLocaleString("en-US")} $${coin.symbol} across ${burns} burn${burns === 1 ? "" : "s"}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function recentContext(coin: CoinRow) {
  const posts = await query<{ format: string; concept: string; caption: string; plan: Partial<PostPlan> | null; created_at: Date }>(
    `SELECT format, concept, caption, plan, created_at FROM posts
     WHERE coin_id = $1 AND status IN ('published','ready','awaiting_approval','publishing','generating')
     ORDER BY created_at DESC LIMIT 12`,
    [coin.id],
  );
  const counts = await one<{ published: number; burns: number; burned: string | null }>(
    `SELECT (SELECT count(*)::int FROM posts WHERE coin_id = $1 AND status = 'published') AS published,
            (SELECT count(*)::int FROM treasury_actions WHERE coin_id = $1 AND kind = 'burn' AND status = 'done') AS burns,
            (SELECT sum(token_amount::numeric)::text FROM treasury_actions WHERE coin_id = $1 AND kind = 'burn' AND status = 'done') AS burned`,
    [coin.id],
  );
  const plans = posts.rows.map((p) => p.plan ?? {});
  const settings = plans.map((p) => p.setting).filter(Boolean) as string[];
  const openers = posts.rows.map((p) => captionOpener(p.caption)).filter(Boolean);
  const visuals = plans.map((p) => (p.image_prompts?.[0] ?? "").slice(0, 140)).filter(Boolean);
  const actions = await query<{ kind: string; sol_amount: string | null; token_amount: string | null; reason: string; created_at: Date; dry_run: boolean }>(
    `SELECT kind, sol_amount, token_amount, reason, created_at, dry_run FROM treasury_actions
     WHERE coin_id = $1 AND status IN ('done','simulated') ORDER BY created_at DESC LIMIT 5`,
    [coin.id],
  );
  const memories = posts.rows
    .filter((p) => p.plan?.memory)
    .slice(0, 8)
    .map((p) => `${timeAgo(p.created_at)}: ${p.plan!.memory}`);
  const latest = posts.rows.find((p) => p.plan?.mood || p.plan?.next_thread);
  const lastPostAt = posts.rows[0]?.created_at ?? null;
  return {
    memories,
    mood: latest?.plan?.mood ?? null,
    openThread: latest?.plan?.next_thread ?? null,
    life: lifeFacts(coin, counts?.published ?? 0, counts?.burns ?? 0, Number(counts?.burned ?? 0), lastPostAt),
    recentVariety: plans.map((p) => p.variety ?? {}),
    recentSettings: settings.slice(0, 8),
    recentOpeners: openers.slice(0, 6),
    recentVisuals: visuals.slice(0, 5),
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

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

/** How to write so the character feels like it has a continuous inner life, not a stream of disconnected posts. */
const ALIVE_RULES = `How to feel alive:
- You are one continuous character with memories, moods and plans. Write in first person, as yourself, with real inner thoughts.
- Let your recent memories shape this post: follow up on a storyline, call back to something from an earlier post, or show how a feeling has changed. Don't do this every time; sometimes start something new.
- Notice time: the day, how long since your last post, how long you've existed. React to it naturally when it fits.
- Have small, specific opinions, worries, hopes and running jokes. Be a little surprising.
- Sound like a person posting, not a brand: no hashtags or calls to action inside the caption.
- Emoji: none, or at most one per caption.`;

async function planWithClaude(coin: CoinRow, format: Format, note?: string): Promise<PostPlan> {
  const ctx = await recentContext(coin);
  const variety = pickVariety(ctx.recentVariety);
  const system = `${personaBrief(coin, coin.persona)}\n\n${ALIVE_RULES}\n\n${CONTENT_RULES}`;
  const inner = [
    `Your life right now: ${ctx.life}`,
    ctx.mood ? `How you've been feeling: ${ctx.mood}` : "",
    ctx.memories.length ? `Your memories (most recent first):\n${bullets(ctx.memories)}` : "",
    ctx.openThread ? `Something you were looking forward to or left unresolved: ${ctx.openThread}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const brief = [
    `Make this post clearly different from your recent ones. For this post:`,
    `- Post type: ${variety.angle}`,
    `- Camera: ${variety.shot}${format === "carousel" ? " for the first slide; use a different camera angle on every slide" : ""}`,
    `- Lighting and time: ${variety.lighting}`,
    `- Caption style: ${variety.captionStyle}`,
    `- Setting: somewhere new that fits your world${ctx.recentSettings.length ? `, NOT any of these recent settings:\n${bullets(ctx.recentSettings)}` : ""}`,
    ctx.recentOpeners.length ? `Don't open the caption the way your recent captions did:\n${bullets(ctx.recentOpeners.map((o) => `"${o}…"`))}` : "",
    ctx.recentVisuals.length
      ? `Recent images looked like this; change the pose, props, composition and background:\n${bullets(ctx.recentVisuals)}`
      : "",
    `Write image prompts that describe a new pose, action and background. Don't describe the character's look in detail (the reference image handles that).`,
  ]
    .filter(Boolean)
    .join("\n");
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = [
      `Plan your next Instagram post.`,
      formatInstructions(format),
      note ? `Reason for this post: ${note}` : "",
      inner,
      brief,
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
      toolDescription: "the plan for one Instagram post, as JSON matching the schema.",
      schema: PLAN_SCHEMA,
    });
    plan.caption = String(plan.caption ?? "").trim();
    plan.hashtags = Array.isArray(plan.hashtags) ? plan.hashtags.map(String) : [];
    plan.image_prompts = Array.isArray(plan.image_prompts) ? plan.image_prompts.map(String).filter(Boolean) : [];
    plan.setting = String(plan.setting ?? "").trim();
    plan.variety = variety;
    const violations = captionViolations(plan.caption);
    if (violations.length === 0 && plan.caption && plan.image_prompts.length) return plan;
    feedback = `Your previous caption broke the rules (${violations.join(", ") || "missing image prompts"}). Rewrite it without that.`;
  }
  throw new PermanentError("Could not produce a caption that passes the content rules");
}

/** Updates the live progress shown on the post's loading card (0–100). */
async function setProgress(postId: string, progress: number, stage: string) {
  await query(`UPDATE posts SET progress = GREATEST(progress, $2), stage = $3 WHERE id = $1`, [
    postId,
    Math.max(0, Math.min(100, Math.round(progress))),
    stage,
  ]);
}

/** Marks a coin's in-planning post failed (when planning fails for good), so its loading card shows the error. */
export async function markPlanningFailed(coinId: string, message: string) {
  await query(
    `UPDATE posts SET status = 'failed', error = $2, stage = NULL WHERE coin_id = $1 AND status = 'planned'`,
    [coinId, message.slice(0, 500)],
  );
}

/** Shows on the loading card that a step hit a temporary problem and will be retried shortly. */
export async function noteRetry(payload: { postId?: string; coinId?: string }, message: string) {
  const stage = `Hit a snag, retrying shortly (${message.slice(0, 80)})`;
  if (payload.postId) await query(`UPDATE posts SET stage = $2 WHERE id = $1 AND status IN ('generating','ready','publishing')`, [payload.postId, stage]);
  else if (payload.coinId) await query(`UPDATE posts SET stage = $2 WHERE coin_id = $1 AND status = 'planned'`, [payload.coinId, stage]);
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
    `SELECT format FROM posts WHERE coin_id = $1 AND status <> 'planned' ORDER BY created_at DESC LIMIT 3`,
    [coinId],
  );
  const reels = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM posts WHERE coin_id = $1 AND format = 'reel' AND status NOT IN ('rejected','planned')
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

  // Show the loading card straight away. A retry of this job reuses the same card instead of adding another.
  const existing = await one<{ id: string }>(
    `SELECT id FROM posts WHERE coin_id = $1 AND status = 'planned' AND created_at > now() - interval '2 hours'
     ORDER BY created_at DESC LIMIT 1`,
    [coinId],
  );
  const postId =
    existing?.id ??
    (await one<{ id: string }>(
      `INSERT INTO posts(coin_id, format, status, trigger, progress, stage)
       VALUES ($1, $2, 'planned', $3, 5, 'Coming up with the idea') RETURNING id`,
      [coinId, format, trigger],
    ))!.id;
  if (existing) await query(`UPDATE posts SET format = $2, error = NULL WHERE id = $1`, [postId, format]);

  if (!(await reserveSpend(config.COST_LLM_USD))) throw new Error("Daily AI budget reached");
  await setProgress(postId, 8, "Writing the idea and caption");
  const plan = await planWithClaude(coin, format, note);
  await query(
    `UPDATE posts SET status = 'generating', concept = $2, plan = $3, cost_usd = $4, progress = GREATEST(progress, 20),
            stage = 'Caption written, starting the visuals' WHERE id = $1`,
    [postId, plan.concept, JSON.stringify(plan), config.COST_LLM_USD],
  );
  await enqueue("content.generate", { postId }, { dedupeKey: `gen:${postId}`, maxAttempts: 3 });
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

  // The reference image keeps the character recognisable; everything else must be new, or every post looks the same.
  const v = post.plan.variety;
  const fullPrompt = (p: string, i = 0) =>
    [
      p,
      post.plan.setting ? `Setting: ${post.plan.setting}.` : "",
      v ? `Camera: ${i === 0 ? v.shot : "a different camera angle from the previous slide"}. Lighting: ${v.lighting}.` : "",
      "Keep the character's identity from the reference image (same face, markings and colours),",
      "but use a completely new pose, expression, scene, background and composition; do not copy the reference image's pose, framing or background.",
      `Style: ${style}. No text, captions, logos or watermarks.`,
    ]
      .filter(Boolean)
      .join(" ");

  const media: Array<{ type: "image" | "video"; url: string; key: string; role?: string }> = [];
  if (post.format === "reel") {
    await setProgress(postId, 22, "Drawing the opening frame");
    const keyframe = await generateImage(fullPrompt(prompts[0]!), coin.image_url, "9:16");
    const cover = await rehostImageForInstagram(keyframe, coin.id, "9:16");
    await setProgress(postId, 35, "Animating the Reel");
    // Video takes a few minutes; progress moves from 35% to 85% as it renders.
    const videoRemote = await generateVideo(
      `${post.plan.video_prompt?.trim() || "subtle cinematic motion"}. ${style}.`,
      keyframe,
      (fraction) => setProgress(postId, 35 + fraction * 50, "Animating the Reel"),
    );
    await setProgress(postId, 87, "Saving the video");
    const video = await rehostVideo(videoRemote, coin.id);
    media.push({ type: "video", ...video }, { type: "image", role: "cover", ...cover });
  } else {
    for (const [i, p] of prompts.entries()) {
      const label = prompts.length > 1 ? `Drawing image ${i + 1} of ${prompts.length}` : "Drawing the image";
      await setProgress(postId, 22 + (i / prompts.length) * 63, label);
      const remote = await generateImage(fullPrompt(p, i), coin.image_url, "1:1");
      media.push({ type: "image", ...(await rehostImageForInstagram(remote, coin.id, "1:1")) });
    }
  }
  await setProgress(postId, 88, "Finishing the caption");

  const caption = finalizeCaption(
    post.plan.caption,
    [...post.plan.hashtags.slice(0, 5), ...coin.content_settings.hashtags, coin.symbol],
    config.CAPTION_FOOTER,
  );
  const next = coin.content_settings.autoPublish ? "ready" : "awaiting_approval";
  // Review mode: the post is finished (100%) and waits for approval. Auto-publish: 90%, posting comes next.
  await query(
    `UPDATE posts SET media = $2, caption = $3, status = $4, cost_usd = cost_usd + $5, progress = $6, stage = $7 WHERE id = $1`,
    [postId, JSON.stringify(media), caption, next, cost, next === "ready" ? 90 : 100, next === "ready" ? "Queued to post" : null],
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
    await query(
      `UPDATE posts SET status = 'published', progress = 100, stage = NULL, published_at = COALESCE(published_at, now()) WHERE id = $1`,
      [postId],
    );
    return;
  }

  await query(`UPDATE posts SET status = 'publishing', progress = GREATEST(progress, 92), stage = 'Posting to Instagram' WHERE id = $1`, [postId]);
  const mediaUrls =
    post.format === "reel"
      ? [post.media.find((m) => m.type === "video")?.url, post.media.find((m) => m.role === "cover")?.url].filter(Boolean)
      : post.media.filter((m) => m.type === "image").map((m) => m.url);

  try {
    const result = await publish(
      { igUserId: ig.igUserId, token: ig.token, format: post.format, caption: post.caption, mediaUrls },
      (containerId) =>
        query(
          `UPDATE posts SET ig_container_id = $2, progress = GREATEST(progress, 95), stage = $3 WHERE id = $1`,
          [postId, containerId, post.format === "reel" ? "Instagram is processing the video" : "Instagram is processing the post"],
        ).then(() => {}),
    );
    await query(
      `UPDATE posts SET status = 'published', ig_media_id = $2, permalink = $3, published_at = now(), error = NULL,
              progress = 100, stage = NULL WHERE id = $1`,
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
  await query(`UPDATE posts SET status = 'failed', error = $2, stage = NULL WHERE id = $1 AND status <> 'published'`, [
    postId,
    message.slice(0, 500),
  ]);
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
