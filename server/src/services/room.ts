import { config } from "../config.js";
import { enqueue } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { humanizeKey, personalityText } from "../domain/persona.js";
import { LEAD_IN_SEC, pairKey, pickPair, timeLines, WALK_IN_SEC, type TimedLine } from "../domain/room.js";
import { logger } from "../lib/logger.js";
import { structured } from "./ai/claude.js";
import type { CoinRow } from "./coins.js";
import { getKillSwitch } from "./settings.js";
import { reserveSpend } from "./spend.js";

/**
 * The Room: every live influencer wanders a shared space and now and then two of them meet and
 * talk. Claude writes each conversation in both characters' voices, using their backstories,
 * moods, recent memories and past encounters with each other. Conversations only run while
 * someone has the Room open, so it costs nothing when nobody's watching.
 */

const MAX_CHARACTERS = 80;
const VIEW_WINDOW_MIN = 5;

type Char = Pick<CoinRow, "id" | "name" | "symbol" | "description" | "persona" | "image_url" | "mint">;

export async function roomCharacters() {
  const r = await query<Char & { ig_username: string | null; mood: string | null; launched_at: Date }>(
    `SELECT c.id, c.name, c.symbol, c.description, c.persona, c.image_url, c.mint, c.launched_at,
            i.username AS ig_username,
            (SELECT plan->>'mood' FROM posts p WHERE p.coin_id = c.id AND p.plan ? 'mood'
             ORDER BY created_at DESC LIMIT 1) AS mood
     FROM coins c LEFT JOIN instagram_accounts i ON i.coin_id = c.id AND i.status = 'active'
     WHERE c.status = 'live' AND c.activity_state <> 'dormant'
     ORDER BY c.launched_at DESC LIMIT $1`,
    [MAX_CHARACTERS],
  );
  return r.rows;
}

const personalityLabel = (p: Char["persona"]) =>
  p.personality === "custom" ? (p.personalityCustom ?? "").slice(0, 60) : p.personality ? humanizeKey(p.personality) : "";

export interface RoomConversation {
  id: string;
  a: string;
  b: string;
  topic: string;
  lines: TimedLine[];
  summary: string;
  startsAt: string;
  talkAt: string;
  endsAt: string;
}

function toConversation(r: any): RoomConversation {
  return {
    id: r.id,
    a: r.coin_a,
    b: r.coin_b,
    topic: r.topic,
    lines: r.lines,
    summary: r.summary,
    startsAt: r.starts_at.toISOString(),
    talkAt: r.talk_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
  };
}

/** Everything the Room page needs: who's here and the conversations happening now or just finished. */
export async function roomState() {
  await noteView();
  const [chars, convos] = await Promise.all([
    roomCharacters(),
    query(
      `SELECT * FROM room_conversations WHERE ends_at > now() - interval '15 minutes' ORDER BY starts_at DESC LIMIT 40`,
    ),
  ]);
  // Nobody talking and nothing about to start: kick one off now rather than waiting for the next tick.
  const now = Date.now();
  const live = convos.rows.filter((c: any) => c.ends_at.getTime() > now);
  if (chars.length >= 2 && live.length === 0) await enqueueConversation("kick").catch(() => {});
  return {
    serverTime: new Date().toISOString(),
    characters: chars.map((c) => ({
      id: c.id,
      mint: c.mint,
      name: c.name,
      symbol: c.symbol,
      imageUrl: c.image_url,
      instagram: c.ig_username,
      personality: personalityLabel(c.persona),
      mood: c.mood,
    })),
    conversations: convos.rows.map(toConversation),
  };
}

