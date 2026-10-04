import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { one, query } from "../db/pool.js";
import { pollWinner } from "../domain/polls.js";
import { personaBrief } from "../domain/persona.js";
import type { Arc } from "../domain/story.js";
import { logger } from "../lib/logger.js";
import { structured } from "./ai/claude.js";
import type { CoinRow } from "./coins.js";
import { getTokenBalance } from "./solana.js";
import { reserveSpend } from "./spend.js";

/**
 * Fan polls on storylines. While one episode plays out, holders vote on how the NEXT episode goes;
 * when the episode ends the poll closes and the winning choice steers the next posts.
 * One wallet, one vote, holders of the coin only (checked on-chain when voting).
 */

const POLL_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "A short question for your followers about what you should do next (under 80 characters)." },
    options: {
      type: "array",
      description: "Exactly 3 distinct, fun choices for how the next episode could go, each under 60 characters.",
      items: { type: "string" },
    },
  },
  required: ["question", "options"],
  additionalProperties: false,
};

/** Opens the poll that decides episode `beat` of the arc (no-op if it exists or the arc has no such episode). */
export async function openPoll(coin: CoinRow, arc: Arc, beat: number) {
  const next = arc.beats[beat];
  if (!next) return;
  const exists = await one(`SELECT 1 FROM story_polls WHERE arc_id = $1 AND beat = $2`, [arc.id, beat]);
  if (exists || !(await reserveSpend(config.COST_LLM_USD))) return;
  try {
    const r = await structured<{ question: string; options: string[] }>({
      system: personaBrief(coin, coin.persona),
      user: [
        `You're in the middle of your storyline "${arc.title}" (${arc.premise}).`,
        `Coming up next: "${next.title}": ${next.summary}`,
        `Ask your followers to vote on how that next episode goes. Write the question in your own voice and give 3 different choices that all fit the story (different decisions, places or plans), so whichever wins, the story still works. No money or price topics.`,
      ].join("\n\n"),
      toolName: "story_poll",
      toolDescription: "the poll as JSON matching the schema.",
      schema: POLL_SCHEMA,
      maxTokens: 500,
    });
    const options = [...new Set((r.options ?? []).map((o) => String(o).trim().slice(0, 80)).filter(Boolean))].slice(0, 3);
    if (options.length < 2) return;
    await query(
      `INSERT INTO story_polls(arc_id, coin_id, beat, question, options) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [arc.id, coin.id, beat, String(r.question ?? "What should I do next?").trim().slice(0, 120), JSON.stringify(options)],
    );
  } catch (e) {
    logger.warn({ coin: coin.symbol, err: (e as Error).message }, "story poll could not be created");
  }
}

/** Closes the poll for episode `beat` and stores the winner (null when nobody voted). */
export async function closePoll(arcId: string, beat: number) {
  const poll = await one<{ id: string; options: string[] }>(
    `SELECT id, options FROM story_polls WHERE arc_id = $1 AND beat = $2 AND status = 'open'`,
    [arcId, beat],
  );
  if (!poll) return;
  const votes = await query<{ option: number; n: number }>(
    `SELECT option, count(*)::int AS n FROM story_poll_votes WHERE poll_id = $1 GROUP BY option`,
    [poll.id],
  );
  const winner = pollWinner(poll.options.length, votes.rows);
  await query(`UPDATE story_polls SET status = 'closed', winner = $2, closed_at = now() WHERE id = $1`, [poll.id, winner]);
}

/** The fans' choice for an episode, if a poll decided it. */
export async function fanChoice(arcId: string, beat: number): Promise<string | null> {
  const p = await one<{ options: string[]; winner: number | null }>(
    `SELECT options, winner FROM story_polls WHERE arc_id = $1 AND beat = $2 AND status = 'closed'`,
    [arcId, beat],
  );
  return p && p.winner !== null ? p.options[p.winner] ?? null : null;
}

export class VoteError extends Error {}

/** One vote per wallet (it can change its vote while the poll is open); holders only. */
export async function vote(coin: CoinRow, pollId: string, wallet: string, option: number) {
  const poll = await one<{ status: string; options: string[] }>(
    `SELECT status, options FROM story_polls WHERE id = $1 AND coin_id = $2`,
    [pollId, coin.id],
  );
  if (!poll) throw new VoteError("Poll not found");
  if (poll.status !== "open") throw new VoteError("This poll has closed");
  if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) throw new VoteError("Pick one of the options");
  const bal = await getTokenBalance(new PublicKey(wallet), new PublicKey(coin.mint!));
  if (bal.raw <= 0n) throw new VoteError(`Only $${coin.symbol} holders can vote. Hold some in this wallet to vote.`);
  await query(
    `INSERT INTO story_poll_votes(poll_id, wallet, option) VALUES ($1,$2,$3)
     ON CONFLICT (poll_id, wallet) DO UPDATE SET option = EXCLUDED.option, voted_at = now()`,
    [pollId, wallet, option],
  );
}

/** The open poll for the card, with live counts and the viewer's vote. */
export async function openPollView(coinId: string, wallet?: string) {
  const poll = await one<{ id: string; question: string; options: string[]; beat: number; created_at: Date }>(
    `SELECT p.id, p.question, p.options, p.beat, p.created_at FROM story_polls p
     JOIN story_arcs a ON a.id = p.arc_id AND a.status = 'active'
     WHERE p.coin_id = $1 AND p.status = 'open' ORDER BY p.created_at DESC LIMIT 1`,
    [coinId],
  );
  if (!poll) return null;
  const [counts, mine] = await Promise.all([
    query<{ option: number; n: number }>(`SELECT option, count(*)::int AS n FROM story_poll_votes WHERE poll_id = $1 GROUP BY option`, [poll.id]),
    wallet ? one<{ option: number }>(`SELECT option FROM story_poll_votes WHERE poll_id = $1 AND wallet = $2`, [poll.id, wallet]) : null,
  ]);
  const by = new Map(counts.rows.map((r) => [r.option, r.n]));
  return {
    id: poll.id,
    question: poll.question,
    episode: poll.beat + 1,
    options: poll.options.map((text, i) => ({ text, votes: by.get(i) ?? 0 })),
    total: counts.rows.reduce((s, r) => s + r.n, 0),
    myVote: mine?.option ?? null,
  };
}
