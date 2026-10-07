import { config } from "../config.js";
import { one, query } from "../db/pool.js";
import { CONTENT_RULES, personaBrief } from "../domain/persona.js";
import { advance, MAX_BEATS, MIN_BEATS, normalizeArc, publicArc, type Arc } from "../domain/story.js";
import { logger } from "../lib/logger.js";
import { structured } from "./ai/claude.js";
import type { CoinRow } from "./coins.js";
import { closePoll, openPoll, openPollView } from "./polls.js";
import { reserveSpend } from "./spend.js";

/** Loads, plans and advances each influencer's storyline (see domain/story.ts). */

function toArc(r: any): Arc {
  return {
    id: r.id,
    title: r.title,
    premise: r.premise,
    beats: r.beats,
    currentBeat: r.current_beat,
    postsInBeat: r.posts_in_beat,
    status: r.status,
  };
}

export async function activeArc(coinId: string): Promise<Arc | null> {
  const r = await one(`SELECT * FROM story_arcs WHERE coin_id = $1 AND status = 'active'`, [coinId]);
  return r ? toArc(r) : null;
}

const ARC_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short, catchy name for this storyline (2 to 6 words)." },
    premise: { type: "string", description: "Two or three sentences: the situation, what you want, and what's in the way." },
    beats: {
      type: "array",
      description: `${MIN_BEATS} to ${MAX_BEATS} episodes, in order: a setup, rising trouble, a turning point, a climax and a resolution.`,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Episode name, 2 to 6 words." },
          summary: {
            type: "string",
            description: "What happens in this episode, concretely and visually (it will be shown in 2-3 TikTok posts).",
          },
        },
        required: ["title", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "premise", "beats"],
  additionalProperties: false,
};

/**
 * Returns the coin's active storyline, planning a new one when there is none (first post, or the
 * last story just finished). Returns null if planning isn't possible right now (budget, API error):
 * the post then goes ahead as a standalone moment.
 */
