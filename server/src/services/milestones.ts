import { enqueue } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { athMilestone, graduationMilestone, mcapMilestone, recordBurnMilestone, type Milestone } from "../domain/milestones.js";
import { logger } from "../lib/logger.js";

/**
 * Records milestones (once each) and gets the character to post about them. If a post is already being
 * planned, the milestone waits and the next post picks it up (see takePendingMilestone).
 */
export async function recordMilestone(coinId: string, m: Milestone | null) {
  if (!m) return;
  const inserted = await one(
    `INSERT INTO coin_milestones(coin_id, kind, key, note) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING kind`,
    [coinId, m.kind, m.key, m.note],
  );
  if (!inserted) return;
  logger.info({ coinId, kind: m.kind, key: m.key }, "milestone reached");
  const ok = await one(
    `SELECT 1 FROM coins c JOIN instagram_accounts i ON i.coin_id = c.id AND i.status = 'active'
     WHERE c.id = $1 AND c.status = 'live' AND NOT c.content_paused AND c.activity_state <> 'dormant'`,
    [coinId],
  );
  if (ok) await enqueue("content.plan", { coinId, trigger: "milestone" }, { dedupeKey: `plan:${coinId}`, maxAttempts: 3 });
}

/** The oldest milestone still waiting for its post (from the last 24h, at most 2 milestone posts a day). */
export async function takePendingMilestone(coinId: string): Promise<{ kind: string; key: string; note: string } | null> {
  const today = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM coin_milestones WHERE coin_id = $1 AND posted_at > now() - interval '24 hours'`,
    [coinId],
  );
  if ((today?.n ?? 0) >= 2) return null;
  return one(
    `SELECT kind, key, note FROM coin_milestones
     WHERE coin_id = $1 AND posted_at IS NULL AND achieved_at > now() - interval '24 hours'
     ORDER BY achieved_at LIMIT 1`,
    [coinId],
  );
}

export async function markMilestonePosted(coinId: string, kind: string, key: string) {
  await query(`UPDATE coin_milestones SET posted_at = now() WHERE coin_id = $1 AND kind = $2 AND key = $3`, [coinId, kind, key]);
}

/** Called with each new price reading: graduation and new all-time highs. */
export async function checkPriceMilestones(coinId: string, priceSol: number, graduated: boolean, launchedAt: Date | null) {
  const prev = await one<{ high: string | null; was_grad: boolean | null; n: number }>(
    `SELECT max(price_sol)::text AS high,
            (SELECT graduated FROM price_snapshots WHERE coin_id = $1 ORDER BY ts DESC LIMIT 1) AS was_grad,
            count(*)::int AS n
     FROM price_snapshots WHERE coin_id = $1`,
    [coinId],
  );
  if (!prev || prev.n === 0) return; // first reading: nothing to compare with
  await recordMilestone(coinId, graduationMilestone(prev.was_grad === true, graduated));
  await recordMilestone(
    coinId,
    athMilestone({
      priceSol,
      prevHighSol: prev.high ? Number(prev.high) : null,
      ageHours: launchedAt ? (Date.now() - launchedAt.getTime()) / 3_600_000 : 0,
      now: new Date(),
    }),
  );
}

/** Called after each activity check with the latest market cap. */
export async function checkMcapMilestone(coinId: string, mcapUsd: number | null) {
  if (!mcapUsd) return;
  const done = await query<{ key: string }>(`SELECT key FROM coin_milestones WHERE coin_id = $1 AND kind = 'mcap'`, [coinId]);
  await recordMilestone(coinId, mcapMilestone(mcapUsd, new Set(done.rows.map((r) => r.key))));
}

/** Called after a burn of the coin itself: the biggest burn so far. */
export async function checkBurnMilestone(coinId: string, tokens: number, symbol: string) {
  const prev = await one<{ max: string | null; n: number }>(
    `SELECT max(token_amount::numeric)::text AS max, count(*)::int AS n FROM treasury_actions
     WHERE coin_id = $1 AND kind = 'burn' AND status = 'done' AND mint IS NULL
       AND created_at < now() - interval '5 seconds'`,
    [coinId],
  );
  await recordMilestone(coinId, recordBurnMilestone(tokens, prev?.max ? Number(prev.max) : null, prev?.n ?? 0, symbol));
}
