import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { captionViolations, finalizeCaption, limitEmojis } from "../src/domain/caption.ts";
import { CAMERA_SHOTS, CAPTION_STYLES, captionOpener, LIGHTING, pickVariety, POST_ANGLES } from "../src/domain/variety.ts";
import { LEGACY_PERSONALITIES, PERSONALITIES } from "../src/domain/catalog.ts";
import { CONTENT_RULES, personaBrief, visualStyleText } from "../src/domain/persona.ts";
import { normalizeInstagramUsername } from "../src/domain/instagram.ts";
import { POSTS_PER_DAY } from "../src/domain/limits.ts";
import { coinPageUrl } from "../src/domain/links.ts";
import { cleanSpokenLine, clipSeconds, maxSpokenWords, reelVideoPrompt, speakingVoice, supportsAudio, videoFamily, videoInput } from "../src/domain/reel.ts";
import { chooseFormat, firstPostFormat, nextPostAt } from "../src/domain/schedule.ts";
import { decideBuyback, spendable, type BuybackInput } from "../src/domain/treasuryPolicy.ts";
import { decrypt, decryptString, encrypt, parseMasterKey } from "../src/lib/crypto.ts";
import { signRequest, uriEncode } from "../src/lib/sigv4.ts";

describe("crypto", () => {
  const key = randomBytes(32);
  it("round-trips secrets", () => {
    const env = encrypt("long-lived-instagram-token", key);
    assert.equal(decryptString(env, key), "long-lived-instagram-token");
    const kp = randomBytes(64);
    assert.deepEqual(decrypt(encrypt(kp, key), key), kp);
  });
  it("uses a fresh IV every time", () => {
    assert.notEqual(encrypt("x", key), encrypt("x", key));
  });
  it("rejects tampering and wrong keys", () => {
    const env = encrypt("secret", key);
    const parts = env.split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64");
    assert.throws(() => decrypt(parts.join(":"), key));
    assert.throws(() => decrypt(env, randomBytes(32)));
  });
  it("validates master key length", () => {
    assert.throws(() => parseMasterKey(randomBytes(16).toString("base64")));
    assert.equal(parseMasterKey(randomBytes(32).toString("base64")).length, 32);
  });
});

