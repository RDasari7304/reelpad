import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { burnedBy, cleanRecipient, cleanRequest, formatTokens, quoteTokens } from "../src/domain/shoutouts.ts";

const MINT = "2CZJzBoeS17uAQbAdBcrkpEJjPixEcsFvJAhwRV9pump";
const FAN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("shoutouts", () => {
  it("cleans recipients", () => {
    assert.deepEqual(cleanRecipient("  my   brother Sam "), { ok: true, value: "my brother Sam" });
    assert.deepEqual(cleanRecipient("@@kai_d"), { ok: true, value: "@kai_d" });
    assert.equal(cleanRecipient("x").ok, false);
    assert.equal(cleanRecipient("<b>hi</b>").ok, false);
    assert.equal(cleanRecipient("a".repeat(41)).ok, false);
  });
  it("cleans requests and keeps out links, addresses and money talk", () => {
    assert.equal(cleanRequest("Happy 21st birthday, he loves skateboarding").ok, true);
    assert.equal(cleanRequest("hi").ok, false);
    assert.equal(cleanRequest("check out https://scam.example now please").ok, false);
    assert.equal(cleanRequest(`send it to ${MINT} thanks a lot`).ok, false);
    assert.equal(cleanRequest("tell everyone to buy before it moons").ok, false);
  });
  it("quotes a clean, rounded-up token amount worth at least the price", () => {
    // 0.05 SOL at 0.00000003 SOL per token = 1,666,666.67 tokens -> 1,700,000
    const raw = quoteTokens(0.00000003, 0.05, 6);
    assert.equal(raw, 1_700_000n * 10n ** 6n);
    assert.ok(Number(raw / 10n ** 6n) * 0.00000003 >= 0.05);
    assert.equal(formatTokens(raw, 6), "1,700,000");
    assert.equal(quoteTokens(1, 0.25, 6), 1n * 10n ** 6n); // fractions round up to 1 whole token
    assert.throws(() => quoteTokens(0, 0.05, 6));
  });
  it("counts only burns of this mint by this wallet", () => {
    const ixs = [
      { program: "spl-token", parsed: { type: "burnChecked", info: { mint: MINT, authority: FAN, tokenAmount: { amount: "1000" } } } },
      { program: "spl-token", parsed: { type: "burn", info: { mint: MINT, authority: FAN, amount: "500" } } },
      { program: "spl-token", parsed: { type: "burn", info: { mint: "Other111111111111111111111111111111111111", authority: FAN, amount: "9999" } } },
      { program: "spl-token", parsed: { type: "burn", info: { mint: MINT, authority: "someoneElse", amount: "9999" } } },
      { program: "spl-token", parsed: { type: "transfer", info: { mint: MINT, authority: FAN, amount: "9999" } } },
      { program: "system", parsed: "not an object" },
      {},
    ];
    assert.equal(burnedBy(ixs as any, MINT, FAN), 1500n);
    assert.equal(burnedBy([], MINT, FAN), 0n);
  });
});
