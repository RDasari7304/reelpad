/**
 * Variety for posts. Every post gets a different combination of post type, camera shot, lighting and
 * caption style, avoiding whatever the coin's recent posts used, so the feed doesn't repeat itself.
 * Pure and unit-tested.
 */
export const POST_ANGLES = [
  "a day-in-the-life moment doing something ordinary in an unusual way",
  "an action scene: caught mid-movement doing something exciting",
  "a behind-the-scenes look at a project it is working on",
  "a funny fail or blooper it laughs at itself about",
  "a proud milestone or small victory",
  "exploring a brand-new place for the first time",
  "a quiet, reflective moment that shows its softer side",
  "a POV shot showing what it sees",
  "a meme-style reaction to something relatable",
  "meeting a new (fictional) friend or creature",
  "a question for followers, with a scene that invites answers",
  "a new chapter of its ongoing story or lore",
  "a dramatic, cinematic hero moment",
  "a cosy, wholesome everyday moment",
  "showing off a collection, invention or creation",
  "a seasonal or weather-themed moment",
] as const;

export const CAMERA_SHOTS = [
  "extreme close-up portrait filling the frame",
  "wide establishing shot with the character small in a big environment",
  "low-angle hero shot looking up at the character",
  "high-angle overhead shot looking down",
  "side profile in motion",
  "over-the-shoulder view looking at what the character sees",
  "dynamic action angle with motion blur",
  "symmetrical centred composition",
  "candid off-centre shot, as if caught unaware",
  "medium shot with a strong foreground object framing the character",
] as const;

export const LIGHTING = [
  "soft morning light",
  "bright midday sun",
  "golden hour glow",
  "blue hour dusk",
  "night under stars",
  "neon city lights at night",
  "rainy and moody",
  "snowy and crisp",
  "warm indoor lamplight",
  "foggy, dreamy haze",
  "dramatic storm light",
  "colourful festival lights",
] as const;

export const CAPTION_STYLES = [
  "one punchy line, under 15 words",
  "a short story in 3 to 4 sentences",
  "a numbered list of 3 things",
  "a question to followers",
  "a mini diary entry with a date-style opener",
  "a short exchange of dialogue",
  "a dramatic announcement",
  "a tiny poem or rhyme of 2 to 4 lines",
  "a 'fun fact' style caption",
  "a hot take the character stands by",
] as const;

export interface Variety {
  angle: string;
  shot: string;
  lighting: string;
  captionStyle: string;
}

/** How many recent posts each dimension avoids repeating. */
const AVOID = { angle: 8, shot: 5, lighting: 5, captionStyle: 5 } as const;

function pickAvoiding<T extends string>(options: readonly T[], recent: string[], avoidLast: number, rand: () => number): T {
  const avoid = new Set(recent.slice(0, avoidLast));
  const fresh = options.filter((o) => !avoid.has(o));
  const pool = fresh.length ? fresh : options;
  return pool[Math.floor(rand() * pool.length)] ?? options[0]!;
}

/** Picks this post's variety, avoiding what the most recent posts (newest first) used. */
export function pickVariety(recent: Array<Partial<Variety>>, rand: () => number = Math.random): Variety {
  const col = (k: keyof Variety) => recent.map((r) => r[k]).filter((v): v is string => typeof v === "string");
  return {
    angle: pickAvoiding(POST_ANGLES, col("angle"), AVOID.angle, rand),
    shot: pickAvoiding(CAMERA_SHOTS, col("shot"), AVOID.shot, rand),
    lighting: pickAvoiding(LIGHTING, col("lighting"), AVOID.lighting, rand),
    captionStyle: pickAvoiding(CAPTION_STYLES, col("captionStyle"), AVOID.captionStyle, rand),
  };
}

/** First few words of a caption, used to stop the character opening every post the same way. */
export function captionOpener(caption: string | null | undefined, words = 5): string {
  return (caption ?? "").trim().split(/\s+/).slice(0, words).join(" ");
}
