import { enqueue } from "../db/jobs.js";
import { query } from "../db/pool.js";
import { decideActivity, meetsActiveBar, priceMove, type Activity } from "../domain/activity.js";
import { logger } from "../lib/logger.js";
import { tokenStats, type TokenStats } from "./chart.js";
import { checkMcapMilestone } from "./milestones.js";

/**
 * Hourly activity check for every live coin (see domain/activity.ts). Uses GeckoTerminal for 24h
 * volume and market cap (30 coins per request), Reelpad's own price records and fee collections as
 * a fallback, then moves each coin between active, cooling and dormant.
 */
export async function runActivityChecks() {
  const coins = await query<{
    id: string;
    mint: string;
    symbol: string;
    launched_at: Date | null;
    created_at: Date;
    activity_state: Activity;
    last_active_at: Date | null;
  }>(
    `SELECT id, mint, symbol, launched_at, created_at, activity_state, last_active_at FROM coins
     WHERE status = 'live' AND mint IS NOT NULL
       AND (activity_checked_at IS NULL OR activity_checked_at < now() - interval '55 minutes')
     ORDER BY activity_checked_at NULLS FIRST LIMIT 150`,
  );
  if (!coins.rows.length) return;

  let stats = new Map<string, TokenStats>();
  try {
    stats = await tokenStats(coins.rows.map((c) => c.mint));
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "activity: chart stats unavailable, using on-chain signals only");
  }

  const ids = coins.rows.map((c) => c.id);
  const [fees, prices] = await Promise.all([
    query<{ coin_id: string; sol: string }>(
      `SELECT coin_id, sum(sol_amount)::text AS sol FROM treasury_actions
       WHERE coin_id = ANY($1) AND kind = 'claim_fees' AND status = 'done' AND created_at > now() - interval '24 hours'
       GROUP BY coin_id`,
      [ids],
    ),
    query<{ coin_id: string; prices: string[] }>(
      `SELECT coin_id, array_agg(price_sol::text) AS prices FROM price_snapshots
       WHERE coin_id = ANY($1) AND ts > now() - interval '24 hours' GROUP BY coin_id`,
      [ids],
    ),
  ]);
  const feeBy = new Map<string, number>(fees.rows.map((r): [string, number] => [r.coin_id, Number(r.sol)]));
  const priceBy = new Map<string, number[]>(prices.rows.map((r): [string, number[]] => [r.coin_id, r.prices.map(Number)]));

  for (const c of coins.rows) {
    const s = stats.get(c.mint);
    const now = Date.now();
    const born = (c.launched_at ?? c.created_at).getTime();
    const signals = {
      ageHours: (now - born) / 3_600_000,
      volume24hUsd: s?.volume24hUsd ?? null,
      mcapUsd: s?.mcapUsd ?? null,
      fees24hSol: feeBy.get(c.id) ?? 0,
      priceMove24h: priceMove(priceBy.get(c.id) ?? []),
      hoursSinceActive: c.last_active_at ? (now - c.last_active_at.getTime()) / 3_600_000 : null,
    };
    const next = decideActivity(signals);
    const activeNow = meetsActiveBar(signals) || signals.ageHours < 48;
    await query(
      `UPDATE coins SET activity_state = $2, activity_checked_at = now(), volume_24h_usd = $3, mcap_usd = $4,
              last_active_at = CASE WHEN $5 THEN now() ELSE COALESCE(last_active_at, launched_at, created_at) END,
              activity_changed_at = CASE WHEN activity_state <> $2 THEN now() ELSE activity_changed_at END
       WHERE id = $1`,
      [c.id, next, signals.volume24hUsd, signals.mcapUsd, activeNow],
    );
    await checkMcapMilestone(c.id, signals.mcapUsd).catch((e) =>
      logger.warn({ coinId: c.id, err: (e as Error).message }, "mcap milestone check failed"),
    );
    if (next !== c.activity_state) {
      logger.info({ coin: c.symbol, from: c.activity_state, to: next, ...signals }, "coin activity changed");
      if (c.activity_state === "dormant") {
        // Trading came back: the character returns with a comeback post a few minutes from now.
        await query(`UPDATE coins SET next_post_at = now() + interval '30 minutes' WHERE id = $1`, [c.id]);
        await enqueue(
          "content.plan",
          {
            coinId: c.id,
            trigger: "comeback",
            note: "People started trading your coin again after a long quiet spell. You're back: make it a comeback post that fits your story.",
          },
          { dedupeKey: `plan:${c.id}`, maxAttempts: 3 },
        );
      }
    }
  }
}
