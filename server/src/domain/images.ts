/** Whether an image model can take several reference images (needed for two characters in one picture). */
export const supportsMultiReference = (model: string) => /nano-banana|gemini-.*image|seedream|flux-2/i.test(model);

/**
 * Request body for each family of fal image-editing models (they name their inputs differently).
 * `refs[0]` is the main character; `refs[1]` (collab posts) is the friend appearing with them.
 */
export function imageInput(model: string, prompt: string, refs: string | string[], aspectRatio: "1:1" | "9:16"): Record<string, unknown> {
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  // Google Nano Banana (Pro / 2), Seedream, FLUX.2 edit: a list of reference images.
  if (supportsMultiReference(model)) {
    const lead =
      list.length > 1
        ? "The first reference image is the main character and the second is their friend. Show both of them together, each keeping their own look exactly."
        : "The character is the one in the reference image.";
    return {
      prompt: `${lead} ${prompt}`,
      image_urls: list.slice(0, 4),
      aspect_ratio: aspectRatio,
      // Vertical Reel keyframes go to video models that want 720p or more, so draw them larger.
      resolution: aspectRatio === "9:16" ? "2K" : "1K",
      output_format: "jpeg",
      num_images: 1,
      safety_tolerance: "4",
    };
  }
  // FLUX.1 Kontext (pro / max): a single reference image.
  return { prompt, image_url: list[0], aspect_ratio: aspectRatio, output_format: "jpeg", safety_tolerance: "2" };
}
