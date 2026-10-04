import { config } from "../../config.js";
import { imageInput } from "../../domain/images.js";
import { clipSeconds, supportsAudio, videoFamily, videoInput } from "../../domain/reel.js";

/**
 * fal.ai queue API: submit, poll status, fetch result. Model IDs are configurable via env so
 * you can swap image/video models without code changes (input field names may differ per model).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run<T>(
  model: string,
  input: Record<string, unknown>,
  timeoutMs: number,
  onTick?: (elapsedMs: number) => Promise<unknown> | void,
): Promise<T> {
  const headers = { Authorization: `Key ${config.FAL_KEY}`, "Content-Type": "application/json" };
  const submit = await fetch(`https://queue.fal.run/${model}`, { method: "POST", headers, body: JSON.stringify(input) });
  if (!submit.ok) throw new Error(`fal submit failed (${submit.status}): ${(await submit.text()).slice(0, 300)}`);
  const { status_url, response_url } = (await submit.json()) as { status_url: string; response_url: string };

  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastTick = 0;
  while (Date.now() < deadline) {
    if (onTick && Date.now() - lastTick > 10_000) {
      lastTick = Date.now();
      await Promise.resolve(onTick(lastTick - started)).catch(() => {});
    }
    const s = await fetch(status_url, { headers });
    if (s.ok) {
      const status = (await s.json()) as { status: string; error?: string };
      if (status.status === "COMPLETED") {
        if (status.error) throw new Error(`fal generation failed: ${status.error}`);
        break;
      }
    }
    await sleep(3000);
  }
  if (Date.now() >= deadline) throw new Error(`fal generation timed out (${model})`);

  const r = await fetch(response_url, { headers });
  if (!r.ok) throw new Error(`fal result failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

/**
 * Generates an image in the coin's character, using the token image as a visual reference
 * (keeps the influencer recognisable from post to post).
 */
export async function generateImage(prompt: string, referenceImageUrl: string, aspectRatio: "1:1" | "9:16" = "1:1") {
  const model = config.FAL_IMAGE_MODEL;
  const out = await run<{ images?: Array<{ url: string }>; has_nsfw_concepts?: boolean[] }>(
    model,
    imageInput(model, prompt, referenceImageUrl, aspectRatio),
    4 * 60_000,
  );
  if (out.has_nsfw_concepts?.some(Boolean)) throw new Error("Generated image was flagged by the safety checker");
  const url = out.images?.[0]?.url;
  if (!url) throw new Error("Image model returned no image");
  return url;
}

/** Typical time to render a clip; drives the progress estimate (never shown as done before it is). */
const EXPECTED_VIDEO_MS = 4 * 60_000;

/**
 * Animates a keyframe image into a short vertical Reel. With audio on, the model also generates the
 * character's voice (lip-synced to the quoted line in the prompt) and the scene's sound effects.
 * `onProgress` receives an estimated fraction (0–0.95) every ~10 seconds while it renders.
 */
export async function generateVideo(prompt: string, keyframeUrl: string, onProgress?: (fraction: number) => Promise<unknown>) {
  const model = config.FAL_REEL_MODEL;
  const out = await run<{ video?: { url: string } }>(
    model,
    videoInput(model, prompt, keyframeUrl, config.REEL_SECONDS, config.REEL_AUDIO),
    15 * 60_000,
    // Eases toward 95% so a slow render keeps moving without ever claiming to be finished.
    onProgress ? (elapsed) => onProgress(Math.min(0.95, 1 - Math.exp(-elapsed / EXPECTED_VIDEO_MS * 1.6))) : undefined,
  );
  const url = out.video?.url;
  if (!url) throw new Error("Video model returned no video");
  return url;
}

/** True when Reels will have sound and speech with the configured model. */
export const reelsHaveAudio = () => config.REEL_AUDIO && supportsAudio(config.FAL_REEL_MODEL);

/** The clip length the configured model will actually render. */
export const reelSeconds = () => clipSeconds(videoFamily(config.FAL_REEL_MODEL), config.REEL_SECONDS);
