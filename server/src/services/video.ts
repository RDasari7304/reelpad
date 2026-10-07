import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { concatArgs, frameTimes, parseProbe, type ClipInfo } from "../domain/edit.js";
import { logger } from "../lib/logger.js";
import { mediaKey, putObject } from "./storage.js";

/**
 * Video editing for multi-shot Reels (ffmpeg): joining shots, and grabbing frames for the quality check.
 * Uses ffmpeg from FFMPEG_PATH, the system, or the ffmpeg-static package, whichever is found first.
 */

let found: Promise<string | null> | null = null;

function runCmd(bin: string, args: string[], timeoutMs = 5 * 60_000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-20_000);
    });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

async function works(bin: string) {
  try {
    return (await runCmd(bin, ["-hide_banner", "-version"], 10_000)).code === 0;
  } catch {
    return false;
  }
}

/** The ffmpeg binary to use, or null when there isn't one (Reels then fall back to a single shot). */
export function ffmpegPath(): Promise<string | null> {
  found ??= (async () => {
    const candidates: string[] = [];
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
    candidates.push("ffmpeg");
    try {
      const mod: any = await import("ffmpeg-static" as string);
      if (mod?.default) candidates.push(String(mod.default));
    } catch {
      /* optional dependency not installed */
    }
    for (const c of candidates) if (await works(c)) return c;
    logger.warn("ffmpeg not found: multi-shot Reels will use their first shot only");
    return null;
  })();
  return found;
}

async function download(url: string, path: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download clip (${res.status})`);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

async function probe(bin: string, path: string): Promise<ClipInfo> {
  const r = await runCmd(bin, ["-hide_banner", "-i", path], 30_000);
  return { path, ...parseProbe(r.stderr) };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "reel-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Joins the shots (in order) into one Reel and stores it. Returns null if editing isn't possible here. */
export async function editReel(clipUrls: string[], coinId: string): Promise<{ url: string; key: string; seconds: number } | null> {
  const bin = await ffmpegPath();
  if (!bin) return null;
  return withTemp(async (dir) => {
    const clips: ClipInfo[] = [];
    await Promise.all(clipUrls.map((u, i) => download(u, join(dir, `shot${i}.mp4`))));
    for (let i = 0; i < clipUrls.length; i++) clips.push(await probe(bin, join(dir, `shot${i}.mp4`)));
    const out = join(dir, "reel.mp4");
    const r = await runCmd(bin, concatArgs(clips, out));
    if (r.code !== 0) throw new Error(`Editing the video failed: ${r.stderr.slice(-300)}`);
    const buf = await readFile(out);
    const key = mediaKey(coinId, "mp4");
    const url = await putObject(key, buf, "video/mp4");
    return { url, key, seconds: clips.reduce((s, c) => s + c.duration, 0) };
  });
}

/**
 * Three frames from a clip (early, middle, late) side by side in one JPEG, for Claude to check.
 * Returns null when ffmpeg isn't available or the frames can't be read.
 */
export async function frameStrip(clipUrl: string): Promise<{ data: string; mediaType: "image/jpeg" } | null> {
  const bin = await ffmpegPath();
  if (!bin) return null;
  try {
    return await withTemp(async (dir) => {
      const src = join(dir, "clip.mp4");
      await download(clipUrl, src);
      const info = await probe(bin, src);
      const frames: Buffer[] = [];
      for (const [i, t] of frameTimes(info.duration).entries()) {
        const f = join(dir, `f${i}.jpg`);
        const r = await runCmd(bin, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", src, "-frames:v", "1", "-vf", "scale=360:-2", f], 30_000);
        if (r.code === 0) frames.push(await readFile(f));
      }
      if (!frames.length) return null;
      const metas = await Promise.all(frames.map((b) => sharp(b).metadata()));
      const h = Math.max(...metas.map((m) => m.height ?? 640));
      const w = metas.reduce((s, m) => s + (m.width ?? 360), 0) + (frames.length - 1) * 8;
      let x = 0;
      const composite = frames.map((b, i) => {
        const left = x;
        x += (metas[i]!.width ?? 360) + 8;
        return { input: b, left, top: 0 };
      });
      const strip = await sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } })
        .composite(composite)
        .jpeg({ quality: 80 })
        .toBuffer();
      return { data: strip.toString("base64"), mediaType: "image/jpeg" as const };
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "frame grab failed");
    return null;
  }
}

/** Fallback when ffmpeg isn't available: fal's hosted merge. Returns the merged clip's URL or null. */
export async function mergeOnFal(clipUrls: string[]): Promise<string | null> {
  try {
    const headers = { Authorization: `Key ${config.FAL_KEY}`, "Content-Type": "application/json" };
    const res = await fetch("https://fal.run/fal-ai/ffmpeg-api/merge-videos", {
      method: "POST",
      headers,
      body: JSON.stringify({ video_urls: clipUrls, target_fps: 30, resolution: { width: 1080, height: 1920 } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { video?: { url?: string } };
    return json.video?.url ?? null;
  } catch {
    return null;
  }
}
