/**
 * Editing multi-shot videos: the ffmpeg command that joins the shots into one TikTok-ready video.
 * Pure (builds arguments, parses output) so it can be tested without ffmpeg.
 */

export interface ClipInfo {
  path: string;
  /** Seconds. */
  duration: number;
  hasAudio: boolean;
}

/** Reads duration and whether there's an audio stream from `ffmpeg -i file` output (stderr). */
export function parseProbe(stderr: string): { duration: number; hasAudio: boolean } {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  return { duration, hasAudio: /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:/.test(stderr) };
}

const W = 1080;
const H = 1920;

/**
 * ffmpeg arguments that join the clips with hard cuts into a 1080x1920, 30 fps H.264/AAC MP4
 * (TikTok's recommended vertical video spec). Each clip's audio gets tiny fades so cuts don't click, a clip without audio
 * gets silence, and the whole soundtrack is loudness-normalised for phones.
 */
export function concatArgs(clips: ClipInfo[], out: string): string[] {
  if (!clips.length) throw new Error("No clips to edit");
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const c of clips) args.push("-i", c.path);
  const parts: string[] = [];
  const labels: string[] = [];
  clips.forEach((c, i) => {
    const d = Math.max(0.2, c.duration || 0.2);
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,format=yuv420p,setsar=1,trim=duration=${d.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
    );
    const fades = `afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, d - 0.06).toFixed(3)}:d=0.06`;
    parts.push(
      c.hasAudio
        ? `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${d.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${d.toFixed(3)},${fades}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${d.toFixed(3)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${clips.length}:v=1:a=1[v][a]`);
  parts.push(`[a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[ao]`);
  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[v]",
    "-map",
    "[ao]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "19",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    out,
  );
  return args;
}

/** Where to grab frames for the quality check: early, middle and late in the clip. */
export function frameTimes(duration: number): number[] {
  const d = Math.max(0.5, duration || 0.5);
  return [Math.min(0.4, d * 0.1), d * 0.5, Math.max(0, d - 0.35)].map((t) => Math.round(t * 100) / 100);
}
