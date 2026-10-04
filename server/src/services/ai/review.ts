import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { structured } from "./claude.js";

/**
 * Quality check: Claude looks at a generated image next to the character's token image and says
 * whether it's good enough to post. Anything off (wrong character, broken anatomy, garbled text,
 * didn't follow the brief) gets one redraw with Claude's note added to the prompt.
 */
export interface Review {
  pass: boolean;
  fix: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    same_character: { type: "boolean", description: "The generated image clearly shows the same character as the reference (face, colours, markings)." },
    clean: { type: "boolean", description: "No broken anatomy, extra limbs, melted faces, garbled text, watermarks or obvious AI artifacts." },
    matches_brief: { type: "boolean", description: "The image roughly shows the scene described in the brief." },
    fix: { type: "string", description: "If anything failed: one short instruction for the redraw (e.g. 'keep the round orange face and blue cap'). Otherwise empty." },
  },
  required: ["same_character", "clean", "matches_brief", "fix"],
  additionalProperties: false,
};

/** For live-action Reels the character is re-imagined as real: judge likeness, not art style. */
const LIVE_ACTION_NOTE =
  "\nNote: this is a deliberately LIVE-ACTION, photorealistic version of the character. Judge whether it's recognisably the same character (face shape, colours, hair, outfit, signature features), not whether the art style matches. Other people in the scene are fine.";

export async function reviewImage(candidateUrl: string, referenceUrl: string, brief: string, liveAction = false): Promise<Review> {
  try {
    const r = await structured<{ same_character: boolean; clean: boolean; matches_brief: boolean; fix: string }>({
      model: config.QUALITY_CHECK_MODEL,
      system: "You are a strict art director checking AI-generated Instagram images of a recurring character before they're posted.",
      user: `Image 1 is the character's reference (its official look). Image 2 was just generated for this brief:\n${brief.slice(0, 800)}${liveAction ? LIVE_ACTION_NOTE : ""}\n\nCheck image 2.`,
      images: [referenceUrl, candidateUrl],
      toolName: "image_review",
      toolDescription: "the review as JSON matching the schema.",
      schema: SCHEMA,
      maxTokens: 400,
    });
    return { pass: r.same_character && r.clean && r.matches_brief, fix: String(r.fix ?? "").slice(0, 300) };
  } catch (e) {
    // A failed check never blocks a post.
    logger.warn({ err: (e as Error).message }, "image review failed; keeping the image");
    return { pass: true, fix: "" };
  }
}

const SHOT_SCHEMA = {
  type: "object",
  properties: {
    same_character: { type: "boolean", description: "Every frame clearly shows the same character as the reference (face, colours, markings), with no drift between frames." },
    clean: { type: "boolean", description: "No melting or morphing faces, extra limbs, warped hands, flicker artifacts, or on-screen text/subtitles/watermarks." },
    matches_brief: { type: "boolean", description: "The frames roughly show the shot described in the brief." },
    fix: { type: "string", description: "If anything failed: one short instruction for the re-render. Otherwise empty." },
  },
  required: ["same_character", "clean", "matches_brief", "fix"],
  additionalProperties: false,
};

/**
 * Quality check for a rendered video shot: Claude sees three frames (start, middle, end) next to the
 * character's reference image. Catches face drift, morphing, extra limbs and burned-in subtitles.
 */
export async function reviewShot(strip: { data: string; mediaType: "image/jpeg" }, referenceUrl: string, brief: string, liveAction = false): Promise<Review> {
  try {
    const r = await structured<{ same_character: boolean; clean: boolean; matches_brief: boolean; fix: string }>({
      model: config.QUALITY_CHECK_MODEL,
      system: "You are a strict video editor checking AI-generated video shots of a recurring character before they go into an Instagram Reel.",
      user: `Image 1 is the character's reference (its official look). Image 2 shows three frames (start, middle, end, left to right) from a video shot made for this brief:\n${brief.slice(0, 800)}${liveAction ? LIVE_ACTION_NOTE : ""}\n\nCheck the shot.`,
      images: [referenceUrl],
      imageData: [strip],
      toolName: "shot_review",
      toolDescription: "the review as JSON matching the schema.",
      schema: SHOT_SCHEMA,
      maxTokens: 400,
    });
    return { pass: r.same_character && r.clean && r.matches_brief, fix: String(r.fix ?? "").slice(0, 300) };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "shot review failed; keeping the shot");
    return { pass: true, fix: "" };
  }
}
