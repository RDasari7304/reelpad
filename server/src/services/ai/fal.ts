import { config } from "../../config.js";

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
  const out = await run<{ images?: Array<{ url: string }>; has_nsfw_concepts?: boolean[] }>(
    config.FAL_IMAGE_MODEL,
    { prompt, image_url: referenceImageUrl, aspect_ratio: aspectRatio, output_format: "jpeg", safety_tolerance: "2" },
    3 * 60_000,
  );
  if (out.has_nsfw_concepts?.some(Boolean)) throw new Error("Generated image was flagged by the safety checker");
  const url = out.images?.[0]?.url;
  if (!url) throw new Error("Image model returned no image");
  return url;
}

/** Typical time to render a 5-second clip; drives the progress estimate (never shown as done before it is). */
const EXPECTED_VIDEO_MS = 4 * 60_000;

/**
 * Animates a keyframe image into a short vertical video for a Reel.
 * `onProgress` receives an estimated fraction (0–0.95) every ~10 seconds while it renders.
 */
export async function generateVideo(prompt: string, keyframeUrl: string, onProgress?: (fraction: number) => Promise<unknown>) {
  const out = await run<{ video?: { url: string } }>(
    config.FAL_VIDEO_MODEL,
    {
      prompt,
      image_url: keyframeUrl,
      duration: "5",
      negative_prompt: "blur, distortion, low quality, text, watermark",
    },
    12 * 60_000,
    // Eases toward 95% so a slow render keeps moving without ever claiming to be finished.
    onProgress ? (elapsed) => onProgress(Math.min(0.95, 1 - Math.exp(-elapsed / EXPECTED_VIDEO_MS * 1.6))) : undefined,
  );
  const url = out.video?.url;
  if (!url) throw new Error("Video model returned no video");
  return url;
}
