import { config } from "../config.js";
import { one } from "../db/pool.js";

/**
 * Atomically reserves AI spend against today's platform-wide budget (UTC day).
 * Returns false when the reservation would exceed DAILY_AI_BUDGET_USD.
 */
export async function reserveSpend(usd: number): Promise<boolean> {
  if (usd > config.DAILY_AI_BUDGET_USD) return false;
  const row = await one(
    `INSERT INTO ai_spend(day, usd) VALUES ((now() AT TIME ZONE 'utc')::date, $1)
     ON CONFLICT (day) DO UPDATE SET usd = ai_spend.usd + EXCLUDED.usd
       WHERE ai_spend.usd + EXCLUDED.usd <= $2
     RETURNING usd`,
    [usd, config.DAILY_AI_BUDGET_USD],
  );
  return row !== null;
}

/** Gives back a reservation for work that failed (fal and Claude don't charge for failed calls). */
export async function releaseSpend(usd: number) {
  if (!(usd > 0)) return;
  await one(
    `UPDATE ai_spend SET usd = GREATEST(0, usd - $1) WHERE day = (now() AT TIME ZONE 'utc')::date RETURNING usd`,
    [usd],
  );
}

/** Thrown when today's AI budget is used up: the job waits and resumes by itself instead of failing. */
export class BudgetError extends Error {
  constructor() {
    super("Daily AI budget reached");
  }
}

export async function todaySpend(): Promise<number> {
  const row = await one<{ usd: string }>(`SELECT usd FROM ai_spend WHERE day = (now() AT TIME ZONE 'utc')::date`);
  return row ? Number(row.usd) : 0;
}
