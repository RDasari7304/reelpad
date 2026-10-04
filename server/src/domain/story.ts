/**
 * Storylines: each influencer lives through a story told across many posts. A story ("arc") has a
 * premise and 4-6 episodes ("beats"); each episode plays out over 2-3 posts, then the story moves on.
 * Most posts advance the story; every few posts is a standalone slice-of-life moment so the feed
 * still breathes. When an arc ends, the next one picks up from where the character is now.
 */
export interface Beat {
  title: string;
  summary: string;
  /** Filled in as posts happen: what actually happened in this episode. */
  recap?: string;
}

export interface Arc {
  id: string;
  title: string;
  premise: string;
  beats: Beat[];
  currentBeat: number;
  postsInBeat: number;
  status: "active" | "done" | "abandoned";
}

export const MIN_BEATS = 4;
export const MAX_BEATS = 6;
/** One post in four is a standalone moment (not every post has to move the plot). */
export const STANDALONE_EVERY = 4;

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** How many posts an episode gets (2 or 3), fixed per arc and episode so it doesn't change on retries. */
export const beatLength = (arcId: string, beat: number) => 2 + (hash(`${arcId}:${beat}`) % 2);

/** Whether this post should be a standalone moment rather than a story post. */
export function isStandalone(postNumber: number, trigger: string): boolean {
  if (trigger === "first" || trigger === "comeback") return false; // these open or reopen the story
  if (trigger === "treasury" || trigger === "milestone" || trigger === "collab") return true; // event posts stand on their own (they may nod to the story)
  return postNumber % STANDALONE_EVERY === STANDALONE_EVERY - 1;
}

/** Clean up a planned arc from the model: trims, limits sizes, requires enough episodes. */
export function normalizeArc(raw: { title?: string; premise?: string; beats?: Array<{ title?: string; summary?: string }> }) {
  const beats = (raw.beats ?? [])
    .map((b) => ({ title: String(b.title ?? "").trim().slice(0, 80), summary: String(b.summary ?? "").trim().slice(0, 400) }))
    .filter((b) => b.title && b.summary)
    .slice(0, MAX_BEATS);
  if (beats.length < MIN_BEATS) return null;
  const title = String(raw.title ?? "").trim().slice(0, 80);
  const premise = String(raw.premise ?? "").trim().slice(0, 600);
  if (!title || !premise) return null;
  return { title, premise, beats };
}

/**
 * Moves the story forward after a story post. The episode ends when it has had its posts, or earlier if
 * the post wrapped it up. Returns the new state; `done` means the arc is finished.
 */
export function advance(arc: Arc, opts: { recap: string; beatComplete: boolean }): Arc {
  const beats = arc.beats.map((b) => ({ ...b }));
  const cur = beats[arc.currentBeat];
  if (!cur) return { ...arc, status: "done" };
  const recap = opts.recap.trim().slice(0, 300);
  if (recap) cur.recap = cur.recap ? `${cur.recap} ${recap}`.slice(-600) : recap;
  const posts = arc.postsInBeat + 1;
  const ended = opts.beatComplete || posts >= beatLength(arc.id, arc.currentBeat);
  if (!ended) return { ...arc, beats, postsInBeat: posts };
  const next = arc.currentBeat + 1;
  if (next >= beats.length) return { ...arc, beats, currentBeat: beats.length - 1, postsInBeat: posts, status: "done" };
  return { ...arc, beats, currentBeat: next, postsInBeat: 0 };
}

/** The story section of a post's brief: what happened so far, this episode, and what it leads into. */
export function storyBrief(arc: Arc): string {
  const n = arc.beats.length;
  const k = arc.currentBeat;
  const beat = arc.beats[k]!;
  const len = beatLength(arc.id, k);
  const postNo = arc.postsInBeat + 1;
  const done = arc.beats
    .slice(0, k)
    .map((b, i) => `  ${i + 1}. ${b.title}: ${b.recap || b.summary}`)
    .join("\n");
  const position =
    k === 0 && postNo === 1
      ? "This post OPENS the story: set up the premise so followers want to know what happens next."
      : k === n - 1
        ? postNo >= len
          ? "This is the FINALE of the story: pay it off and resolve it, with a satisfying ending."
          : "This is the last episode: build toward the finale."
        : postNo >= len
          ? "This post ENDS the episode: close it with a turn or cliffhanger that leads into the next one."
          : postNo === 1
            ? "This post STARTS the episode: pick up from where the last one left off."
            : "This post continues the episode.";
  const nextUp = arc.beats[k + 1];
  return [
    `YOUR CURRENT STORYLINE: "${arc.title}"`,
    `Premise: ${arc.premise}`,
    done ? `Episodes so far:\n${done}` : "",
    `Now: episode ${k + 1} of ${n}, "${beat.title}": ${beat.summary}`,
    beat.recap ? `Already happened in this episode: ${beat.recap}` : "",
    `This is post ${postNo} of about ${len} in this episode. ${position}`,
    nextUp && postNo >= len ? `Next episode (foreshadow it, don't spoil it): ${nextUp.title}` : "",
    "Tell the story through what happens to you in this post. Followers should feel the continuity (callbacks, consequences, rising stakes) without you narrating it like a summary. Don't label posts \"Episode 3\" or \"Part 2\".",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Public view: titles and recaps of what has happened, never the episodes still to come. */
export function publicArc(arc: Arc) {
  return {
    title: arc.title,
    premise: arc.premise,
    status: arc.status,
    episode: arc.currentBeat + 1,
    episodes: arc.beats.length,
    happened: arc.beats
      .slice(0, arc.status === "done" ? arc.beats.length : arc.currentBeat + 1)
      .map((b) => ({ title: b.title, recap: b.recap ?? null }))
      .filter((b, i, all) => b.recap || i < all.length - 1),
  };
}
