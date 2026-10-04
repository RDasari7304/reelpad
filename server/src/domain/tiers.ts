/**
 * Generation quality tiers. One setting (GENERATION_TIER) picks every model and its cost estimate,
 * so upgrading or downgrading never means editing five environment variables.
 */
export type Tier = "standard" | "premium" | "cinema" | "custom";

export interface TierModels {
  ANTHROPIC_MODEL: string;
  FAL_IMAGE_MODEL: string;
  FAL_REEL_MODEL: string;
  /** Length of each shot (clip) in seconds. */
  REEL_SECONDS: number;
  /** Shots per Reel: each is its own clip with its own camera setup; they're edited together. */
  REEL_SHOTS: number;
  REEL_RESOLUTION: "720p" | "1080p";
  COST_IMAGE_USD: number;
  /** Cost of ONE shot (clip). A Reel costs REEL_SHOTS times this. */
  COST_REEL_USD: number;
  COST_LLM_USD: number;
  QUALITY_CHECK: boolean;
}

export const TIERS: Record<Exclude<Tier, "custom">, TierModels> = {
  // The original setup.
  standard: {
    ANTHROPIC_MODEL: "claude-sonnet-5-5",
    FAL_IMAGE_MODEL: "fal-ai/flux-pro/kontext",
    FAL_REEL_MODEL: "fal-ai/kling-video/v2.6/pro/image-to-video",
    REEL_SECONDS: 5,
    REEL_SHOTS: 1,
    REEL_RESOLUTION: "720p",
    COST_IMAGE_USD: 0.04,
    COST_REEL_USD: 0.7,
    COST_LLM_USD: 0.02,
    QUALITY_CHECK: false,
  },
  // Upgraded: Nano Banana Pro images, Claude Opus 5.5 writing, image quality checks, and edited
  // multi-shot Reels: 3 shots of 8 seconds from Veo 3.1 Fast at 1080p (about 24 seconds, $3.60 a Reel).
  premium: {
    ANTHROPIC_MODEL: "claude-opus-5-5",
    FAL_IMAGE_MODEL: "fal-ai/nano-banana-pro/edit",
    FAL_REEL_MODEL: "fal-ai/veo3.1/fast/image-to-video",
    REEL_SECONDS: 8,
    REEL_SHOTS: 3,
    REEL_RESOLUTION: "1080p",
    COST_IMAGE_USD: 0.15,
    COST_REEL_USD: 1.2, // 8 s x $0.15/s with audio
    COST_LLM_USD: 0.04,
    QUALITY_CHECK: true,
  },
  // Premium, with the full Veo 3.1 model for every shot: noticeably better motion, faces and lip sync,
  // at $0.40 a second (about $9.60 for a 3-shot Reel).
  cinema: {
    ANTHROPIC_MODEL: "claude-opus-5-5",
    FAL_IMAGE_MODEL: "fal-ai/nano-banana-pro/edit",
    FAL_REEL_MODEL: "fal-ai/veo3.1/image-to-video",
    REEL_SECONDS: 8,
    REEL_SHOTS: 3,
    REEL_RESOLUTION: "1080p",
    COST_IMAGE_USD: 0.15,
    COST_REEL_USD: 3.2, // 8 s x $0.40/s with audio
    COST_LLM_USD: 0.04,
    QUALITY_CHECK: true,
  },
};

/** Applies a tier's models over the config. "custom" keeps whatever the environment set. */
export function applyTier<T extends TierModels & { GENERATION_TIER: Tier }>(cfg: T): T {
  if (cfg.GENERATION_TIER === "custom") return cfg;
  return { ...cfg, ...TIERS[cfg.GENERATION_TIER] };
}
