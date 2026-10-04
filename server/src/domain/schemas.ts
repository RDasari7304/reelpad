import { z } from "zod";
import { ALL_PERSONALITIES, VISUAL_STYLES } from "./catalog.js";
import { INSTAGRAM_USERNAME_MESSAGE, normalizeInstagramUsername } from "./instagram.js";
import { POSTS_PER_DAY } from "./limits.js";

export { POSTS_PER_DAY };

const keyOrCustom = (keys: readonly string[]) =>
  z.union([z.enum(keys as [string, ...string[]]), z.literal("custom")]).nullable().optional();

export const personaSchema = z
  .object({
    // Current and legacy personality keys are both accepted, so older coins can still save their settings.
    personality: keyOrCustom(Object.keys(ALL_PERSONALITIES)),
    personalityCustom: z.string().max(400).optional().default(""),
    backstory: z.string().max(1500).optional().default(""),
    voice: z.string().max(400).optional().default(""),
    visualStyle: z.union([z.enum(Object.keys(VISUAL_STYLES) as [string, ...string[]]), z.literal("custom")]).default("3d_render"),
    visualStyleCustom: z.string().max(300).optional().default(""),
    themes: z.array(z.string().max(60)).max(10).default([]),
    avoid: z.string().max(600).optional().default(""),
    language: z.string().max(40).default("English"),
  })
  .superRefine((p, ctx) => {
    if (p.personality === "custom" && !p.personalityCustom.trim())
      ctx.addIssue({ code: "custom", path: ["personalityCustom"], message: "Describe the custom personality" });
    if (p.visualStyle === "custom" && !p.visualStyleCustom.trim())
      ctx.addIssue({ code: "custom", path: ["visualStyleCustom"], message: "Describe the custom visual style" });
  });

export const contentSettingsSchema = z.object({
  formats: z.array(z.enum(["image", "carousel", "reel"])).min(1).default(["image", "carousel"]),
  // Clamped rather than rejected, so coins saved with older, lower values still save cleanly.
  postsPerDay: z
    .number()
    .int()
    .optional()
    .transform((v) => Math.min(POSTS_PER_DAY.max, Math.max(POSTS_PER_DAY.min, v ?? POSTS_PER_DAY.min))),
  reelsPerWeek: z.number().int().min(0).max(49).default(3),
  autoPublish: z.boolean().default(true),
  hashtags: z.array(z.string().regex(/^[\p{L}\p{N}_]{1,40}$/u, "Hashtags: letters, numbers, underscores")).max(8).default([]),
  // Post (at most once a day) when the treasury buys back and burns the coin.
  postAboutBurns: z.boolean().default(true),
  // The influencer answers comments on its posts in character.
  commentReplies: z.boolean().default(true),
  commentRepliesPerDay: z.number().int().min(5).max(150).default(40),
  // Reels: "film" = live-action, cinematic footage; "match" = the character's own art style.
  reelLook: z.enum(["film", "match"]).default("film"),
});

const optionalUrl = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().url().optional());

/** Instagram username: letters, numbers, periods and underscores, up to 30 characters. Leading @ is dropped. */
export const instagramUsernameSchema = z.string().transform((s, ctx) => {
  const u = normalizeInstagramUsername(s);
  if (u === null) {
    ctx.addIssue({ code: "custom", message: INSTAGRAM_USERNAME_MESSAGE });
    return z.NEVER;
  }
  return u;
});

export const coinDraftSchema = z.object({
  // Required: the token's website on pump.fun links to this Instagram profile from the moment it launches.
  instagramUsername: z
    .string({ required_error: "Instagram account: enter the coin's Instagram username" })
    .trim()
    .min(1, "Instagram account: enter the coin's Instagram username")
    .pipe(instagramUsernameSchema),
  name: z.string().trim().min(1).max(32),
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9$]+$/, "Ticker: letters and numbers only")
    .transform((s) => s.replace(/^\$/, "").toUpperCase()),
  description: z.string().trim().max(500).default(""),
  // No website field: every coin's website is locked to its own Reelpad page.
  twitter: optionalUrl,
  telegram: optionalUrl,
  persona: personaSchema,
  contentSettings: contentSettingsSchema,
});

export type Persona = z.infer<typeof personaSchema>;
export type ContentSettings = z.infer<typeof contentSettingsSchema>;
export type CoinDraft = z.infer<typeof coinDraftSchema>;
