import { z } from "zod";
import { OBJECTIVES, PERSONALITIES, VISUAL_STYLES } from "./catalog.js";
import { INSTAGRAM_USERNAME_MESSAGE, normalizeInstagramUsername } from "./instagram.js";

const keyOrCustom = (keys: readonly string[]) =>
  z.union([z.enum(keys as [string, ...string[]]), z.literal("custom")]).nullable().optional();

export const personaSchema = z
  .object({
    personality: keyOrCustom(Object.keys(PERSONALITIES)),
    personalityCustom: z.string().max(400).optional().default(""),
    objective: keyOrCustom(Object.keys(OBJECTIVES)),
    objectiveCustom: z.string().max(400).optional().default(""),
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
    if (p.objective === "custom" && !p.objectiveCustom.trim())
      ctx.addIssue({ code: "custom", path: ["objectiveCustom"], message: "Describe the custom objective" });
    if (p.visualStyle === "custom" && !p.visualStyleCustom.trim())
      ctx.addIssue({ code: "custom", path: ["visualStyleCustom"], message: "Describe the custom visual style" });
  });

export const contentSettingsSchema = z.object({
  formats: z.array(z.enum(["image", "carousel", "reel"])).min(1).default(["image", "carousel"]),
  postsPerDay: z.number().int().min(1).max(3).default(1),
  reelsPerWeek: z.number().int().min(0).max(7).default(1),
  autoPublish: z.boolean().default(true),
  hashtags: z.array(z.string().regex(/^[\p{L}\p{N}_]{1,40}$/u, "Hashtags: letters, numbers, underscores")).max(8).default([]),
});

export const treasurySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  strategy: z.enum(["hold", "dip_buyback", "steady_buyback", "buy_and_burn"]).default("hold"),
  maxSolPerAction: z.number().min(0.001).max(10).default(0.05),
  maxSolPerDay: z.number().min(0.001).max(50).default(0.2),
  reserveSol: z.number().min(0).max(1000).default(0.05),
  dipPct: z.number().min(5).max(80).default(15),
  intervalMin: z.number().int().min(15).max(1440).default(60),
  burnBought: z.boolean().default(false),
  postAboutActions: z.boolean().default(true),
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
  instagramUsername: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : undefined))
    .pipe(instagramUsernameSchema.optional()),
  name: z.string().trim().min(1).max(32),
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9$]+$/, "Ticker: letters and numbers only")
    .transform((s) => s.replace(/^\$/, "").toUpperCase()),
  description: z.string().trim().max(500).default(""),
  website: optionalUrl,
  twitter: optionalUrl,
  telegram: optionalUrl,
  persona: personaSchema,
  contentSettings: contentSettingsSchema,
  treasurySettings: treasurySettingsSchema,
});

export type Persona = z.infer<typeof personaSchema>;
export type ContentSettings = z.infer<typeof contentSettingsSchema>;
export type TreasurySettings = z.infer<typeof treasurySettingsSchema>;
export type CoinDraft = z.infer<typeof coinDraftSchema>;