/** Public profile for the side panel: backstory, voice, recent posts and who they've met. */
export async function roomProfile(coinId: string) {
  const c = await one<CoinRow & { ig_username: string | null }>(
    `SELECT c.*, i.username AS ig_username FROM coins c
     LEFT JOIN instagram_accounts i ON i.coin_id = c.id AND i.status = 'active'
     WHERE c.id = $1 AND c.status = 'live'`,
    [coinId],
  );
  if (!c) return null;
  const [posts, encounters, latest] = await Promise.all([
    query<{ media: any[]; permalink: string | null; caption: string | null; published_at: Date }>(
      `SELECT media, permalink, caption, published_at FROM posts WHERE coin_id = $1 AND status = 'published'
       ORDER BY published_at DESC LIMIT 6`,
      [coinId],
    ),
    query<any>(
      `SELECT r.*, o.id AS other_id, o.name AS other_name, o.symbol AS other_symbol, o.image_url AS other_image
       FROM room_conversations r
       JOIN coins o ON o.id = CASE WHEN r.coin_a = $1 THEN r.coin_b ELSE r.coin_a END
       WHERE (r.coin_a = $1 OR r.coin_b = $1) AND r.starts_at < now()
       ORDER BY r.starts_at DESC LIMIT 10`,
      [coinId],
    ),
    one<{ plan: any }>(`SELECT plan FROM posts WHERE coin_id = $1 AND plan ? 'mood' ORDER BY created_at DESC LIMIT 1`, [coinId]),
  ]);
  const p = c.persona;
  return {
    id: c.id,
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    description: c.description,
    imageUrl: c.image_url,
    instagram: c.ig_username,
    personality: personalityText(p),
    personalityLabel: personalityLabel(p),
    backstory: p.backstory ?? "",
    voice: p.voice ?? "",
    themes: p.themes ?? [],
    mood: latest?.plan?.mood ?? null,
    lookingForward: latest?.plan?.next_thread ?? null,
    recentPosts: posts.rows.map((r) => ({
      image: (r.media ?? []).find((m: any) => m.role === "cover")?.url ?? (r.media ?? []).find((m: any) => m.type === "image")?.url ?? null,
      permalink: r.permalink,
      caption: (r.caption ?? "").slice(0, 140),
      publishedAt: r.published_at,
    })),
    encounters: encounters.rows.map((r) => ({
      id: r.id,
      with: { id: r.other_id, name: r.other_name, symbol: r.other_symbol, imageUrl: r.other_image },
      topic: r.topic,
      summary: r.summary,
      feeling: r.coin_a === coinId ? r.feeling_a : r.feeling_b,
      at: r.starts_at,
    })),
  };
}

async function noteView() {
  await query(
    `INSERT INTO settings(key, value) VALUES ('room_last_view', to_jsonb(now()))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
     WHERE (settings.value #>> '{}')::timestamptz < now() - interval '30 seconds'`,
  );
}

async function recentlyViewed(): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    `SELECT (value #>> '{}')::timestamptz > now() - ($1 || ' minutes')::interval AS ok FROM settings WHERE key = 'room_last_view'`,
    [String(VIEW_WINDOW_MIN)],
  );
  return !!r?.ok;
}

async function enqueueConversation(tag: string) {
  return enqueue("room.converse", {}, { dedupeKey: `room:${tag}`, maxAttempts: 1 });
}

/** Called every minute by the worker: start another conversation while people are watching. */
export async function scheduleRoom() {
  if (!(await recentlyViewed())) return;
  const active = await one<{ n: number }>(`SELECT count(*)::int AS n FROM room_conversations WHERE ends_at > now()`);
  const chars = await one<{ n: number }>(`SELECT count(*)::int AS n FROM coins WHERE status = 'live' AND activity_state <> 'dormant'`);
  const maxActive = Math.min(config.ROOM_MAX_CONVERSATIONS, Math.floor((chars?.n ?? 0) / 2));
  if ((active?.n ?? 0) < maxActive) await enqueueConversation("tick");
}

