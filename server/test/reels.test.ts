import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { concatArgs, frameTimes, parseProbe } from "../src/domain/edit.ts";
import { clampShots, FILM_LOOK, normalizeShots, reelStyle, reelVideoPrompt, shotRoles, videoInput } from "../src/domain/reel.ts";

describe("multi-shot reels", () => {
  const fallback = { image: "fallback frame", motion: "waves", line: "hello there", sound: "wind" };
  it("keeps planned shots, trims lines to fit, caps the count", () => {
    const raw = [1, 2, 3, 4].map((i) => ({
      image_prompt: `frame ${i}`,
      camera: "close-up",
      motion: "turns",
      spoken_line: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo",
      sound: "rain",
    }));
    const s = normalizeShots(raw, fallback, 3, 8, true);
    assert.equal(s.length, 3);
    assert.equal(s[2]!.image, "frame 3");
    assert.ok(s[0]!.line.split(" ").length <= 20);
  });
  it("falls back to the single-shot fields for old plans", () => {
    const s = normalizeShots(undefined, fallback, 3, 8, true);
    assert.deepEqual(s, [{ image: "fallback frame", camera: "", motion: "waves", line: "hello there", sound: "wind", to: "camera" }]);
    assert.equal(normalizeShots([{ image_prompt: "" }], fallback, 3, 8, true)[0]!.image, "fallback frame");
  });
  it("drops speech and sound for silent reels", () => {
    const s = normalizeShots([{ image_prompt: "f", spoken_line: "hi", sound: "x" }], fallback, 1, 8, false);
    assert.equal(s[0]!.line, "");
    assert.equal(s[0]!.sound, "");
  });
  it("gives every shot a job", () => {
    assert.equal(shotRoles(3).length, 3);
    assert.match(shotRoles(3)[0]!, /hook/);
    assert.match(shotRoles(3)[2]!, /payoff/);
    assert.equal(clampShots(9), 3);
    assert.equal(clampShots(0), 1);
  });
  it("tells the model when a shot has no talking, and bans subtitles", () => {
    const quiet = reelVideoPrompt({ motion: "runs", camera: "wide, handheld", spokenLine: "", sound: "", voice: "v", style: "3D", audio: true });
    assert.match(quiet, /^Camera: wide, handheld\./);
    assert.match(quiet, /does not speak/);
    assert.match(quiet, /No on-screen text/);
    const talk = reelVideoPrompt({ motion: "waves", spokenLine: "hi", sound: "", voice: "v", style: "3D", audio: true });
    assert.match(talk, /saying: "hi"/);
    assert.doesNotMatch(talk, /does not speak/);
  });
  it("film look is live-action by default; match keeps the art style", () => {
    assert.equal(reelStyle(undefined, "3D render"), FILM_LOOK);
    assert.equal(reelStyle("film", "3D render"), FILM_LOOK);
    assert.equal(reelStyle("match", "3D render"), "3D render");
    assert.match(FILM_LOOK, /live-action/);
  });
  it("lets the character talk to someone in the scene, with others silent", () => {
    const p = reelVideoPrompt({ motion: "leans on the limo", to: "the chauffeur", spokenLine: "keep the engine running", sound: "", voice: "", style: "film", audio: true });
    assert.match(p, /turns to the chauffeur/);
    assert.match(p, /everyone else reacts silently/);
    const c = reelVideoPrompt({ motion: "x", to: "camera", spokenLine: "hi", sound: "", voice: "", style: "film", audio: true });
    assert.match(c, /looks into the camera/);
    const shots = normalizeShots([{ image_prompt: "f", talking_to: "the doorman" }], { image: "", motion: "", line: "", sound: "" }, 1, 8, true);
    assert.equal(shots[0]!.to, "the doorman");
  });
  it("asks Veo for 1080p when configured", () => {
    assert.equal(videoInput("fal-ai/veo3.1/fast/image-to-video", "p", "u", 8, true, "1080p").resolution, "1080p");
    assert.equal(videoInput("fal-ai/veo3.1/fast/image-to-video", "p", "u", 8, true).resolution, "720p");
    assert.equal(videoInput("fal-ai/veo3.1/fast/image-to-video", "p", "u", 8, true).duration, "8s");
  });
});

describe("reel editing", () => {
  it("reads duration and audio from ffmpeg output", () => {
    const err = `Input #0, mov,mp4, from 'a.mp4':\n  Duration: 00:00:08.04, start: 0.000000, bitrate: 2000 kb/s\n  Stream #0:0[0x1](und): Video: h264\n  Stream #0:1[0x2](und): Audio: aac (LC)`;
    assert.deepEqual(parseProbe(err), { duration: 8.04, hasAudio: true });
    assert.deepEqual(parseProbe("Duration: 00:01:02.50\n Stream #0:0: Video: h264"), { duration: 62.5, hasAudio: false });
  });
  it("builds one filter graph with silence for clips without sound", () => {
    const args = concatArgs(
      [
        { path: "a.mp4", duration: 8, hasAudio: true },
        { path: "b.mp4", duration: 8, hasAudio: false },
      ],
      "out.mp4",
    );
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    assert.match(graph, /\[0:a\]/);
    assert.doesNotMatch(graph, /\[1:a\]/);
    assert.match(graph, /anullsrc/);
    assert.match(graph, /concat=n=2:v=1:a=1/);
    assert.equal(args.at(-1), "out.mp4");
    assert.throws(() => concatArgs([], "x"));
  });
  it("grabs frames inside the clip", () => {
    for (const t of frameTimes(8)) assert.ok(t >= 0 && t < 8);
  });

  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  it("joins real clips into a 1080x1920 Reel with sound", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "reeltest-"));
    try {
      // A 720p clip with a tone, and a silent clip of another size, like two different model outputs.
      const a = join(dir, "a.mp4");
      const b = join(dir, "b.mp4");
      spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-c:a", "aac", a]);
      spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=1.5", "-c:v", "libx264", b]);
      const clips = [a, b].map((p) => ({ path: p, ...parseProbe(spawnSync("ffmpeg", ["-hide_banner", "-i", p]).stderr.toString()) }));
      assert.equal(clips[0]!.hasAudio, true);
      assert.equal(clips[1]!.hasAudio, false);
      const out = join(dir, "out.mp4");
      const r = spawnSync("ffmpeg", concatArgs(clips, out));
      assert.equal(r.status, 0, r.stderr?.toString());
      assert.ok(existsSync(out));
      const info = spawnSync("ffmpeg", ["-hide_banner", "-i", out]).stderr.toString();
      assert.match(info, /1080x1920/);
      assert.match(info, /Audio: aac/);
      const { duration } = parseProbe(info);
      assert.ok(duration > 3.3 && duration < 3.8, `duration ${duration}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
