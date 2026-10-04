import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { captionViolations, finalizeCaption, limitEmojis } from "../src/domain/caption.ts";
import { CAMERA_SHOTS, CAPTION_STYLES, captionOpener, LIGHTING, pickVariety, POST_ANGLES } from "../src/domain/variety.ts";
import { LEGACY_PERSONALITIES, PERSONALITIES } from "../src/domain/catalog.ts";
import { CONTENT_RULES, personaBrief, visualStyleText } from "../src/domain/persona.ts";
import { normalizeInstagramUsername } from "../src/domain/instagram.ts";
import { POSTS_PER_DAY } from "../src/domain/limits.ts";
import { coinPageUrl, coinWebsite } from "../src/domain/links.ts";
import { applyTier, TIERS } from "../src/domain/tiers.ts";
import { imageInput, supportsMultiReference } from "../src/domain/images.ts";
import { athMilestone, graduationMilestone, mcapMilestone, recordBurnMilestone } from "../src/domain/milestones.ts";
import { pollWinner } from "../src/domain/polls.ts";
import { decideActivity, postsPerDayFor, priceMove, reelsAllowed, type ActivitySignals } from "../src/domain/activity.ts";
import { advance, beatLength, isStandalone, normalizeArc, publicArc, storyBrief, type Arc } from "../src/domain/story.ts";
import { cleanReaction, cleanReply, humanDelayMinutes, replyBudget, replyTargetId, replyViolations, selectForReply, spamReason, isLowEffort, worthPosting, type StoredComment } from "../src/domain/comments.ts";
import { buyAttempts, chunkAmounts, friendlyTradeError, isSlippageError } from "../src/domain/tradeErrors.ts";
import { bucketCandles, isTimeframe, parseOhlcv } from "../src/domain/chart.ts";
import { cleanLine, lineSeconds, pairKey, pickPair, timeLines } from "../src/domain/room.ts";
import { cleanSpokenLine, clipSeconds, maxSpokenWords, reelVideoPrompt, speakingVoice, supportsAudio, videoFamily, videoInput } from "../src/domain/reel.ts";
import { chooseFormat, firstPostFormat, nextPostAt } from "../src/domain/schedule.ts";
import { decideBuyback, spendable, splitBuyback, type BuybackInput } from "../src/domain/treasuryPolicy.ts";
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
  minutesSinceLastBuy: null,
  limits: { gasReserveSol: 0.01, minBuySol: 0.01, intervalMin: 60 },
};

