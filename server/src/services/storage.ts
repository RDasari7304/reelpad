import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { sha256Hex, signRequest, uriEncode } from "../lib/sigv4.js";

/**
 * Public media storage (S3-compatible, e.g. Cloudflare R2 with a public bucket/custom domain).
 * TikTok pulls media by URL, so everything we publish must be reachable at S3_PUBLIC_BASE_URL.
 */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
  const base = config.S3_ENDPOINT.replace(/\/$/, "");
  const url = `${base}/${uriEncode(config.S3_BUCKET, false)}/${uriEncode(key, true)}`;
  const headers = signRequest({
    method: "PUT",
    url,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" },
    payloadHash: sha256Hex(body),
  });
  const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return publicUrl(key);
}

export function publicUrl(key: string) {
  return `${config.S3_PUBLIC_BASE_URL.replace(/\/$/, "")}/${uriEncode(key, true)}`;
}

export function mediaKey(coinId: string, ext: string) {
  return `coins/${coinId}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
}

/** Download a remote file (e.g. a fal.ai result, which expires) and re-host it permanently. */
export async function rehost(remoteUrl: string, coinId: string, maxBytes = 200 * 1024 * 1024) {
  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`Failed to download generated media (${res.status})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error("Generated media too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("Generated media too large");
  const contentType = res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
  const ext = contentType.includes("mp4") ? "mp4" : contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const key = mediaKey(coinId, ext);
  const url = await putObject(key, buf, contentType);
  return { url, key, contentType, bytes: buf.length };
}
