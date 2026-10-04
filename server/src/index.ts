import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config, isProd } from "./config.js";
import { reelSeconds, reelsHaveAudio } from "./services/ai/fal.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { adminRouter } from "./http/admin.js";
import { authRouter, readSession } from "./http/auth.js";
import { coinsRouter, postsRouter } from "./http/coins.js";
import { instagramRouter } from "./http/instagram.js";
import { roomRouter } from "./http/room.js";
import { errorHandler } from "./http/util.js";
import { PERSONALITIES, VISUAL_STYLES } from "./domain/catalog.js";
import { logger } from "./lib/logger.js";
import { startWorker } from "./worker/index.js";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        mediaSrc: ["'self'", "https:"],
        connectSrc: ["'self'", "https:", "wss:"],
        frameSrc: ["'self'", "https://dexscreener.com"],
        formAction: ["'self'", "https://www.instagram.com"],
        // Only force HTTPS when the site is served over HTTPS, so `npm start` still works on http://localhost.
        upgradeInsecureRequests: config.PUBLIC_URL.startsWith("https://") ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cors({ origin: config.PUBLIC_URL, credentials: true }));
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => !req.url?.startsWith("/api") } }));
app.use(cookieParser());
app.use(express.json({ limit: "200kb" }));
app.use(readSession);

app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use("/api/auth", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({
    appName: config.APP_NAME,
    platformFeeSol: config.PLATFORM_FEE_SOL,
    agentGasSol: config.AGENT_GAS_FUND_SOL,
    treasuryDryRun: config.TREASURY_DRY_RUN,
    igAccessMode: config.IG_ACCESS_MODE,
    limits: {
      minPostsPerDay: config.CONTENT_MIN_POSTS_PER_DAY,
      maxPostsPerDay: config.CONTENT_MAX_POSTS_PER_DAY,
      maxReelsPerWeek: config.CONTENT_MAX_REELS_PER_WEEK,
      treasuryMaxSolPerAction: config.TREASURY_MAX_SOL_PER_ACTION,
      treasuryMaxSolPerDay: config.TREASURY_MAX_SOL_PER_DAY,
      treasuryMinBuySol: config.TREASURY_MIN_BUY_SOL,
      treasuryBuyIntervalMin: config.TREASURY_BUY_INTERVAL_MIN,
    },
    reels: { seconds: reelSeconds(), audio: reelsHaveAudio() },
    catalog: { personalities: PERSONALITIES, visualStyles: VISUAL_STYLES },
  });
});

app.use("/api/auth", authRouter);
app.use("/api/coins", coinsRouter);
app.use("/api/posts", postsRouter);
app.use("/api/instagram", instagramRouter);
app.use("/api/admin", adminRouter);
app.use("/api/room", roomRouter);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// Serve the built frontend (single-page app).
const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  // Hashed build files. A missing one is a real 404 (never the HTML page), so a browser holding an old page
  // after a deploy gets a clear error and reloads, instead of trying to run HTML as JavaScript.
  app.use("/assets", express.static(join(webDist, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  app.use(express.static(webDist, { index: false, maxAge: isProd ? "1h" : 0 }));
  // The page itself is never cached, so every visit picks up the latest build.
  app.get("*", (_req, res) => {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(join(webDist, "index.html"));
  });
}

app.use(errorHandler);

async function main() {
  await migrate();
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, `${config.APP_NAME} API listening`));
  const stopWorker = config.RUN_WORKER ? await startWorker() : null;

  const shutdown = async () => {
    logger.info("shutting down");
    server.close();
    await stopWorker?.();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  logger.error(e, "failed to start");
  process.exit(1);
});
