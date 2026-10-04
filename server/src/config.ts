import "dotenv/config";
import { z } from "zod";
import { applyTier } from "./domain/tiers.js";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: num(8080),
  APP_NAME: z.string().default("Reelpad"),
  PUBLIC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool(true),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  MASTER_KEY: z.string().min(40, "MASTER_KEY must be a base64-encoded 32-byte key"),
  ADMIN_WALLETS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),

  SOLANA_RPC_URL: z.string().url(),
  PLATFORM_FEE_WALLET: z.string().min(32),
  PLATFORM_FEE_SOL: num(0.02),
  AGENT_GAS_FUND_SOL: num(0.01),
  LAUNCH_PRIORITY_MICROLAMPORTS: num(200_000),
  PUMPPORTAL_PRIORITY_FEE: num(0.00005),
  PUMPPORTAL_SLIPPAGE: num(15),

  PINATA_JWT: z.string().min(1),
  IPFS_GATEWAY: z.string().default("https://ipfs.io/ipfs"),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_PUBLIC_BASE_URL: z.string().url(),

  IG_APP_ID: z.string().min(1),
  IG_APP_SECRET: z.string().min(1),
  IG_API_VERSION: z.string().default("v23.0"),
  // "testers" until Meta approves the app (creators request access, an admin adds them as testers).
  // "open" after approval: the Connect button goes straight to Instagram login for everyone.
  IG_ACCESS_MODE: z.enum(["testers", "open"]).default("testers"),
  // Optional: the Facebook App ID (App settings → Basic), used only to link straight to the Roles page from Admin.
  META_APP_ID: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  // Only needed if your API key covers several workspaces (Console → Settings → Workspaces shows the ID).
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),

  // premium (default) = best models; standard = the original cheaper models; custom = use the
  // ANTHROPIC_MODEL / FAL_*_MODEL / REEL_SECONDS / COST_* / QUALITY_CHECK values set below.
  GENERATION_TIER: z.enum(["standard", "premium", "custom"]).default("premium"),
  // Claude reviews every generated image against the token image and redraws it once if the character doesn't match.
  QUALITY_CHECK: bool(true),
  QUALITY_CHECK_MODEL: z.string().default("claude-sonnet-5-5"),
  COST_CHECK_USD: num(0.01),
  FAL_KEY: z.string().min(1),
  FAL_IMAGE_MODEL: z.string().default("fal-ai/flux-pro/kontext"),
  // Reels: a video model with native audio, so the character speaks (lip-synced) with sound effects.
  // Supported: fal-ai/kling-video/v2.6/pro/image-to-video (default) or fal-ai/veo3.1/image-to-video.
  FAL_REEL_MODEL: z.string().default("fal-ai/kling-video/v2.6/pro/image-to-video"),
  REEL_SECONDS: num(5), // Kling: 5 or 10. Veo: 4, 6 or 8.
  REEL_AUDIO: bool(true), // false = silent Reels (cheaper)
  COST_IMAGE_USD: num(0.04),
  COST_REEL_USD: num(0.7), // Kling 2.6 Pro with audio is about $0.14 per second
  COST_LLM_USD: num(0.02),
  DAILY_AI_BUDGET_USD: num(50),

  COMMENT_SYNC_MIN: num(5), // how often each coin's comments are checked
  COMMENT_REPLIES_PER_HOUR: num(12), // per coin, so replies trickle out like a person's
  COMMENT_BATCH: num(8), // comments answered per Claude call
  ROOM_MAX_CONVERSATIONS: num(3), // conversations running at once in the Room (only while someone is watching)
  CONTENT_MIN_POSTS_PER_DAY: num(12), // every coin posts at least this often
  CONTENT_MAX_POSTS_PER_DAY: num(24), // most posts a creator can schedule per day (Instagram allows 100 per 24h)
  CONTENT_MAX_REELS_PER_WEEK: num(21), // most Reels per week; Reels cost the most to generate
  CAPTION_FOOTER: z.string().default("AI-generated persona. Not financial advice."),

  // Buybacks and burns are always live on-chain. The old TREASURY_DRY_RUN setting is ignored on purpose, so a
  // leftover "true" in the hosting dashboard can't keep a deployment in simulation. For local testing only,
  // TREASURY_SIMULATION=true logs buybacks without sending them.
  TREASURY_DRY_RUN: z.any().transform(() => bool(false).parse(process.env.TREASURY_SIMULATION)),
  TREASURY_MAX_SOL_PER_ACTION: num(0.5), // most SOL one buyback can spend
  TREASURY_MAX_SOL_PER_DAY: num(2), // most SOL a coin's buybacks can spend per 24h; extra fees carry over
  TREASURY_MIN_INTERVAL_MIN: num(15), // how often each treasury is checked (fees claimed, price recorded)
  TREASURY_BUY_INTERVAL_MIN: num(60), // minimum minutes between buybacks for one coin
  TREASURY_MIN_BUY_SOL: num(0.01), // wait until this much in fees has collected before buying
  TREASURY_GAS_RESERVE_SOL: num(0.01), // always kept in the agent wallet for fees and rent

  RUN_WORKER: bool(true),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}\nSee .env.example`);
    process.exit(1);
  }
  return applyTier(parsed.data);
}

export const config = load();
export const isProd = config.NODE_ENV === "production";
