import { fileURLToPath } from "node:url";
import { claim, complete, fail, PermanentError, pruneOldJobs, type Job } from "../db/jobs.js";
import { migrate } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { generatePost, markPostFailed, planPost, publishPost, scheduleDuePosts } from "../services/content.js";
import { refreshExpiringTokens } from "../services/instagramRefresh.js";
import { runTreasury, scheduleTreasuryRuns } from "../services/treasury.js";

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);
let running = 0;
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
    const permanent = e instanceof PermanentError;
    const final = await fail(job, e, !permanent);
    log.warn({ err: (e as Error).message, final }, "job failed");
    if (final && (job.type === "content.generate" || job.type === "content.publish")) {
      await markPostFailed(job.payload.postId, (e as Error).message).catch(() => {});
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
    if (tick % 60 === 0) await refreshExpiringTokens();
    if (tick % 1440 === 0) await pruneOldJobs();
  } catch (e) {
    logger.error({ err: (e as Error).message }, "ticker failed");
  }
  tick++;
}

export async function startWorker() {
  logger.info({ concurrency: CONCURRENCY }, "worker starting");
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
