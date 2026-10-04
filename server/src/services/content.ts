import { config } from "../config.js";
import { enqueue, PermanentError } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { captionViolations, finalizeCaption } from "../domain/caption.js";
import { CONTENT_RULES, personaBrief, personalityText, visualStyleText } from "../domain/persona.js";
import { cleanSpokenLine, maxSpokenWords, reelVideoPrompt, speakingVoice } from "../domain/reel.js";
import { postsPerDayFor, reelsAllowed } from "../domain/activity.js";
import { supportsMultiReference } from "../domain/images.js";
import { isStandalone, storyBrief, type Arc } from "../domain/story.js";
import { chooseFormat, firstPostFormat, nextPostAt, type Format } from "../domain/schedule.js";
import { captionOpener, pickVariety, type Variety } from "../domain/variety.js";
import { logger } from "../lib/logger.js";
import { structured } from "./ai/claude.js";
import { generateImage, generateVideo, reelSeconds, reelsHaveAudio } from "./ai/fal.js";
import { reviewImage } from "./ai/review.js";
import { getCoin, getInstagram, markInstagramExpired, type CoinRow } from "./coins.js";
import { containerStatus, InstagramError, publish } from "./instagram.js";
import { rehostImageForInstagram, rehostVideo } from "./media.js";
import { getKillSwitch } from "./settings.js";
import { commentMemories } from "./comments.js";
import { markMilestonePosted, takePendingMilestone } from "./milestones.js";
import { fanChoice } from "./polls.js";
import { collabBrief, markCollab, pickCollabPartner, type CollabPartner } from "./collabs.js";
import { activeArc, ensureArc, recordStoryPost } from "./story.js";
import { roomMemories } from "./room.js";
import { reserveSpend } from "./spend.js";

interface PostPlan {
  concept: string;
  caption: string;
  hashtags: string[];
  image_prompts: string[];
  video_prompt?: string;
  /** Reels: the one line the character says out loud on camera. */
  spoken_line?: string;
  /** Reels: the sound effects and ambience heard in the clip. */
  sound?: string;
  setting: string;
  /** The character's own memory of this post: what happened and how it felt. Fed into later posts. */
  memory: string;
  /** How the character feels right now, in a few words. */
  mood: string;
  /** Something it's looking forward to or left unresolved, which later posts can pick up. */
  next_thread: string;
  /** Chosen by pickVariety and stored so later posts can avoid repeating it. */
  variety?: Variety;
  /** Collab posts: the friend featured and invited as an Instagram collaborator. */
  collab?: { coinId: string; name: string; symbol: string; instagram: string | null; imageUrl: string };
  /** Story posts: one sentence on what happened in the story in this post. */
  episode_recap?: string;
  /** Story posts: true if this post wrapped up the current episode. */
  episode_complete?: boolean;
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
      description: "For reels: the motion/camera direction for the clip. For other formats, an empty string.",
    },
    spoken_line: {
      type: "string",
      description:
        "For reels: the exact words you say out loud to the camera, in English, in your voice. Short enough to say in the clip. No stage directions, emoji or hashtags. For other formats, an empty string.",
    },
    sound: {
      type: "string",
      description:
        "For reels: the sound effects and ambience heard in the clip (e.g. 'rain on a tin roof, distant traffic'). No music with lyrics. For other formats, an empty string.",
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
    episode_recap: {
      type: "string",
      description: "If this post is part of your storyline: one sentence, past tense, on what happened in the story in this post. Otherwise an empty string.",
    },
    episode_complete: {
      type: "boolean",
      description: "If this post is part of your storyline: true when it wraps up the current episode. Otherwise false.",
    },
    next_thread: {
      type: "string",
      description: "Something you're looking forward to, planning, or left unresolved, which a future post could pick up. One sentence.",
    },
  },
  required: ["concept", "caption", "hashtags", "image_prompts", "video_prompt", "spoken_line", "sound", "setting", "memory", "mood", "next_thread", "episode_recap", "episode_complete"],
  additionalProperties: false,
};