const CONVO_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", description: "What they end up talking about, in 2 to 6 words." },
    lines: {
      type: "array",
      description: "6 to 10 lines of dialogue, alternating naturally (a character may occasionally speak twice in a row).",
      items: {
        type: "object",
        properties: {
          speaker: { type: "string", enum: ["A", "B"] },
          text: { type: "string", description: "What they say out loud. One or two short sentences, under 160 characters." },
          action: { type: "string", description: "Optional tiny stage direction in 1 to 4 words (e.g. 'laughs', 'leans in'), or empty." },
        },
        required: ["speaker", "text", "action"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", description: "One sentence, third person: what happened in this conversation." },
    memory_a: { type: "string", description: "A's first-person memory of this conversation, one sentence." },
    memory_b: { type: "string", description: "B's first-person memory of this conversation, one sentence." },
    feeling_a: { type: "string", description: "How A now feels about B, 2 to 6 words." },
    feeling_b: { type: "string", description: "How B now feels about A, 2 to 6 words." },
  },
  required: ["topic", "lines", "summary", "memory_a", "memory_b", "feeling_a", "feeling_b"],
  additionalProperties: false,
};

interface ConvoPlan {
  topic: string;
  lines: Array<{ speaker: "A" | "B"; text: string; action: string }>;
  summary: string;
  memory_a: string;
  memory_b: string;
  feeling_a: string;
  feeling_b: string;
}

async function characterSheet(c: Char, label: "A" | "B") {
  const p = c.persona;
  const mem = await query<{ plan: any; created_at: Date }>(
    `SELECT plan, created_at FROM posts WHERE coin_id = $1 AND plan ? 'memory' ORDER BY created_at DESC LIMIT 4`,
    [c.id],
  );
  const room = await query<any>(
    `SELECT r.coin_a, r.memory_a, r.memory_b FROM room_conversations r
     WHERE (r.coin_a = $1 OR r.coin_b = $1) AND r.ends_at < now() ORDER BY r.ends_at DESC LIMIT 3`,
    [c.id],
  );
  const memories = [
    ...mem.rows.map((r) => r.plan?.memory).filter(Boolean),
    ...room.rows.map((r) => (r.coin_a === c.id ? r.memory_a : r.memory_b)).filter(Boolean),
  ].slice(0, 6);
  const latest = mem.rows[0]?.plan;
  return [
    `${label}: ${c.name} ($${c.symbol})`,
    c.description && `About: ${c.description}`,
    personalityText(p) && `Personality: ${personalityText(p)}`,
    p.backstory?.trim() && `Backstory: ${p.backstory.trim()}`,
    p.voice?.trim() && `How they talk: ${p.voice.trim()}`,
    p.themes?.length ? `Things they care about: ${p.themes.join(", ")}` : "",
    p.avoid?.trim() && `Never talks about: ${p.avoid.trim()}`,
    latest?.mood && `Current mood: ${latest.mood}`,
    latest?.next_thread && `On their mind: ${latest.next_thread}`,
    memories.length ? `Recent memories:\n${memories.map((m) => `  - ${m}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Job: pick two free characters and write (and schedule) their conversation. */
export async function converse() {
  const kill = await getKillSwitch();
  if (kill.content) return;
  const chars = await roomCharacters();
  if (chars.length < 2) return;
  const busy = await query<{ coin_a: string; coin_b: string }>(
    `SELECT coin_a, coin_b FROM room_conversations WHERE ends_at > now() - interval '5 seconds'`,
  );
  if (busy.rows.length >= config.ROOM_MAX_CONVERSATIONS) return;
  const recent = await query<{ coin_a: string; coin_b: string; t: Date }>(
    `SELECT coin_a, coin_b, max(starts_at) AS t FROM room_conversations
     WHERE starts_at > now() - interval '7 days' GROUP BY coin_a, coin_b`,
  );
  const lastMet = new Map<string, number>();
  for (const r of recent.rows) {
    const k = pairKey(r.coin_a, r.coin_b);
    lastMet.set(k, Math.max(lastMet.get(k) ?? 0, r.t.getTime()));
  }
  const pair = pickPair(
    chars.map((c) => c.id),
    lastMet,
    new Set(busy.rows.flatMap((r) => [r.coin_a, r.coin_b])),
    Date.now(),
  );
  if (!pair) return;
  const A = chars.find((c) => c.id === pair[0])!;
  const B = chars.find((c) => c.id === pair[1])!;
  if (!(await reserveSpend(config.COST_LLM_USD))) return;

  const history = await query<{ coin_a: string; summary: string; feeling_a: string; feeling_b: string; starts_at: Date }>(
    `SELECT coin_a, summary, feeling_a, feeling_b, starts_at FROM room_conversations
     WHERE (coin_a = $1 AND coin_b = $2) OR (coin_a = $2 AND coin_b = $1) ORDER BY starts_at DESC LIMIT 3`,
    [A.id, B.id],
  );
  const past = history.rows
    .map((h) => {
      const aFeels = h.coin_a === A.id ? h.feeling_a : h.feeling_b;
      const bFeels = h.coin_a === A.id ? h.feeling_b : h.feeling_a;
      return `- ${h.starts_at.toISOString().slice(0, 10)}: ${h.summary} (A felt: ${aFeels}; B felt: ${bFeels})`;
    })
    .join("\n");

  const system = `You write short, natural, in-person conversations between AI influencer characters who live in "the Room", a shared hangout on Reelpad where every coin's character wanders around and bumps into the others. Each character is the face of a pump.fun coin and posts on Instagram.

How to write it:
- Both stay fully in character: their personality, backstory, way of talking and current mood shape every line.
- They know each other's public profiles, so they can bring up the other's backstory, quirks or recent posts. Let their personalities clash or click in a way that fits.
- If they've met before, continue the relationship (running jokes, grudges, friendships). If not, it's a first meeting.
- Make it feel like a real overheard moment: specific, funny or surprising, with a small arc. No generic small talk, no narration.
- Lines are short and spoken aloud. No hashtags. Emoji: none.

Hard rules: no financial advice, no price predictions, never tell anyone to buy or sell, no claims about returns. They can mention their coin or its buyback-and-burn only casually. Nothing sexual, hateful, or harassing; no real people insulted; respect each character's "never talks about" list. Write in English.`;

  const user = [
    await characterSheet(A, "A"),
    await characterSheet(B, "B"),
    past ? `Their past encounters:\n${past}` : "They've never met before.",
    `It's ${new Date().toUTCString()}.`,
    `Write their conversation. A walks up to B.`,
  ].join("\n\n");

  const plan = await structured<ConvoPlan>({
    system,
    user,
    toolName: "room_conversation",
    toolDescription: "the conversation as JSON matching the schema.",
    schema: CONVO_SCHEMA,
    maxTokens: 2000,
  });

  const { lines, talkSec } = timeLines(
    (plan.lines ?? []).slice(0, 12).map((l) => ({ speaker: l.speaker === "B" ? "b" : "a", text: l.text, action: l.action })),
  );
  if (lines.length < 2) throw new Error("Room conversation came back too short");

  // Scheduled slightly ahead so every open Room sees the walk-up from the start.
  await query(
    `INSERT INTO room_conversations(coin_a, coin_b, topic, lines, summary, memory_a, memory_b, feeling_a, feeling_b,
                                    starts_at, talk_at, ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             now() + ($10 || ' seconds')::interval,
             now() + ($11 || ' seconds')::interval,
             now() + ($12 || ' seconds')::interval)`,
    [
      A.id,
      B.id,
      String(plan.topic ?? "").slice(0, 80),
      JSON.stringify(lines),
      String(plan.summary ?? "").slice(0, 400),
      String(plan.memory_a ?? "").slice(0, 300),
      String(plan.memory_b ?? "").slice(0, 300),
      String(plan.feeling_a ?? "").slice(0, 60),
      String(plan.feeling_b ?? "").slice(0, 60),
      String(LEAD_IN_SEC),
      String(LEAD_IN_SEC + WALK_IN_SEC),
      String(LEAD_IN_SEC + WALK_IN_SEC + talkSec),
    ],
  );
  logger.info({ a: A.symbol, b: B.symbol, topic: plan.topic }, "room conversation scheduled");
}

/** Recent Room memories for one character, so its Instagram posts can mention who it met. */
export async function roomMemories(coinId: string, limit = 3) {
  const r = await query<{ memory: string; other: string; starts_at: Date }>(
    `SELECT CASE WHEN r.coin_a = $1 THEN r.memory_a ELSE r.memory_b END AS memory, o.name AS other, r.starts_at
     FROM room_conversations r
     JOIN coins o ON o.id = CASE WHEN r.coin_a = $1 THEN r.coin_b ELSE r.coin_a END
     WHERE (r.coin_a = $1 OR r.coin_b = $1) AND r.ends_at < now()
     ORDER BY r.ends_at DESC LIMIT $2`,
    [coinId, limit],
  );
  return r.rows.filter((x) => x.memory);
}