export async function ensureArc(coin: CoinRow, context: { memories: string[]; life: string }): Promise<Arc | null> {
  const current = await activeArc(coin.id);
  if (current) return current;
  if (!(await reserveSpend(config.COST_LLM_USD))) return null;

  const past = await query<{ title: string; premise: string; beats: any[] }>(
    `SELECT title, premise, beats FROM story_arcs WHERE coin_id = $1 AND status = 'done' ORDER BY completed_at DESC LIMIT 3`,
    [coin.id],
  );
  const friends = await query<{ name: string; summary: string }>(
    `SELECT o.name, r.summary FROM room_conversations r
     JOIN coins o ON o.id = CASE WHEN r.coin_a = $1 THEN r.coin_b ELSE r.coin_a END
     WHERE (r.coin_a = $1 OR r.coin_b = $1) AND r.ends_at < now() ORDER BY r.ends_at DESC LIMIT 4`,
    [coin.id],
  );
  const pastText = past.rows
    .map((a) => {
      const last = a.beats[a.beats.length - 1];
      return `- "${a.title}": ${a.premise} Ending: ${last?.recap ?? last?.summary ?? ""}`;
    })
    .join("\n");

  try {
    const raw = await structured<{ title: string; premise: string; beats: Array<{ title: string; summary: string }> }>({
      system: `${personaBrief(coin, coin.persona)}\n\n${CONTENT_RULES}`,
      user: [
        `Plan your next storyline: a story you'll live through on TikTok over the next few days, told across many posts.`,
        `Your life right now: ${context.life}`,
        context.memories.length ? `Your recent memories:\n${context.memories.slice(0, 8).map((m) => `- ${m}`).join("\n")}` : "",
        pastText
          ? `Your previous storylines (the new one continues your life from where the last ended, with callbacks, but is a NEW adventure, not a repeat):\n${pastText}`
          : "This is your first storyline: it should also introduce who you are.",
        friends.rows.length
          ? `Characters you've met in the Room (they may make cameo appearances, as themselves):\n${friends.rows.map((f) => `- ${f.name}: ${f.summary}`).join("\n")}`
          : "",
        `Make it unmistakably YOUR story: driven by your personality, backstory and goals, with a clear want, escalating trouble, a turning point and a payoff. It must work visually (each episode becomes 2-3 images or short videos) and stay light and fun. No price talk, no buy calls.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      toolName: "storyline",
      toolDescription: "the storyline as JSON matching the schema.",
      schema: ARC_SCHEMA,
      maxTokens: 2000,
    });
    const arc = normalizeArc(raw);
    if (!arc) return null;
    const r = await one(
      `INSERT INTO story_arcs(coin_id, title, premise, beats) VALUES ($1,$2,$3,$4)
       ON CONFLICT (coin_id) WHERE status = 'active' DO NOTHING RETURNING *`,
      [coin.id, arc.title, arc.premise, JSON.stringify(arc.beats)],
    );
    logger.info({ coin: coin.symbol, title: arc.title }, "new storyline");
    const created = r ? toArc(r) : await activeArc(coin.id);
    // Episode 1 starts now; followers vote on how episode 2 goes.
    if (created) await openPoll(coin, created, 1).catch(() => {});
    return created;
  } catch (e) {
    logger.warn({ coin: coin.symbol, err: (e as Error).message }, "storyline planning failed; posting standalone");
    return null;
  }
}

/** After a story post is planned: tie the post to its episode and move the story on (once per post). */
export async function recordStoryPost(coin: CoinRow, postId: string, arc: Arc, recap: string, beatComplete: boolean) {
  const claimed = await one(`UPDATE posts SET arc_id = $2, beat = $3 WHERE id = $1 AND arc_id IS NULL RETURNING id`, [
    postId,
    arc.id,
    arc.currentBeat,
  ]);
  if (!claimed) return; // a retry of the same post: the story already moved on for it
  const next = advance(arc, { recap, beatComplete });
  await query(
    `UPDATE story_arcs SET beats = $2, current_beat = $3, posts_in_beat = $4, status = $5,
            completed_at = CASE WHEN $5 = 'done' THEN now() ELSE completed_at END
     WHERE id = $1`,
    [arc.id, JSON.stringify(next.beats), next.currentBeat, next.postsInBeat, next.status],
  );
  if (next.status === "done") logger.info({ arc: arc.title }, "storyline finished");
  // A new episode just started: the poll that decided it closes, and fans vote on the one after it.
  if (next.status === "active" && next.currentBeat !== arc.currentBeat) {
    await closePoll(arc.id, next.currentBeat).catch(() => {});
    await openPoll(coin, next, next.currentBeat + 1).catch(() => {});
  }
}

/** The coin page's storyline card: the current story and the last finished ones, without spoilers. */
export async function storyView(coinId: string, wallet?: string) {
  const rows = await query(
    `SELECT * FROM story_arcs WHERE coin_id = $1 AND status IN ('active','done') ORDER BY created_at DESC LIMIT 4`,
    [coinId],
  );
  const arcs = rows.rows.map((r) => ({ ...publicArc(toArc(r)), startedAt: r.created_at, completedAt: r.completed_at }));
  const current = arcs.find((a) => a.status === "active") ?? null;
  const past = arcs.filter((a) => a.status === "done").slice(0, 3);
  // Before the first storyline exists: what the character has been up to lately, from its own posts
  // (their concepts and the character's memory of each), so the card already shows the thread of its life.
  let lately: Array<{ title: string; recap: string | null; at: Date }> = [];
  if (!current && !past.length) {
    const posts = await query<{ concept: string | null; plan: any; published_at: Date }>(
      `SELECT concept, plan, published_at FROM posts WHERE coin_id = $1 AND status = 'published'
       ORDER BY published_at DESC LIMIT 4`,
      [coinId],
    );
    lately = posts.rows
      .filter((p) => p.concept || p.plan?.memory)
      .reverse()
      .map((p) => ({
        title: String(p.plan?.setting || p.concept || "").slice(0, 60),
        recap: p.plan?.memory ? String(p.plan.memory).slice(0, 240) : p.concept ? String(p.concept).slice(0, 240) : null,
        at: p.published_at,
      }));
  }
  const poll = current ? await openPollView(coinId, wallet) : null;
  return { current, past, lately, poll };
}
