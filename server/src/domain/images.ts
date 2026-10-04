/** Request body for each family of fal image-editing models (they name their inputs differently). */
export function imageInput(model: string, prompt: string, referenceUrl: string, aspectRatio: "1:1" | "9:16"): Record<string, unknown> {
  // Google Nano Banana (Pro / 2), Seedream, FLUX.2 edit: a list of reference images.
  if (/nano-banana|gemini-.*image|seedream|flux-2/i.test(model)) {
    return {
      prompt: `The character is the one in the reference image. ${prompt}`,
      image_urls: [referenceUrl],
      aspect_ratio: aspectRatio,
      // Vertical Reel keyframes go to video models that want 720p or more, so draw them larger.
      resolution: aspectRatio === "9:16" ? "2K" : "1K",
      output_format: "jpeg",
      num_images: 1,
      safety_tolerance: "4",
    };
  }
  // FLUX.1 Kontext (pro / max): a single reference image.
  return { prompt, image_url: referenceUrl, aspect_ratio: aspectRatio, output_format: "jpeg", safety_tolerance: "2" };
}
