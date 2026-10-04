import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { captionViolations, finalizeCaption } from "../src/domain/caption.ts";
import { defaultStrategyFor } from "../src/domain/catalog.ts";
import { CONTENT_RULES, personaBrief, visualStyleText } from "../src/domain/persona.ts";
import { normalizeInstagramUsername } from "../src/domain/instagram.ts";
import { chooseFormat, nextPostAt } from "../src/domain/schedule.ts";
import { decide, spendCap, type PolicyInput } from "../src/domain/treasuryPolicy.ts";
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

const base: PolicyInput = {
  strategy: "steady_buyback",
  user: { maxSolPerAction: 0.1, maxSolPerDay: 0.3, reserveSol: 0.05, dipPct: 15, intervalMin: 60 },
  platform: { maxSolPerAction: 0.5, maxSolPerDay: 2, gasReserveSol: 0.01, minIntervalMin: 15 },
  solBalance: 1,
  spentTodaySol: 0,
  minutesSinceLastBuy: null,
  priceNow: 1,
  priceHigh24h: 1,
};

describe("treasury policy", () => {
  it("never buys on hold", () => {
    assert.equal(decide({ ...base, strategy: "hold" }).action, "skip");
  });
  it("respects the per-action cap", () => {
    const d = decide(base);
    assert.equal(d.action, "buy");
    assert.ok(d.action === "buy" && d.sol <= 0.1);
  });
  it("applies the stricter of user and platform caps", () => {
    const d = decide({ ...base, user: { ...base.user, maxSolPerAction: 5, maxSolPerDay: 50 }, platform: { ...base.platform, maxSolPerAction: 0.02 } });
    assert.ok(d.action === "buy" && d.sol <= 0.02);
  });
  it("stops at the daily limit", () => {
    const d = decide({ ...base, spentTodaySol: 0.3 });
    assert.equal(d.action, "skip");
    assert.match(d.reason, /Daily limit/);
  });
  it("keeps the reserve and gas", () => {
    assert.equal(decide({ ...base, solBalance: 0.06 }).action, "skip");
    assert.equal(spendCap({ ...base, solBalance: 0.06 }), 0);
    const d = decide({ ...base, solBalance: 0.1 });
    assert.ok(d.action === "buy" && d.sol <= 0.1 - 0.05 - 0.01);
  });
  it("enforces the cooldown using the larger interval", () => {
    assert.equal(decide({ ...base, minutesSinceLastBuy: 30 }).action, "skip");
    assert.equal(decide({ ...base, minutesSinceLastBuy: 61 }).action, "buy");
    assert.equal(decide({ ...base, user: { ...base.user, intervalMin: 5 }, minutesSinceLastBuy: 10 }).action, "skip");
  });
  it("only buys dips past the threshold", () => {
    const dip = { ...base, strategy: "dip_buyback" as const };
    assert.equal(decide({ ...dip, priceNow: 0.9, priceHigh24h: 1 }).action, "skip");
    const d = decide({ ...dip, priceNow: 0.8, priceHigh24h: 1 });
    assert.equal(d.action, "buy");
    assert.equal(decide({ ...dip, priceNow: null }).action, "skip");
  });
  it("never exceeds what is spendable even with a big balance", () => {
    for (const bal of [0.07, 0.2, 5, 1000]) {
      const d = decide({ ...base, solBalance: bal });
      if (d.action === "buy") assert.ok(d.sol <= Math.min(0.1, bal - 0.06) + 1e-9);
    }
  });
  it("maps objectives to strategies", () => {
    assert.equal(defaultStrategyFor("buy_and_burn"), "buy_and_burn");
    assert.equal(defaultStrategyFor("deflation"), "buy_and_burn");
    assert.equal(defaultStrategyFor("buy_back_on_dips"), "dip_buyback");
    assert.equal(defaultStrategyFor("meme_engine"), "hold");
    assert.equal(defaultStrategyFor(null), "hold");
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
      { personality: "stoic", objective: "custom", objectiveCustom: "Collect moon rocks", themes: ["space", "naps"], language: "Spanish" },
    );
    assert.match(brief, /Moon Cat \(\$MCAT\)/);
    assert.match(brief, /Calm, measured/);
    assert.match(brief, /Collect moon rocks/);
    assert.match(brief, /space, naps/);
    assert.match(brief, /Spanish/);
    assert.match(CONTENT_RULES, /Never give financial advice/);
  });
  it("defaults the visual style", () => {
    assert.match(visualStyleText({}), /3D render/);
    assert.equal(visualStyleText({ visualStyle: "custom", visualStyleCustom: "ukiyo-e woodblock" }), "ukiyo-e woodblock");
  });
});