describe("buyback-and-burn policy", () => {
  it("spends ALL collected fees above the gas reserve, with no per-buy or daily cap", () => {
    const d = decideBuyback(base);
    assert.ok(d.action === "buy" && Math.abs(d.sol - 0.49) < 1e-9);
    const big = decideBuyback({ ...base, solBalance: 6.6812 });
    assert.ok(big.action === "buy" && Math.abs(big.sol - 6.6712) < 1e-9);
    assert.equal(spendable({ ...base, solBalance: 0.005 }), 0);
  });
  it("waits until enough fees have collected", () => {
    const d = decideBuyback({ ...base, solBalance: 0.015 });
    assert.equal(d.action, "skip");
    assert.match(d.reason, /Collecting creator fees/);
  });
  it("respects the interval between buybacks", () => {
    assert.equal(decideBuyback({ ...base, minutesSinceLastBuy: 30 }).action, "skip");
    assert.equal(decideBuyback({ ...base, minutesSinceLastBuy: 61 }).action, "buy");
  });
  it("never buys with an empty treasury", () => {
    assert.equal(decideBuyback({ ...base, solBalance: 0 }).action, "skip");
  });
  it("splits 50/50 with the native coin and stays fair over time", () => {
    assert.deepEqual(splitBuyback({ total: 6, nativeShare: 0.5, spentOwnSol: 0, spentNativeSol: 0 }), { own: 3, native: 3 });
    // History skewed toward the coin itself: the native coin catches up.
    assert.deepEqual(splitBuyback({ total: 2, nativeShare: 0.5, spentOwnSol: 1, spentNativeSol: 0 }), { own: 0.5, native: 1.5 });
    // Dust folds into the other side.
    assert.deepEqual(splitBuyback({ total: 0.008, nativeShare: 0.5, spentOwnSol: 0, spentNativeSol: 0 }), { own: 0.008, native: 0 });
    assert.deepEqual(splitBuyback({ total: 1, nativeShare: 0, spentOwnSol: 0, spentNativeSol: 0 }), { own: 1, native: 0 });
    const s = splitBuyback({ total: 0.123457, nativeShare: 0.5, spentOwnSol: 0, spentNativeSol: 0 });
    assert.ok(Math.abs(s.own + s.native - 0.123457) < 1e-9);
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
    assert.match(brief, /buying back and burning \$MCAT/);
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

describe("price chart data", () => {
  it("parses GeckoTerminal candles oldest-first and drops bad rows", () => {
    const c = parseOhlcv([
      [200, 2, 3, 1, 2.5, 10],
      [100, 1, 2, 0.5, 2, 5],
      ["x", 1, 1, 1, 1, 1],
      [300, 1, 1, 1, 0, 1],
    ]);
    assert.deepEqual(c.map((x) => x.t), [100, 200]);
    assert.equal(c[1]!.c, 2.5);
    assert.deepEqual(parseOhlcv(null), []);
  });
  it("buckets snapshots into candles", () => {
    const c = bucketCandles([{ t: 10, p: 1 }, { t: 20, p: 3 }, { t: 299, p: 2 }, { t: 310, p: 5 }], 300);
    assert.equal(c.length, 2);
    assert.deepEqual(c[0], { t: 0, o: 1, h: 3, l: 1, c: 2, v: 0 });
    assert.equal(c[1]!.o, 5);
  });
  it("accepts only known timeframes", () => {
    assert.ok(isTimeframe("5m") && isTimeframe("1d"));
    assert.ok(!isTimeframe("2m") && !isTimeframe(undefined));
  });
});

describe("the Room", () => {
  it("times lines so they can be read", () => {
    const { lines, talkSec } = timeLines([
      { speaker: "a", text: "hey" },
      { speaker: "b", text: "Oh, it's you again. The goldfish guy.", action: "*sighs*" },
      { speaker: "b", text: "#tag   " },
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.at, 0);
    assert.ok(lines[1]!.at >= lines[0]!.dur);
    assert.equal(lines[1]!.action, "sighs");
    assert.ok(talkSec >= lines[1]!.at + lines[1]!.dur);
    assert.ok(lineSeconds("x") >= 2.4 && lineSeconds("x".repeat(500)) <= 10);
    assert.ok(cleanLine("a ".repeat(200)).length <= 180);
  });
  it("pairs free characters and avoids people who just met", () => {
    const now = Date.now();
    const met = new Map([[pairKey("a", "b"), now - 60_000]]);
    for (let i = 0; i < 20; i++) {
      const p = pickPair(["a", "b", "c"], met, new Set(), now)!;
      assert.notDeepEqual([...p].sort(), ["a", "b"]);
    }
    assert.equal(pickPair(["a", "b"], new Map(), new Set(["a"]), now), null);
  });
});

describe("token website", () => {
  it("points to the Instagram profile when there is one", () => {
    assert.equal(coinWebsite("https://reelpad.fun", "Mint1", "the_daytraderr"), "https://www.instagram.com/the_daytraderr/");
    assert.equal(coinWebsite("https://reelpad.fun", "Mint1", null), "https://reelpad.fun/coin/Mint1");
  });
});

describe("generation tiers", () => {
  const base = { ...TIERS.standard, GENERATION_TIER: "premium" as const, OTHER: 1 };
  it("premium switches every model", () => {
    const c = applyTier(base);
    assert.equal(c.FAL_IMAGE_MODEL, "fal-ai/nano-banana-pro/edit");
    assert.equal(c.FAL_REEL_MODEL, "fal-ai/veo3.1/fast/image-to-video");
    assert.equal(c.ANTHROPIC_MODEL, "claude-opus-5-5");
    assert.equal(c.QUALITY_CHECK, true);
    assert.equal(c.OTHER, 1);
  });
  it("custom keeps the environment's values", () => {
    const c = applyTier({ ...base, GENERATION_TIER: "custom" as const, FAL_IMAGE_MODEL: "x" });
    assert.equal(c.FAL_IMAGE_MODEL, "x");
  });
  it("builds the right image request per model", () => {
    const nb = imageInput("fal-ai/nano-banana-pro/edit", "p", "ref", "9:16");
    assert.deepEqual(nb.image_urls, ["ref"]);
    assert.equal(nb.resolution, "2K");
    const k = imageInput("fal-ai/flux-pro/kontext", "p", "ref", "1:1");
    assert.equal(k.image_url, "ref");
  });
  it("premium Reels are three 8-second 1080p shots; cinema uses full Veo 3.1", () => {
    assert.equal(clipSeconds(videoFamily(TIERS.premium.FAL_REEL_MODEL), TIERS.premium.REEL_SECONDS), 8);
    assert.equal(TIERS.premium.REEL_SHOTS, 3);
    assert.equal(TIERS.premium.REEL_RESOLUTION, "1080p");
    assert.equal(TIERS.cinema.FAL_REEL_MODEL, "fal-ai/veo3.1/image-to-video");
    assert.equal(applyTier({ ...base, GENERATION_TIER: "cinema" as const }).COST_REEL_USD, 3.2);
  });
});

describe("buyback errors", () => {
  const raw = 'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1774. Logs: [ "Program log: ..." ]';
  it("recognises PumpSwap slippage and explains it", () => {
    assert.ok(isSlippageError(raw));
    assert.match(friendlyTradeError(raw), /slippage/);
    assert.ok(!friendlyTradeError(raw).includes("Logs"));
  });
  it("retries with more room, then smaller pieces", () => {
    const a = buyAttempts(0.5, 15);
    assert.deepEqual(a.map((x) => x.sol), [0.5, 0.5, 0.25, 0.125]);
    assert.equal(a[1]!.slippage, 30);
    assert.equal(buyAttempts(0.012, 15).length, 3);
  });
});

describe("comment replies", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const mk = (p: Partial<StoredComment> & { id: string }): StoredComment => ({
    parentId: null, mediaId: "m1", username: "fan", text: "this one made my day honestly", timestamp: new Date(now.getTime() - 60 * 60_000),
    likeCount: 0, isOwn: false, status: "new", ...p,
  });

  it("spots spam and scams for free", () => {
    assert.ok(spamReason("dm me for promo"));
    assert.ok(spamReason("claim your free sol airdrop now"));
    assert.ok(spamReason("check www.scam.xyz"));
    assert.ok(spamReason("send to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"));
    assert.equal(spamReason("this goldfish has more conviction than me 😂"), null);
    assert.equal(spamReason("🔥🔥🔥"), null);
  });

  it("cleans replies: no links, hashtags or extra tags, one emoji, mention when in a thread", () => {
    const r = cleanReply('"@fan haha yes 😂😂 #moon visit https://x.com and ask @other"', { username: "fan", mention: true });
    assert.equal(r.startsWith("@fan "), true);
    assert.ok(!r.includes("#moon") && !r.includes("https") && !r.includes("@other"));
    assert.equal((r.match(/😂/g) ?? []).length, 1);
    assert.equal(cleanReply("hey there", { username: "fan", mention: false }), "hey there");
    assert.ok(cleanReply("a ".repeat(400), { username: "fan", mention: false }).length <= 300);
    assert.equal(cleanReaction("🔥 nice"), "🔥");
    assert.equal(cleanReaction("lol"), "❤️");
  });

  it("blocks unsafe replies", () => {
    assert.ok(replyViolations("buy now before it moons").length > 0);
    assert.ok(replyViolations("DM me and I'll explain").length > 0);
    assert.ok(replyViolations("as an AI language model I can't").length > 0);
    assert.ok(replyViolations("price will 10x soon").length > 0);
    assert.deepEqual(replyViolations("the goldfish says hi back"), []);
  });

  it("answers top-level comments and talk-backs, not fan-to-fan chatter", () => {
    const all = [
      mk({ id: "c1", text: "what do you trade?" }),
      mk({ id: "c2", username: "b", text: "how long have you been trading?", likeCount: 10 }),
      mk({ id: "r1", parentId: "c2", username: "c", text: "agreed" }), // fan to fan, influencer not in thread
      mk({ id: "c3", username: "d", text: "hi" }),
      mk({ id: "o1", parentId: "c3", username: "me", isOwn: true, status: "own", text: "hey d", timestamp: new Date(now.getTime() - 50 * 60_000) }),
      mk({ id: "r2", parentId: "c3", username: "d", text: "you replied!", timestamp: new Date(now.getTime() - 40 * 60_000) }),
      mk({ id: "c4", username: "e", text: "too fresh", timestamp: new Date(now.getTime() - 60_000) }),
      mk({ id: "c5", username: "f", text: "old", timestamp: new Date(now.getTime() - 80 * 3600_000) }),
    ];
    const s = selectForReply(all, now, { batch: 10, repliedTodayByUser: new Map() });
    const ids = s.reply.map((c) => c.id);
    assert.equal(ids[0], "r2"); // conversation first
    assert.ok(ids.includes("c1") && ids.includes("c2"));
    assert.ok(!ids.includes("r1") && !ids.includes("c4") && !ids.includes("c3"));
    assert.ok(s.skip.some((x) => x.comment.id === "c5"));
    assert.ok(s.skip.some((x) => x.comment.id === "c3")); // already answered
  });

  it("caps replies per person and per hour/day", () => {
    const all = [mk({ id: "a1", username: "x" }), mk({ id: "a2", username: "x" }), mk({ id: "a3", username: "x" }), mk({ id: "a4", username: "x" })];
    const s = selectForReply(all, now, { batch: 10, repliedTodayByUser: new Map([["x", 1]]) });
    assert.equal(s.reply.length, 2);
    assert.equal(replyBudget({ hour: 3, day: 10 }, { perHour: 12, perDay: 40 }), 9);
    assert.equal(replyBudget({ hour: 0, day: 40 }, { perHour: 12, perDay: 40 }), 0);
  });

  it("replies inside the top-level thread and waits a human-ish delay", () => {
    assert.equal(replyTargetId({ id: "r", parentId: "c" }), "c");
    assert.equal(replyTargetId({ id: "c", parentId: null }), "c");
    const d = humanDelayMinutes("17890000000000001");
    assert.ok(d >= 2 && d <= 12);
  });
});

describe("selective replies", () => {
  it("skips low-effort comments for free", () => {
    for (const t of ["🔥🔥🔥", "lfg", "gm", "nice", "first!", "LOVE THIS 😍", "w"]) assert.ok(isLowEffort(t), t);
    for (const t of ["is the goldfish ok?", "what happens if the simulation patches you out", "your last reel made me laugh so hard"]) {
      assert.ok(!isLowEffort(t), t);
    }
  });
  it("only posts interesting ones", () => {
    assert.equal(worthPosting({ action: "reply", interest: 8 }, false), true);
    assert.equal(worthPosting({ action: "reply", interest: 6 }, false), false);
    assert.equal(worthPosting({ action: "reply", interest: 5 }, true), true);
    assert.equal(worthPosting({ action: "skip", interest: 10 }, false), false);
  });
});

describe("coin activity tiers", () => {
  const sig = (p: Partial<ActivitySignals>): ActivitySignals => ({
    ageHours: 200, volume24hUsd: 0, mcapUsd: 5000, fees24hSol: 0, priceMove24h: 0, hoursSinceActive: 100, ...p,
  });
  it("gives new coins a grace period", () => assert.equal(decideActivity(sig({ ageHours: 10 })), "active"));
  it("keeps traded coins active", () => {
    assert.equal(decideActivity(sig({ volume24hUsd: 5000 })), "active");
    assert.equal(decideActivity(sig({ fees24hSol: 0.05 })), "active");
  });
  it("cools a coin with a trickle of trading", () => assert.equal(decideActivity(sig({ volume24hUsd: 300, hoursSinceActive: 200 })), "cooling"));
  it("puts a coin with no trading for 3 days to sleep", () => assert.equal(decideActivity(sig({})), "dormant"));
  it("doesn't sleep a coin that was active recently", () => assert.equal(decideActivity(sig({ hoursSinceActive: 10 })), "cooling"));
  it("uses bonding-curve price moves when chart sites don't know the coin", () => {
    assert.equal(decideActivity(sig({ volume24hUsd: null, priceMove24h: 0.3 })), "active");
  });
  it("posting and Reels follow the state", () => {
    assert.equal(postsPerDayFor("active", 18), 18);
    assert.equal(postsPerDayFor("cooling", 18), 3);
    assert.equal(postsPerDayFor("dormant", 18), 0);
    assert.equal(reelsAllowed("cooling"), false);
    assert.ok(Math.abs(priceMove([1, 1.2, 0.8]) - 0.5) < 1e-9);
  });
});

describe("storylines", () => {
  const beats = [1, 2, 3, 4].map((i) => ({ title: `E${i}`, summary: `s${i}` }));
  const arc: Arc = { id: "arc-1", title: "The Great Escape", premise: "p", beats, currentBeat: 0, postsInBeat: 0, status: "active" };
  it("plays each episode over 2-3 posts, then moves on, then finishes", () => {
    let a = arc;
    let posts = 0;
    while (a.status === "active" && posts < 50) {
      a = advance(a, { recap: `post ${posts}`, beatComplete: false });
      posts++;
    }
    assert.equal(a.status, "done");
    assert.ok(posts >= 8 && posts <= 12, String(posts));
    assert.ok(a.beats.every((b) => b.recap));
  });
  it("lets a post close an episode early", () => {
    const a = advance(arc, { recap: "x", beatComplete: true });
    assert.equal(a.currentBeat, 1);
    assert.equal(a.postsInBeat, 0);
  });
  it("mixes in standalone moments", () => {
    assert.equal(isStandalone(3, "schedule"), true);
    assert.equal(isStandalone(4, "schedule"), false);
    assert.equal(isStandalone(3, "first"), false);
    assert.equal(isStandalone(0, "treasury"), true);
    assert.ok([2, 3].includes(beatLength("arc-1", 0)));
  });
  it("rejects thin plans and keeps future episodes secret", () => {
    assert.equal(normalizeArc({ title: "t", premise: "p", beats: beats.slice(0, 2) }), null);
    assert.ok(normalizeArc({ title: "t", premise: "p", beats }));
    const pub = publicArc(advance(arc, { recap: "x", beatComplete: true }));
    assert.equal(pub.happened.length, 1);
    assert.match(storyBrief(arc), /OPENS the story/);
    assert.match(storyBrief({ ...arc, currentBeat: 3, postsInBeat: 2 }), /FINALE/);
  });
});

describe("large buybacks", () => {
  it("go out in even pieces of at most 1 SOL", () => {
    const p = chunkAmounts(3.5856, 1);
    assert.equal(p.length, 4);
    assert.ok(p.every((x) => x <= 1));
    assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 3.5856) < 1e-6);
    assert.deepEqual(chunkAmounts(0.4, 1), [0.4]);
    assert.deepEqual(chunkAmounts(0, 1), []);
  });
  it("recognise Jupiter's slippage error", () => {
    assert.ok(isSlippageError('Transaction failed: {"InstructionError":[6,{"Custom":6001}]}'));
    assert.match(friendlyTradeError('Transaction failed: {"InstructionError":[6,{"Custom":6001}]}'), /no SOL was spent/);
  });
});

describe("milestones", () => {
  it("graduation fires once, on the switch", () => {
    assert.ok(graduationMilestone(false, true));
    assert.equal(graduationMilestone(true, true), null);
    assert.equal(graduationMilestone(false, false), null);
  });
  it("market cap celebrates only the highest new level", () => {
    const m = mcapMilestone(320_000, new Set(["50000"]));
    assert.equal(m?.key, "250000");
    assert.match(m!.note, /\$250K/);
    assert.equal(mcapMilestone(320_000, new Set(["50000", "100000", "250000"])), null);
    assert.equal(mcapMilestone(null, new Set()), null);
  });
  it("all-time highs need a real jump on a coin older than 6 hours, once a day", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    assert.equal(athMilestone({ priceSol: 1.3, prevHighSol: 1, ageHours: 24, now })?.key, "2026-10-04");
    assert.equal(athMilestone({ priceSol: 1.1, prevHighSol: 1, ageHours: 24, now }), null);
    assert.equal(athMilestone({ priceSol: 3, prevHighSol: 1, ageHours: 2, now }), null);
  });
  it("record burns start from the third burn", () => {
    assert.ok(recordBurnMilestone(2_000_000, 1_000_000, 2, "AIDEN"));
    assert.equal(recordBurnMilestone(2_000_000, 1_000_000, 1, "AIDEN"), null);
    assert.equal(recordBurnMilestone(1_050_000, 1_000_000, 5, "AIDEN"), null);
  });
  it("milestone notes forbid price talk", () => {
    assert.match(graduationMilestone(false, true)!.note, /Never predict the price/);
  });
});

describe("story polls", () => {
  it("most votes wins, ties go to the first option, no votes no winner", () => {
    assert.equal(pollWinner(3, [{ option: 1, n: 4 }, { option: 2, n: 2 }]), 1);
    assert.equal(pollWinner(3, [{ option: 0, n: 2 }, { option: 2, n: 2 }]), 0);
    assert.equal(pollWinner(3, []), null);
  });
});

describe("collab images", () => {
  it("send both characters to multi-reference models only", () => {
    const nb = imageInput("fal-ai/nano-banana-pro/edit", "p", ["me", "friend"], "1:1");
    assert.deepEqual(nb.image_urls, ["me", "friend"]);
    assert.match(String(nb.prompt), /second is their friend/);
    assert.equal(supportsMultiReference("fal-ai/flux-pro/kontext"), false);
    assert.equal(imageInput("fal-ai/flux-pro/kontext", "p", ["me", "friend"], "1:1").image_url, "me");
  });
});
