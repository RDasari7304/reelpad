/**
 * Caption safety and formatting. Pure, unit-tested.
 * The influencer must never promise returns or tell people to buy: that is a legal and platform-policy risk.
 */
const BANNED: Array<[RegExp, string]> = [
  [/guarantee(d|s)?\b.{0,30}\b(return|profit|gain|moon|x)/i, "promises returns"],
  [/\brisk[\s-]?free\b/i, "claims it is risk-free"],
  [/\b(will|going to|gonna)\s+(\d+x|moon|pump|explode|skyrocket|go up)/i, "predicts price"],
  [/\b\d{2,}x\b/i, "multiplier hype"],
  [/\b(buy|ape|load up)\s+(now|today|before)/i, "tells people to buy"],
  [/\b(this is|consider this|take this as)\s+(financial|investment) advice\b/i, "frames itself as financial advice"],
  [/\b(passive income|get rich)\b/i, "income claims"],
];

export function captionViolations(text: string): string[] {
  return BANNED.filter(([re]) => re.test(text)).map(([, label]) => label);
}

const IG_CAPTION_MAX = 2200;
const IG_HASHTAG_MAX = 30;

export function finalizeCaption(body: string, hashtags: string[], footer: string): string {
  const cleanBody = body.replace(/\s+$/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const existing = new Set((cleanBody.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.toLowerCase()));
  const extra: string[] = [];
  for (const raw of hashtags) {
    const tag = "#" + raw.replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (tag.length < 2 || existing.has(tag.toLowerCase())) continue;
    existing.add(tag.toLowerCase());
    extra.push(tag);
  }
  let tags = extra.slice(0, Math.max(0, IG_HASHTAG_MAX - (existing.size - extra.length)));
  const parts = () => [cleanBody, tags.join(" "), footer.trim()].filter(Boolean).join("\n\n");
  let out = parts();
  while (out.length > IG_CAPTION_MAX && tags.length) {
    tags = tags.slice(0, -1);
    out = parts();
  }
  if (out.length > IG_CAPTION_MAX) {
    const tail = footer.trim() ? "\n\n" + footer.trim() : "";
    out = cleanBody.slice(0, IG_CAPTION_MAX - tail.length - 1).trimEnd() + "…" + tail;
  }
  return out;
}
