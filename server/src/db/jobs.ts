import { pool, query } from "./pool.js";

/**
 * Minimal durable job queue on Postgres (FOR UPDATE SKIP LOCKED).
 * Safe with several worker processes; a crashed worker's job is reclaimed when its lock expires.
 */
export type JobType =
  | "content.plan"
  | "content.generate"
  | "content.publish"
  | "treasury.run"
  | "instagram.refresh"
  | "launch.confirm"
  | "room.converse"
  | "comments.sync"
  | "comments.respond"
  | "shoutout.generate";

export interface Job {
  id: string;
  type: JobType;
  payload: any;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(
  type: JobType,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {},
): Promise<boolean> {
  const r = await query(
    `INSERT INTO jobs(type, payload, dedupe_key, run_at, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5)
     ON CONFLICT DO NOTHING`,
    [type, JSON.stringify(payload), opts.dedupeKey ?? null, opts.runAt ?? null, opts.maxAttempts ?? 5],
  );
  return (r.rowCount ?? 0) > 0;
}

const LOCK_SECONDS = 40 * 60; // a multi-shot Reel (frames, filming, a possible re-shoot, editing) can take 20+ minutes

export async function claim(limit: number): Promise<Job[]> {
  const r = await pool.query<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1,
            locked_until = now() + ($2 || ' seconds')::interval, updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE (status = 'queued' AND run_at <= now())
          OR (status = 'running' AND locked_until < now())
       ORDER BY run_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, type, payload, attempts, max_attempts`,
    [limit, String(LOCK_SECONDS)],
  );
  return r.rows;
}

export async function complete(id: string) {
  await query(`UPDATE jobs SET status = 'done', locked_until = NULL, updated_at = now() WHERE id = $1`, [id]);
}

export async function fail(job: Job, err: unknown, retryable = true) {
  const message = err instanceof Error ? err.message : String(err);
  const final = !retryable || job.attempts >= job.max_attempts;
  const backoffSec = Math.min(3600, 30 * 2 ** (job.attempts - 1));
  await query(
    `UPDATE jobs SET status = $2, last_error = $3, locked_until = NULL,
            run_at = now() + ($4 || ' seconds')::interval, updated_at = now()
     WHERE id = $1`,
    [job.id, final ? "failed" : "queued", message.slice(0, 2000), String(backoffSec)],
  );
  return final;
}

/** Puts a job back in the queue for later without counting it as a failed attempt (e.g. budget used up). */
export async function defer(job: Job, seconds: number, message: string) {
  await query(
    `UPDATE jobs SET status = 'queued', attempts = GREATEST(0, attempts - 1), last_error = $2, locked_until = NULL,
            run_at = now() + ($3 || ' seconds')::interval, updated_at = now()
     WHERE id = $1`,
    [job.id, message.slice(0, 2000), String(seconds)],
  );
}

export async function pruneOldJobs() {
  await query(`DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at < now() - interval '14 days'`);
}

/** Thrown by a handler when retrying cannot help (bad input, revoked token...). */
export class PermanentError extends Error {}
