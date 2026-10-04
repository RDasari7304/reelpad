/** Chart timeframes: candle size and how many candles to show. */
export const TIMEFRAMES = {
  "5m": { unit: "minute", aggregate: 5, limit: 288, seconds: 300 },
  "15m": { unit: "minute", aggregate: 15, limit: 192, seconds: 900 },
  "1h": { unit: "hour", aggregate: 1, limit: 168, seconds: 3600 },
  "4h": { unit: "hour", aggregate: 4, limit: 180, seconds: 14400 },
  "1d": { unit: "day", aggregate: 1, limit: 180, seconds: 86400 },
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;

export const isTimeframe = (v: unknown): v is Timeframe => typeof v === "string" && v in TIMEFRAMES;

export interface Candle {
  t: number; // unix seconds, candle open
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Parses GeckoTerminal's ohlcv_list ([t, o, h, l, c, v], newest first) into ascending candles, dropping bad rows. */
export function parseOhlcv(list: unknown): Candle[] {
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if (![t, o, h, l, c].every((x) => Number.isFinite(x) && x >= 0) || c === 0) continue;
    out.push({ t: t!, o: o!, h: Math.max(h!, o!, c!), l: Math.min(l!, o!, c!), c: c!, v: Number.isFinite(v) ? v! : 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Buckets point prices (e.g. our own snapshots) into candles of `seconds`. */
export function bucketCandles(points: Array<{ t: number; p: number }>, seconds: number): Candle[] {
  const map = new Map<number, Candle>();
  for (const { t, p } of [...points].sort((a, b) => a.t - b.t)) {
    if (!Number.isFinite(p) || p <= 0) continue;
    const k = Math.floor(t / seconds) * seconds;
    const c = map.get(k);
    if (!c) map.set(k, { t: k, o: p, h: p, l: p, c: p, v: 0 });
    else {
      c.h = Math.max(c.h, p);
      c.l = Math.min(c.l, p);
      c.c = p;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}
