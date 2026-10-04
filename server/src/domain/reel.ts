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

/**
 * How Reels look. "film": live-action, like footage from a movie or a premium ad, whatever the
 * character's usual art style (a cartoon frog becomes a real, practical-effects frog on a real street).
 * "match": the character's own visual style (3D render, anime...), like its image posts.
 */
export type ReelLook = "film" | "match";

export const FILM_LOOK =
  "photorealistic live-action film footage, shot on a cinema camera with a 35mm lens, natural motivated lighting, real skin, fur and fabric texture, shallow depth of field, subtle film grain, colour graded like a feature film. The character is played for real: a live-action version of the reference character with the same face shape, hair, colours, outfit and signature features, never a cartoon or 3D render";

export const reelStyle = (look: ReelLook | undefined, base: string) => (look === "match" ? base : FILM_LOOK);

/** Extra direction for film-look Reels: real places, other people, film shot grammar. */
export const FILM_DIRECTION =
  "Shoot it like a scene from a movie or a premium ad, in live action: a specific real-world location (a hotel driveway, a laundromat at night, a rooftop, a diner booth), and other people in the scene when it fits (a driver, a barista, a doorman, passers-by, a friend) who react to you and interact with you. Use film shot grammar: two-shots, over-the-shoulder, side profile, tracking shots, a reaction close-up; not every shot is you staring into the lens. You can talk to someone in the scene instead of the camera. Only you speak: the other people react without talking.";

export interface ReelPromptInput {
  motion: string;
  spokenLine: string;
  sound: string;
  voice: string;
  style: string;
  /** Model takes speech from quoted text in the prompt. */
  audio: boolean;
  /** Shot size and camera movement, e.g. "slow push-in, close-up". */
  camera?: string;
  /** Who the character talks to: "camera" (default) or someone in the scene. */
  to?: string;
}

/**
 * Builds the video prompt in the order video models follow best: camera, action, dialogue, sound,
 * style. A shot without a line says so explicitly, otherwise the model tends to invent mumbled speech;
 * and on-screen text is ruled out, because models like to add subtitles.
 */
export function reelVideoPrompt(i: ReelPromptInput): string {
  const motion = i.motion.trim() || "subtle, natural movement";
  const parts: string[] = [];
  if (i.camera?.trim()) parts.push(`Camera: ${i.camera.trim().replace(/[.\s]+$/, "")}.`);
  parts.push(`${motion.replace(/[.\s]+$/, "")}.`);
  if (i.audio) {
    if (i.spokenLine) {
      const to = (i.to ?? "").trim();
      const toCamera = !to || /^(the )?(camera|lens|viewer|audience)$/i.test(to);
      parts.push(
        toCamera
          ? `The character looks into the camera and speaks clearly, mouth moving in sync with the words, saying: "${i.spokenLine}"`
          : `The character turns to ${to} and speaks clearly, mouth moving in sync with the words, saying: "${i.spokenLine}" Only the character speaks; everyone else reacts silently.`,
      );
      if (i.voice) parts.push(`Voice: the character's own consistent voice (${i.voice}).`);
    } else {
      parts.push("The character does not speak in this shot: no dialogue, no talking, no voice-over.");
    }
    parts.push(`Sound: ${i.sound.trim() || "natural ambient sound that fits the scene"}. No background music with lyrics.`);
  }
  parts.push(`Style: ${i.style}. Keep the character's face, colours and features exactly the same throughout. No on-screen text, captions or subtitles.`);
  return parts.join(" ");
}

/** One shot of a multi-shot Reel, as planned by the character. */
export interface ReelShot {
  /** The opening frame of the shot (drawn first, then animated). */
  image: string;
  camera: string;
  motion: string;
  line: string;
  sound: string;
  /** Who the character talks to in this shot ("camera", or someone in the scene). */
  to?: string;
}

export const MAX_SHOTS = 3;
export const clampShots = (n: number) => Math.max(1, Math.min(MAX_SHOTS, Math.round(Number(n) || 1)));

/** What each shot is for, so the Reel plays like an edited short rather than one long take. */
export function shotRoles(n: number): string[] {
  if (n <= 1) return ["the whole moment in one shot: hook in the first second, end on a clean beat"];
  if (n === 2) return ["the hook: grab attention in the first second", "the payoff: the punchline, reveal or twist, ending on a clean beat"];
  return [
    "the hook: something visually surprising or a line that stops the scroll in the first second",
    "the build: the situation develops or escalates",
    "the payoff: the punchline, reveal or twist, ending on a clean beat",
  ];
}

/**
 * Cleans the planned shots: trims fields, caps lines to what fits in a shot, keeps at most `count`.
 * Falls back to a single shot from the older single-clip fields when the plan has no usable shots.
 */
export function normalizeShots(
  raw: Array<{ image_prompt?: string; camera?: string; motion?: string; spoken_line?: string; sound?: string; talking_to?: string }> | undefined,
  fallback: { image: string; motion: string; line: string; sound: string },
  count: number,
  seconds: number,
  audio: boolean,
): ReelShot[] {
  const shots = (Array.isArray(raw) ? raw : [])
    .map((r) => ({
      image: String(r?.image_prompt ?? "").trim().slice(0, 900),
      camera: String(r?.camera ?? "").trim().slice(0, 160),
      motion: String(r?.motion ?? "").trim().slice(0, 500),
      line: audio ? cleanSpokenLine(String(r?.spoken_line ?? ""), seconds) : "",
      sound: audio ? String(r?.sound ?? "").trim().slice(0, 200) : "",
      to: String(r?.talking_to ?? "").trim().slice(0, 80) || "camera",
    }))
    .filter((s) => s.image)
    .slice(0, clampShots(count));
  if (shots.length) return shots;
  return [
    {
      image: fallback.image,
      camera: "",
      motion: fallback.motion,
      line: audio ? cleanSpokenLine(fallback.line, seconds) : "",
      sound: audio ? fallback.sound : "",
      to: "camera",
    },
  ];
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
  resolution: "720p" | "1080p" = "720p",
): Record<string, unknown> {
  const family = videoFamily(model);
  const negative = "blur, distortion, low quality, text, watermark, subtitles, captions, extra limbs, morphing face, flicker";
  const secs = clipSeconds(family, seconds);
  switch (family) {
    case "veo3":
      return {
        prompt,
        image_url: keyframeUrl,
        duration: `${secs}s`,
        aspect_ratio: "9:16",
        resolution,
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
