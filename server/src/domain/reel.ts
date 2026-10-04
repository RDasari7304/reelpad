/**
 * Reels with sound: the character speaks one short line to camera, with matching ambient sound.
 * The video model generates the voice, lip movement and sound effects together from the prompt,
 * so the speech is lip-synced without a separate audio step.
 */

/** Most words a character can say naturally in one clip (about 2.5 words a second). */
export function maxSpokenWords(seconds: number): number {
  return Math.max(6, Math.floor(seconds * 2.5));
}

/**
 * Cleans a spoken line for the video model: one line, no stage directions or emoji, no quote
 * marks of its own (the prompt wraps it in quotes), trimmed to what fits in the clip.
 * English speech is written lowercase except acronyms and tickers, as the model expects.
 */
export function cleanSpokenLine(raw: string, seconds: number): string {
  let s = String(raw ?? "")
    .replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, " ") // (laughs) [whispers] *sigh*
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/["“”«»]/g, "")
    .replace(/#\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = s.split(" ").filter(Boolean);
  const max = maxSpokenWords(seconds);
  if (words.length > max) {
    s = words.slice(0, max).join(" ").replace(/[,;:\-–—]+$/, "");
    if (!/[.!?…]$/.test(s)) s += "…";
  }
  // Lowercase ordinary words; keep ALL-CAPS tokens (acronyms, $TICKER) as written.
  return s
    .split(" ")
    .map((w) => (/^\$?[A-Z0-9]{2,}[.!?,…]*$/.test(w) ? w : w.toLowerCase()))
    .join(" ")
    .trim();
}

/** A stable description of how the character sounds, so its voice stays the same from Reel to Reel. */
export function speakingVoice(voiceNotes: string, personality: string): string {
  const notes = voiceNotes.replace(/\s+/g, " ").trim().slice(0, 160);
  const p = personality.replace(/\s+/g, " ").trim().slice(0, 120);
  return [p && `personality: ${p}`, notes && `delivery: ${notes}`].filter(Boolean).join("; ");
}

export interface ReelPromptInput {
  motion: string;
  spokenLine: string;
  sound: string;
  voice: string;
  style: string;
  /** Model takes speech from quoted text in the prompt. */
  audio: boolean;
}

/** Builds the video prompt: motion, then the character speaking its line on camera, then the soundscape. */
export function reelVideoPrompt(i: ReelPromptInput): string {
  const motion = i.motion.trim() || "subtle cinematic motion";
  const parts = [`${motion.replace(/[.\s]+$/, "")}.`];
  if (i.audio) {
    if (i.spokenLine) {
      parts.push(
        `The character looks into the camera and speaks clearly, mouth moving in sync with the words, saying: "${i.spokenLine}"`,
      );
      if (i.voice) parts.push(`Voice: the character's own consistent voice (${i.voice}).`);
    }
    parts.push(`Sound: ${i.sound.trim() || "natural ambient sound that fits the scene"}. No background music with lyrics.`);
  }
  parts.push(`Style: ${i.style}.`);
  return parts.join(" ");
}

export type VideoFamily = "veo3" | "kling-audio" | "legacy";

/** Which request shape a fal video model expects. */
export function videoFamily(model: string): VideoFamily {
  if (/veo3/i.test(model)) return "veo3";
  if (/kling-video\/(v2\.6|v3|o1)/i.test(model)) return "kling-audio";
  return "legacy";
}

/** Clip length per model family, in seconds. */
export function clipSeconds(family: VideoFamily, requested: number): number {
  if (family === "veo3") return requested <= 4 ? 4 : requested <= 6 ? 6 : 8;
  return requested >= 10 ? 10 : 5;
}

/** The fal request body for a Reel clip. */
export function videoInput(
  model: string,
  prompt: string,
  keyframeUrl: string,
  seconds: number,
  audio: boolean,
): Record<string, unknown> {
  const family = videoFamily(model);
  const negative = "blur, distortion, low quality, text, watermark, subtitles, extra limbs";
  const secs = clipSeconds(family, seconds);
  switch (family) {
    case "veo3":
      return {
        prompt,
        image_url: keyframeUrl,
        duration: `${secs}s`,
        aspect_ratio: "9:16",
        resolution: "720p",
        generate_audio: audio,
        negative_prompt: negative,
      };
    case "kling-audio":
      return { prompt, start_image_url: keyframeUrl, duration: String(secs), generate_audio: audio, negative_prompt: negative };
    default:
      return { prompt, image_url: keyframeUrl, duration: String(secs), negative_prompt: negative };
  }
}

/** Whether a model can produce sound and speech. */
export const supportsAudio = (model: string) => videoFamily(model) !== "legacy";
