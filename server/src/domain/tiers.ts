/**
 * Generation quality tiers. One setting (GENERATION_TIER) picks every model and its cost estimate,
 * so upgrading or downgrading never means editing five environment variables.
 */
export type Tier = "standard" | "premium" | "custom";

export interface TierModels {
  ANTHROPIC_MODEL: string;
  FAL_IMAGE_MODEL: string;
  FAL_REEL_MODEL: string;
  REEL_SECONDS: number;
  COST_IMAGE_USD: number;
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
    COST_IMAGE_USD: 0.04,
    COST_REEL_USD: 0.7,
    COST_LLM_USD: 0.02,
    QUALITY_CHECK: false,
  },
  // Upgraded: Nano Banana Pro images, Veo 3.1 Fast talking Reels, Claude Opus 5.5 writing, and a
  // Claude quality check that redraws any image where the character doesn't match.
  premium: {
    ANTHROPIC_MODEL: "claude-opus-5-5",
    FAL_IMAGE_MODEL: "fal-ai/nano-banana-pro/edit",
    FAL_REEL_MODEL: "fal-ai/veo3.1/fast/image-to-video",
    REEL_SECONDS: 6,
    COST_IMAGE_USD: 0.15,
    COST_REEL_USD: 0.9,
    COST_LLM_USD: 0.04,
    QUALITY_CHECK: true,
  },
};

/** Applies a tier's models over the config. "custom" keeps whatever the environment set. */
export function applyTier<T extends TierModels & { GENERATION_TIER: Tier }>(cfg: T): T {
  if (cfg.GENERATION_TIER === "custom") return cfg;
  return { ...cfg, ...TIERS[cfg.GENERATION_TIER] };
}
