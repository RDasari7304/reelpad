import { fileURLToPath } from "node:url";
import { claim, complete, defer, fail, PermanentError, pruneOldJobs, type Job } from "../db/jobs.js";
import { migrate } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import {
  generatePost,
  markPlanningFailed,
  markPostFailed,
  noteRetry,
  planPost,
  publishPost,
  resumeBudgetStalled,
  scheduleDuePosts,
} from "../services/content.js";
import { refreshExpiringTokens, upgradeShortTokens } from "../services/instagramRefresh.js";
import { runActivityChecks } from "../services/activity.js";
import { respondToComments, scheduleCommentSyncs, syncComments } from "../services/comments.js";
import { converse, scheduleRoom } from "../services/room.js";
import { BudgetError } from "../services/spend.js";
import { expireUnpaidShoutouts, generateShoutout, markShoutoutFailed, noteShoutoutRetry } from "../services/shoutouts.js";
import { runTreasury, scheduleTreasuryRuns } from "../services/treasury.js";

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);
let running = 0;
const BUDGET_WAIT_SEC = 600;
const BUDGET_STAGE = "Waiting for AI budget, resumes automatically";
let stopping = false;

async function handle(job: Job) {
  switch (job.type) {
    case "content.plan":
      return planPost(job.payload.coinId, job.payload.trigger ?? "schedule", job.payload.note);
    case "content.generate":
      return generatePost(job.payload.postId);
    case "content.publish":
      return publishPost(job.payload.postId);
    case "treasury.run":
      return runTreasury(job.payload.coinId);
    case "instagram.refresh":
      return refreshExpiringTokens();
    case "room.converse":
      return converse();
    case "comments.sync":
      return syncComments(job.payload.coinId);
    case "comments.respond":
      return respondToComments(job.payload.coinId);
    case "shoutout.generate":
      return generateShoutout(job.payload.shoutoutId);
    default:
      throw new PermanentError(`Unknown job type ${job.type}`);
  }
}

async function runJob(job: Job) {
  running++;
  const log = logger.child({ jobId: job.id, type: job.type, attempt: job.attempts });
  try {
    await handle(job);
    await complete(job.id);
    log.info("job done");
  } catch (e) {
    // Daily AI budget used up: wait and try again, without counting it as a failed attempt.
    if (e instanceof BudgetError) {
      await defer(job, BUDGET_WAIT_SEC, e.message);
      log.info("AI budget reached; job deferred");
      if (job.type.startsWith("content.")) await noteRetry(job.payload, e.message, BUDGET_STAGE).catch(() => {});
      if (job.type === "shoutout.generate") await noteShoutoutRetry(job.payload.shoutoutId, "In the queue, starting soon").catch(() => {});
      return;
    }
    const permanent = e instanceof PermanentError;
    const final = await fail(job, e, !permanent);
    log.warn({ err: (e as Error).message, final }, "job failed");
    const message = (e as Error).message;
    if (final && (job.type === "content.generate" || job.type === "content.publish")) {
      await markPostFailed(job.payload.postId, message).catch(() => {});
    } else if (final && job.type === "content.plan") {
      await markPlanningFailed(job.payload.coinId, message).catch(() => {});
    } else if (!final && job.type.startsWith("content.")) {
      await noteRetry(job.payload, message).catch(() => {});
    } else if (job.type === "shoutout.generate") {
      if (final) await markShoutoutFailed(job.payload.shoutoutId, message).catch(() => {});
      else await noteShoutoutRetry(job.payload.shoutoutId, "Hit a snag, trying again shortly").catch(() => {});
    }
  } finally {
    running--;
  }
}

async function pollLoop() {
  while (!stopping) {
    try {
      const free = CONCURRENCY - running;
      if (free > 0) {
        const jobs = await claim(free);
        for (const j of jobs) void runJob(j);
        if (jobs.length) continue;
      }
    } catch (e) {
      logger.error({ err: (e as Error).message }, "poll failed");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let tick = 0;
async function ticker() {
  try {
    await scheduleDuePosts();
    await scheduleTreasuryRuns();
    await scheduleRoom().catch((e) => logger.warn({ err: (e as Error).message }, "room schedule failed"));
    await scheduleCommentSyncs().catch((e) => logger.warn({ err: (e as Error).message }, "comment schedule failed"));
    if (tick % 5 === 0) await runActivityChecks().catch((e) => logger.warn({ err: (e as Error).message }, "activity check failed"));
    if (tick % 60 === 0) await refreshExpiringTokens();
    await upgradeShortTokens().catch((e) => logger.warn({ err: (e as Error).message }, "token upgrade failed"));
    if (tick % 60 === 0) await expireUnpaidShoutouts().catch(() => {});
    if (tick % 1440 === 0) await pruneOldJobs();
  } catch (e) {
    logger.error({ err: (e as Error).message }, "ticker failed");
  }
  tick++;
}

export async function startWorker() {
  logger.info({ concurrency: CONCURRENCY }, "worker starting");
  await resumeBudgetStalled().catch((e) => logger.warn({ err: (e as Error).message }, "budget resume failed"));
  void pollLoop();
  await ticker();
  const interval = setInterval(() => void ticker(), 60_000);
  return async function stop() {
    stopping = true;
    clearInterval(interval);
    const deadline = Date.now() + 25_000;
    while (running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  };
}

// Standalone worker process: `npm run worker`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate()
    .then(startWorker)
    .then((stop) => {
      const shutdown = async () => {
        logger.info("worker shutting down");
        await stop();
        await pool.end();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch((e) => {
      logger.error(e, "worker failed to start");
      process.exit(1);
    });
}