describe("sigv4", () => {
  // AWS published example: GET object with Range header (S3 SigV4 docs).
  it("matches the AWS S3 GetObject test vector", () => {
    const headers = signRequest({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      date: new Date("2013-05-24T00:00:00Z"),
    });
    assert.equal(
      headers.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
  it("encodes keys like S3", () => {
    assert.equal(uriEncode("coins/a b/ü.png", true), "coins/a%20b/%C3%BC.png");
    assert.equal(uriEncode("a/b", false), "a%2Fb");
  });
});

const base: BuybackInput = {
  solBalance: 0.5,
  spentTodaySol: 0,
  minutesSinceLastBuy: null,
  limits: { gasReserveSol: 0.01, minBuySol: 0.01, maxSolPerBuy: 0.5, maxSolPerDay: 2, intervalMin: 60 },
};

describe("buyback-and-burn policy", () => {
  it("spends collected fees above the gas reserve", () => {
    const d = decideBuyback(base);
    assert.equal(d.action, "buy");
    assert.ok(d.action === "buy" && Math.abs(d.sol - 0.49) < 1e-9);
  });
  it("always keeps the gas reserve", () => {
    for (const bal of [0.011, 0.02, 0.3, 0.51]) {
      const d = decideBuyback({ ...base, solBalance: bal });
      if (d.action === "buy") assert.ok(d.sol <= bal - 0.01 + 1e-9);
    }
    assert.equal(spendable({ ...base, solBalance: 0.005 }), 0);
  });
  it("waits until enough fees have collected", () => {
    const d = decideBuyback({ ...base, solBalance: 0.015 });
    assert.equal(d.action, "skip");
    assert.match(d.reason, /Collecting creator fees/);
  });
  it("caps each buyback", () => {
    const d = decideBuyback({ ...base, solBalance: 10 });
    assert.ok(d.action === "buy" && d.sol <= 0.5);
  });
  it("caps daily spending and carries the rest over", () => {
    const near = decideBuyback({ ...base, solBalance: 10, spentTodaySol: 1.8 });
    assert.ok(near.action === "buy" && near.sol <= 0.2 + 1e-9);
    const done = decideBuyback({ ...base, solBalance: 10, spentTodaySol: 2 });
    assert.equal(done.action, "skip");
    assert.match(done.reason, /Daily buyback limit/);
  });
  it("spaces buybacks out", () => {
    assert.equal(decideBuyback({ ...base, minutesSinceLastBuy: 30 }).action, "skip");
    assert.equal(decideBuyback({ ...base, minutesSinceLastBuy: 61 }).action, "buy");
  });
  it("never buys with an empty treasury", () => {
    assert.equal(decideBuyback({ ...base, solBalance: 0 }).action, "skip");
  });
});

describe("captions", () => {
  it("flags financial-promise language", () => {
    assert.ok(captionViolations("This is going to 100x, buy now!").length >= 2);
    assert.ok(captionViolations("guaranteed returns for holders").length);
    assert.ok(captionViolations("totally risk-free").length);
    assert.ok(captionViolations("we will moon soon").length);
  });
  it("allows normal posts and disclaimers", () => {
    assert.deepEqual(captionViolations("Good morning frens ☀️ the treasury bought back 0.1 SOL today."), []);
    assert.deepEqual(captionViolations("Not financial advice, just vibes."), []);
  });
  it("adds hashtags without duplicates, then the footer", () => {
    const c = finalizeCaption("gm #pepe", ["pepe", "#memes", "art"], "AI persona.");
    assert.equal(c, "gm #pepe\n\n#memes #art\n\nAI persona.");
  });
  it("stays within Instagram limits", () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    const c = finalizeCaption("x".repeat(3000), tags, "footer");
    assert.ok(c.length <= 2200);
    assert.ok(c.endsWith("footer"));
    const c2 = finalizeCaption("hello", tags, "");
    assert.ok((c2.match(/#/g) ?? []).length <= 30);
  });
});

describe("schedule", () => {
  it("spaces posts through the day with jitter", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const mid = nextPostAt(from, 2, () => 0.5);
    assert.equal(mid.getTime() - from.getTime(), 12 * 3600_000);
    const early = nextPostAt(from, 2, () => 0);
    assert.equal(early.getTime() - from.getTime(), 12 * 3600_000 * 0.8);
  });
  it("respects the weekly reel cap", () => {
    for (let i = 0; i < 50; i++) {
      const f = chooseFormat({ allowed: ["image", "reel"], reelsThisWeek: 3, reelsPerWeek: 3, recent: [] });
      assert.equal(f, "image");
    }
  });
  it("falls back when only reels are allowed but capped", () => {
    assert.equal(chooseFormat({ allowed: ["reel"], reelsThisWeek: 5, reelsPerWeek: 1, recent: [] }), "image");
  });
  it("avoids three of the same format in a row", () => {
    for (let i = 0; i < 50; i++) {
      const f = chooseFormat({ allowed: ["image", "carousel"], reelsThisWeek: 0, reelsPerWeek: 1, recent: ["image", "image"] });
      assert.equal(f, "carousel");
    }
  });
});

describe("instagram username", () => {
  it("normalises valid usernames", () => {
    assert.equal(normalizeInstagramUsername(" @Moon.Cat_1 "), "moon.cat_1");
    assert.equal(normalizeInstagramUsername("a".repeat(30)), "a".repeat(30));
  });
  it("rejects invalid ones", () => {
    assert.equal(normalizeInstagramUsername("moon cat"), null);
    assert.equal(normalizeInstagramUsername("a".repeat(31)), null);
    assert.equal(normalizeInstagramUsername(""), null);
    assert.equal(normalizeInstagramUsername("@"), null);
    assert.equal(normalizeInstagramUsername("bad name!"), null);
  });
});

describe("persona", () => {
  it("builds a brief from catalog keys and custom text", () => {
    const brief = personaBrief(
      { name: "Moon Cat", symbol: "MCAT", description: "A cat on the moon" },
      { personality: "deadpan", themes: ["space", "naps"], language: "Spanish" },
    );
    assert.match(brief, /Moon Cat \(\$MCAT\)/);
    assert.match(brief, /deadpan/i);
    assert.match(brief, /buy back \$MCAT and burn it/);
    assert.match(brief, /space, naps/);
    assert.match(brief, /Spanish/);
    assert.match(CONTENT_RULES, /Never give financial advice/);
  });
  it("keeps legacy personalities working", () => {
    assert.match(personaBrief({ name: "A", symbol: "A", description: "" }, { personality: "stoic" }), /Calm, measured/);
    assert.match(personaBrief({ name: "A", symbol: "A", description: "" }, { personality: "custom", personalityCustom: "A pirate" }), /A pirate/);
    for (const k of Object.keys(PERSONALITIES)) assert.ok(!(k in LEGACY_PERSONALITIES), `${k} clashes with a legacy key`);
  });
  it("defaults the visual style", () => {
    assert.match(visualStyleText({}), /3D render/);
    assert.equal(visualStyleText({ visualStyle: "custom", visualStyleCustom: "ukiyo-e woodblock" }), "ukiyo-e woodblock");
  });
});

describe("first post", () => {
  it("leads with a Reel when Reels are on", () => {
    assert.equal(firstPostFormat(["image", "carousel", "reel"], 3), "reel");
  });
  it("falls back to an image post when Reels are off or capped at zero", () => {
    assert.equal(firstPostFormat(["image", "carousel"], 3), "image");
    assert.equal(firstPostFormat(["image", "reel"], 0), "image");
    assert.equal(firstPostFormat(["carousel"], 0), "carousel");
  });
  it("supports up to 24 posts a day", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    assert.equal(nextPostAt(from, 12, () => 0.5).getTime() - from.getTime(), 2 * 3600_000);
    assert.equal(nextPostAt(from, 100, () => 0.5).getTime() - from.getTime(), 3600_000);
  });
});

describe("post variety", () => {
  it("avoids what recent posts used", () => {
    const recent = [
      { angle: POST_ANGLES[0], shot: CAMERA_SHOTS[0], lighting: LIGHTING[0], captionStyle: CAPTION_STYLES[0] },
      { angle: POST_ANGLES[1], shot: CAMERA_SHOTS[1], lighting: LIGHTING[1], captionStyle: CAPTION_STYLES[1] },
    ];
    for (let i = 0; i < 200; i++) {
      const v = pickVariety(recent);
      assert.ok(v.angle !== POST_ANGLES[0] && v.angle !== POST_ANGLES[1]);
      assert.ok(v.shot !== CAMERA_SHOTS[0] && v.shot !== CAMERA_SHOTS[1]);
      assert.ok(v.lighting !== LIGHTING[0] && v.lighting !== LIGHTING[1]);
      assert.ok(v.captionStyle !== CAPTION_STYLES[0] && v.captionStyle !== CAPTION_STYLES[1]);
    }
  });
  it("still picks something when everything was used recently", () => {
    const recent = CAMERA_SHOTS.map((shot) => ({ shot }));
    assert.ok(CAMERA_SHOTS.includes(pickVariety(recent).shot as (typeof CAMERA_SHOTS)[number]));
  });
  it("works for a coin's very first post", () => {
    const v = pickVariety([]);
    assert.ok(v.angle && v.shot && v.lighting && v.captionStyle);
  });
  it("takes the first words of a caption as its opener", () => {
    assert.equal(captionOpener("Friendship log, attempt #48! Today I mailed"), "Friendship log, attempt #48! Today");
    assert.equal(captionOpener(null), "");
  });
});

describe("emoji limit", () => {
  it("keeps only the first emoji", () => {
    assert.equal(limitEmojis("3... 2... 1... liftoff 🚀 🐶 woof 🌕"), "3... 2... 1... liftoff 🚀 woof");
  });
  it("counts joined and skin-tone emoji as one", () => {
    assert.equal(limitEmojis("hi 👩‍🚀 and 👍🏽 bye"), "hi 👩‍🚀 and bye");
  });
  it("can remove all emoji and tidies spacing", () => {
    assert.equal(limitEmojis("Ready 🚀 !", 0), "Ready!");
  });
  it("is applied when a caption is finalised", () => {
    assert.equal(finalizeCaption("gm 🚀🐶🌕", [], "AI persona."), "gm 🚀\n\nAI persona.");
  });
});

describe("posting frequency", () => {
  it("holds every coin to 12 to 24 posts a day", () => {
    assert.deepEqual(POSTS_PER_DAY, { min: 12, max: 24 });
  });
  it("schedules 12 a day as roughly every 2 hours", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const gap = nextPostAt(from, POSTS_PER_DAY.min, () => 0.5).getTime() - from.getTime();
    assert.equal(gap, 2 * 3600_000);
  });
});

describe("talking reels", () => {
  it("cleans spoken lines for the video model", () => {
    assert.equal(cleanSpokenLine('(laughs) "Okay, $BYTE is HUGE today" 🚀 #moon', 5), "okay, $BYTE is HUGE today");
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const cut = cleanSpokenLine(long, 5);
    assert.ok(cut.split(" ").length <= maxSpokenWords(5));
    assert.ok(cut.endsWith("…"));
    assert.equal(cleanSpokenLine("", 5), "");
  });
  it("puts the spoken line in quotes with voice and sound", () => {
    const p = reelVideoPrompt({ motion: "slow push in.", spokenLine: "hi friends", sound: "rain", voice: "warm", style: "3D render", audio: true });
    assert.match(p, /saying: "hi friends"/);
    assert.match(p, /Sound: rain/);
    assert.match(p, /Voice: .*warm/);
    const silent = reelVideoPrompt({ motion: "", spokenLine: "hi", sound: "rain", voice: "warm", style: "x", audio: false });
    assert.doesNotMatch(silent, /saying|Sound/);
  });
  it("builds the right request per model", () => {
    const k = videoInput("fal-ai/kling-video/v2.6/pro/image-to-video", "p", "u", 5, true);
    assert.equal(k.start_image_url, "u");
    assert.equal(k.generate_audio, true);
    assert.equal(k.duration, "5");
    const v = videoInput("fal-ai/veo3.1/image-to-video", "p", "u", 5, true);
    assert.equal(v.image_url, "u");
    assert.equal(v.duration, "6s");
    assert.equal(v.aspect_ratio, "9:16");
    const old = videoInput("fal-ai/kling-video/v2.1/standard/image-to-video", "p", "u", 5, true);
    assert.equal(old.generate_audio, undefined);
    assert.equal(supportsAudio("fal-ai/kling-video/v2.1/standard/image-to-video"), false);
    assert.equal(videoFamily("fal-ai/veo3/fast/image-to-video"), "veo3");
    assert.equal(clipSeconds("kling-audio", 12), 10);
  });
  it("describes a stable speaking voice", () => {
    assert.equal(speakingVoice("", ""), "");
    assert.match(speakingVoice("slow and smug", "Deadpan"), /personality: Deadpan; delivery: slow and smug/);
  });
});

describe("locked website", () => {
  it("points to the coin's Reelpad page", () => {
    assert.equal(coinPageUrl("https://reelpad.fun/", "Mint111"), "https://reelpad.fun/coin/Mint111");
  });
});