function formatInstructions(format: Format) {
  switch (format) {
    case "image":
      return "Format: single image post. Provide exactly 1 image prompt.";
    case "carousel":
      return "Format: carousel. Provide 3 to 5 image prompts that tell a short visual story in order.";
    case "reel": {
      const secs = reelSeconds();
      const base = `Format: ${secs}-second vertical Reel. Provide exactly 1 image prompt for the opening keyframe (vertical 9:16 composition, the character facing the camera) and a video_prompt describing the motion.`;
      return reelsHaveAudio()
        ? `${base} The Reel has sound and you talk in it: write a spoken_line you say straight to the camera (at most ${maxSpokenWords(secs)} words, spoken English, natural and in character; it should add something the caption doesn't, not read the caption out) and a sound line for the ambience and sound effects.`
        : `${base} The Reel is silent: leave spoken_line and sound empty.`;
    }
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
  // Who it met in the Room lately, so posts can mention those encounters.
  const met = await roomMemories(coin.id, 3).catch(() => []);
  memories.push(...met.map((m) => `${timeAgo(m.starts_at)}, in the Room with ${m.other}: ${m.memory}`));
  // What fans said lately and how it answered, so posts can call back to the comments.
  const fans = await commentMemories(coin.id, 3).catch(() => []);
  memories.push(...fans.map((f) => `${timeAgo(f.replied_at)}, a fan @${f.username} commented "${f.text.slice(0, 120)}" and you replied "${f.reply_text.slice(0, 120)}"`));
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

async function planWithClaude(
  coin: CoinRow,
  format: Format,
  note: string | undefined,
  opts: { story: boolean; collab?: CollabPartner | null },
): Promise<{ plan: PostPlan; arc: Arc | null }> {
  const ctx = await recentContext(coin);
  // Story posts move the character's current storyline forward (planning a new one when needed);
  // standalone posts are everyday moments in between that may nod to the story.
  const arc = opts.story ? await ensureArc(coin, { memories: ctx.memories, life: ctx.life }) : await activeArc(coin.id);
  const choice = arc && opts.story ? await fanChoice(arc.id, arc.currentBeat).catch(() => null) : null;
  const storyText = arc
    ? opts.story
      ? `${storyBrief(arc)}${choice ? `\nYour followers voted on how this episode goes, and they chose: "${choice}". Make the episode go that way, and you can thank them for picking it.` : ""}`
      : `Your current storyline is "${arc.title}" (${arc.premise}). This post is NOT a story episode: it's an everyday, standalone moment in between. It can nod to what's going on, but don't move the plot forward.`
    : "";
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
    arc && opts.story
      ? `- Setting: wherever this moment of the story happens. If it's the same place as a recent post, show it from a new angle or at a different time.`
      : `- Setting: somewhere new that fits your world${ctx.recentSettings.length ? `, NOT any of these recent settings:\n${bullets(ctx.recentSettings)}` : ""}`,
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
      storyText,
      opts.collab ? collabBrief(opts.collab) : "",
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
    plan.spoken_line = format === "reel" && reelsHaveAudio() ? cleanSpokenLine(plan.spoken_line ?? "", reelSeconds()) : "";
    plan.sound = format === "reel" ? String(plan.sound ?? "").trim().slice(0, 200) : "";
    plan.variety = variety;
    plan.episode_recap = arc && opts.story ? String(plan.episode_recap ?? "").trim().slice(0, 300) : "";
    plan.episode_complete = arc && opts.story ? plan.episode_complete === true : false;
    const violations = captionViolations(plan.caption);
    if (opts.collab) {
      plan.collab = {
        coinId: opts.collab.coinId,
        name: opts.collab.name,
        symbol: opts.collab.symbol,
        instagram: opts.collab.instagram,
        imageUrl: opts.collab.imageUrl,
      };
      // Make sure the friend is tagged even if the caption forgot.
      if (!plan.caption.toLowerCase().includes(`@${opts.collab.instagram.toLowerCase()}`)) plan.caption += ` (with @${opts.collab.instagram})`;
    }
    if (violations.length === 0 && plan.caption && plan.image_prompts.length) return { plan, arc: opts.story ? arc : null };
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
  // Coins whose trading has dried up still post a little, but no Reels (the most expensive format).
  const reelsCap = reelsAllowed(coin.activity_state ?? "active")
    ? Math.min(coin.content_settings.reelsPerWeek, config.CONTENT_MAX_REELS_PER_WEEK)
    : 0;
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
  // A milestone (graduation, all-time high, market cap level, record burn) waiting for its post takes this one.
  let milestone: { kind: string; key: string; note: string } | null = null;
  if (!note && (trigger === "schedule" || trigger === "milestone")) {
    milestone = await takePendingMilestone(coinId);
    if (milestone) {
      note = milestone.note;
      trigger = "milestone";
    }
  }
  // Most posts move the storyline on; every few posts (and treasury posts) are standalone moments.
  const count = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM posts WHERE coin_id = $1 AND status NOT IN ('planned','rejected','failed')`,
    [coinId],
  );
  // Now and then a scheduled post becomes a collab with a friend from the Room.
  const collab = !note && trigger === "schedule" ? await pickCollabPartner(coin).catch(() => null) : null;
  if (collab) trigger = "collab";
  const { plan, arc } = await planWithClaude(coin, format, note, { story: !isStandalone(count?.n ?? 0, trigger), collab });
  await query(
    `UPDATE posts SET status = 'generating', concept = $2, plan = $3, cost_usd = $4, progress = GREATEST(progress, 20),
            stage = 'Caption written, starting the visuals' WHERE id = $1`,
    [postId, plan.concept, JSON.stringify(plan), config.COST_LLM_USD],
  );
  if (arc) await recordStoryPost(coin, postId, arc, plan.episode_recap ?? "", plan.episode_complete === true);
  if (milestone) await markMilestonePosted(coinId, milestone.kind, milestone.key);
  if (collab) await markCollab(postId, collab.coinId);
  await enqueue("content.generate", { postId }, { dedupeKey: `gen:${postId}`, maxAttempts: 3 });
}

/**
 * Draws an image, then (premium tier) has Claude compare it with the token image. If the character
 * doesn't match or the image is broken, it's redrawn once with Claude's note.
 */
async function drawChecked(postId: string, prompt: string, refs: string[], aspect: "1:1" | "9:16", stage: string) {
  const ref = refs[0]!;
  const first = await generateImage(prompt, refs, aspect);
  if (!config.QUALITY_CHECK || !(await reserveSpend(config.COST_CHECK_USD))) return first;
  await query(`UPDATE posts SET stage = $2 WHERE id = $1`, [postId, stage]);
  const review = await reviewImage(first, ref, prompt);
  await query(`UPDATE posts SET cost_usd = cost_usd + $2 WHERE id = $1`, [postId, config.COST_CHECK_USD]);
  if (review.pass || !(await reserveSpend(config.COST_IMAGE_USD))) return first;
  logger.info({ postId, fix: review.fix }, "image failed the quality check; redrawing");
  await query(`UPDATE posts SET stage = 'Redrawing to match the character', cost_usd = cost_usd + $2 WHERE id = $1`, [postId, config.COST_IMAGE_USD]);
  return generateImage(`${prompt} Important: ${review.fix || "match the reference character exactly."}`, refs, aspect);
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
  // Collab posts draw both characters: this coin's image first, the friend's second.
  const refs = [coin.image_url, ...(post.plan.collab?.imageUrl && supportsMultiReference(config.FAL_IMAGE_MODEL) ? [post.plan.collab.imageUrl] : [])];
  const prompts = post.plan.image_prompts.slice(0, post.format === "carousel" ? 5 : 1);
  if (post.format === "carousel" && prompts.length < 2) throw new PermanentError("Carousel plan has fewer than 2 images");
  const cost = prompts.length * config.COST_IMAGE_USD + (post.format === "reel" ? config.COST_REEL_USD : 0);
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
    const keyframe = await drawChecked(postId, fullPrompt(prompts[0]!), refs, "9:16", "Checking the opening frame");
    const cover = await rehostImageForInstagram(keyframe, coin.id, "9:16");
    const audio = reelsHaveAudio();
    const stage = audio && post.plan.spoken_line ? "Filming the Reel: voice, lip sync and sound" : audio ? "Filming the Reel with sound" : "Animating the Reel";
    await setProgress(postId, 35, stage);
    // Video takes a few minutes; progress moves from 35% to 85% as it renders.
    const videoRemote = await generateVideo(
      reelVideoPrompt({
        motion: post.plan.video_prompt ?? "",
        spokenLine: audio ? cleanSpokenLine(post.plan.spoken_line ?? "", reelSeconds()) : "",
        sound: post.plan.sound ?? "",
        voice: speakingVoice(coin.persona.voice ?? "", personalityText(coin.persona)),
        style,
        audio,
      }),
      keyframe,
      (fraction) => setProgress(postId, 35 + fraction * 50, stage),
    );
    await setProgress(postId, 87, "Saving the video");
    const video = await rehostVideo(videoRemote, coin.id);
    media.push({ type: "video", ...video }, { type: "image", role: "cover", ...cover });
  } else {
    for (const [i, p] of prompts.entries()) {
      const label = prompts.length > 1 ? `Drawing image ${i + 1} of ${prompts.length}` : "Drawing the image";
      await setProgress(postId, 22 + (i / prompts.length) * 63, label);
      const remote = await drawChecked(postId, fullPrompt(p, i), refs, "1:1", `${label}: quality check`);
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
    plan: PostPlan | null;
  }>(`SELECT id, coin_id, format, caption, media, status, ig_container_id, plan FROM posts WHERE id = $1`, [postId]);
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
      {
        igUserId: ig.igUserId,
        token: ig.token,
        format: post.format,
        caption: post.caption,
        mediaUrls,
        // Collab posts invite the partner's account, so the post can appear on both profiles.
        collaborators: post.plan?.collab?.instagram ? [post.plan.collab.instagram] : [],
      },
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
  // Dormant coins (no real trading for days) don't post at all; they're revived when trading returns.
  const due = await query<{ id: string; content_settings: { postsPerDay: number }; activity_state: "active" | "cooling" | "dormant" }>(
    `SELECT c.id, c.content_settings, c.activity_state FROM coins c
     JOIN instagram_accounts i ON i.coin_id = c.id AND i.status = 'active'
     WHERE c.status = 'live' AND NOT c.content_paused AND c.activity_state <> 'dormant'
       AND (c.next_post_at IS NULL OR c.next_post_at <= now())
     LIMIT 50`,
  );
  for (const c of due.rows) {
    const setting = Math.min(
      config.CONTENT_MAX_POSTS_PER_DAY,
      Math.max(config.CONTENT_MIN_POSTS_PER_DAY, c.content_settings.postsPerDay ?? config.CONTENT_MIN_POSTS_PER_DAY),
    );
    const perDay = postsPerDayFor(c.activity_state ?? "active", setting);
    if (perDay <= 0) continue;
    await query(`UPDATE coins SET next_post_at = $2 WHERE id = $1`, [c.id, nextPostAt(new Date(), perDay)]);
    await enqueue("content.plan", { coinId: c.id, trigger: "schedule" }, { dedupeKey: `plan:${c.id}`, maxAttempts: 3 });
  }
}
