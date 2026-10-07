import sharp from "sharp";
import { mediaKey, putObject, rehost } from "./storage.js";

/** TikTok photo posts accept JPEG or WEBP; normalise everything we post to JPEG. */
export async function rehostImage(remoteUrl: string, coinId: string, aspect: "1:1" | "9:16") {
  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`Failed to download generated image (${res.status})`);
  const input = Buffer.from(await res.arrayBuffer());
  const [w, h] = aspect === "1:1" ? [1080, 1080] : [1080, 1920];
  const jpeg = await sharp(input).rotate().resize(w, h, { fit: "cover" }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const key = mediaKey(coinId, "jpg");
  return { url: await putObject(key, jpeg, "image/jpeg"), key };
}

export async function rehostVideo(remoteUrl: string, coinId: string) {
  const r = await rehost(remoteUrl, coinId);
  return { url: r.url, key: r.key };
}

/** Validates and normalises an uploaded token image: square PNG, max 1000px. */
export async function normaliseTokenImage(buf: Buffer): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error("Unreadable image");
  if (meta.width < 128 || meta.height < 128) throw new Error("Image must be at least 128×128");
  return sharp(buf, { animated: false }).rotate().resize(1000, 1000, { fit: "cover" }).png().toBuffer();
}
