/**
 * Posting cadence and format selection. Pure, unit-tested.
 */
export type Format = "image" | "carousel" | "reel";

/** Next post time: evenly spaced through the day with ±20% jitter so posts don't look robotic. */
export function nextPostAt(from: Date, postsPerDay: number, rand: () => number = Math.random): Date {
  const per = Math.max(1, Math.min(postsPerDay, 6));
  const intervalMs = (24 * 60 * 60 * 1000) / per;
  const jitter = (rand() * 0.4 - 0.2) * intervalMs;
  return new Date(from.getTime() + intervalMs + jitter);
}

const WEIGHTS: Record<Format, number> = { image: 5, carousel: 3, reel: 3 };

export function chooseFormat(opts: {
  allowed: Format[];
  reelsThisWeek: number;
  reelsPerWeek: number;
  recent: Format[]; // most recent first
  rand?: () => number;
}): Format {
  const rand = opts.rand ?? Math.random;
  let pool = opts.allowed.filter((f) => f !== "reel" || opts.reelsThisWeek < opts.reelsPerWeek);
  if (pool.length === 0) pool = opts.allowed.filter((f) => f !== "reel");
  if (pool.length === 0) pool = ["image"];

  // Avoid three of the same format in a row when there is a choice.
  if (pool.length > 1 && opts.recent.length >= 2 && opts.recent[0] === opts.recent[1]) {
    const without = pool.filter((f) => f !== opts.recent[0]);
    if (without.length) pool = without;
  }
  const total = pool.reduce((s, f) => s + WEIGHTS[f], 0);
  let r = rand() * total;
  for (const f of pool) {
    r -= WEIGHTS[f];
    if (r < 0) return f;
  }
  return pool[pool.length - 1]!;
}
