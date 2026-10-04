import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { bucketCandles, parseOhlcv, TIMEFRAMES, type Candle, type Timeframe } from "../domain/chart.js";
import { logger } from "../lib/logger.js";
import { connection, getPriceSol, WSOL_MINT } from "./solana.js";

/**
 * Price candles for a coin. The server fetches them (cached) from GeckoTerminal's free public API,
 * so the browser never loads a third-party page or script. If GeckoTerminal hasn't indexed the coin
 * yet, it falls back to Reelpad's own price history, recorded from the pump.fun bonding curve.
 */
const GT = "https://api.geckoterminal.com/api/v2";
const HEADERS = { Accept: "application/json;version=20230302" };

const poolCache = new Map<string, { pool: string | null; at: number }>();
const chartCache = new Map<string, { at: number; value: ChartData }>();

export interface ChartData {
  source: "geckoterminal" | "reelpad";
  /** Candles are market cap (price × circulating supply), like DexScreener's "Mcap" view. */
  metric: "mcap";
  currency: "USD" | "SOL";
  supply: number;
  timeframe: Timeframe;
  candles: Candle[];
  updatedAt: string;
}

async function gt<T>(path: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${GT}${path}`, { headers: HEADERS, signal: ctrl.signal });
    if (!r.ok) {
      if (r.status !== 404) logger.warn({ path, status: r.status }, "geckoterminal request failed");
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    logger.warn({ path, err: (e as Error).message }, "geckoterminal request error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The coin's most liquid pool (pump.fun bonding curve before graduation, PumpSwap after). */
async function topPool(mint: string): Promise<string | null> {
  const hit = poolCache.get(mint);
  // Re-check every 10 minutes (a coin can graduate); retry sooner while it isn't indexed yet.
  if (hit && Date.now() - hit.at < (hit.pool ? 10 : 2) * 60_000) return hit.pool;
  const r = await gt<{ data?: Array<{ attributes?: { address?: string } }> }>(`/networks/solana/tokens/${mint}/pools?page=1`);
  const pool = r?.data?.[0]?.attributes?.address ?? null;
  poolCache.set(mint, { pool, at: Date.now() });
  return pool;
}

const supplyCache = new Map<string, { at: number; supply: number }>();
/** Current token supply (pump.fun coins start at 1 billion; burns lower it). */
async function tokenSupply(mint: string): Promise<number> {
  const hit = supplyCache.get(mint);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.supply;
  let supply = 1_000_000_000;
  try {
    const r = await connection.getTokenSupply(new PublicKey(mint), "confirmed");
    if (r.value.uiAmount && r.value.uiAmount > 0) supply = r.value.uiAmount;
  } catch (e) {
    logger.warn({ mint, err: (e as Error).message }, "token supply lookup failed");
  }
  supplyCache.set(mint, { at: Date.now(), supply });
  return supply;
}

let solUsdCache: { at: number; usd: number | null } | null = null;
async function solUsd(): Promise<number | null> {
  if (solUsdCache && Date.now() - solUsdCache.at < 60_000) return solUsdCache.usd;
  let usd: number | null = null;
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`);
    if (r.ok) usd = ((await r.json()) as Record<string, { usdPrice?: number }>)[WSOL_MINT]?.usdPrice ?? null;
  } catch {
    /* fall back to SOL */
  }
  solUsdCache = { at: Date.now(), usd };
  return usd;
}

const scale = (candles: Candle[], k: number): Candle[] =>
  candles.map((c) => ({ t: c.t, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k, v: c.v }));

async function fromGeckoTerminal(mint: string, tf: Timeframe): Promise<Candle[]> {
  const pool = await topPool(mint);
  if (!pool) return [];
  const f = TIMEFRAMES[tf];
  const r = await gt<{ data?: { attributes?: { ohlcv_list?: unknown } } }>(
    `/networks/solana/pools/${pool}/ohlcv/${f.unit}?aggregate=${f.aggregate}&limit=${f.limit}&currency=usd&token=${mint}`,
  );
  return parseOhlcv(r?.data?.attributes?.ohlcv_list);
}

async function fromSnapshots(coinId: string, mint: string, tf: Timeframe): Promise<Candle[]> {
  const f = TIMEFRAMES[tf];
  const rows = await query<{ ts: Date; price_sol: string }>(
    `SELECT ts, price_sol FROM price_snapshots WHERE coin_id = $1 AND ts > now() - ($2 || ' seconds')::interval ORDER BY ts`,
    [coinId, String(f.seconds * f.limit)],
  );
  const points = rows.rows.map((r) => ({ t: Math.floor(r.ts.getTime() / 1000), p: Number(r.price_sol) }));
  const live = await getPriceSol(new PublicKey(mint)).catch(() => null);
  if (live?.priceSol) points.push({ t: Math.floor(Date.now() / 1000), p: live.priceSol });
  return bucketCandles(points, f.seconds);
}

export async function getChart(coinId: string, mint: string, tf: Timeframe): Promise<ChartData> {
  const key = `${mint}:${tf}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < 45_000) return hit.value;

  let value: ChartData;
  const [gtCandles, supply] = await Promise.all([fromGeckoTerminal(mint, tf), tokenSupply(mint)]);
  const base = { metric: "mcap" as const, supply, timeframe: tf, updatedAt: new Date().toISOString() };
  if (gtCandles.length >= 1) {
    value = { ...base, source: "geckoterminal", currency: "USD", candles: scale(gtCandles, supply) };
  } else {
    const [own, usd] = await Promise.all([fromSnapshots(coinId, mint, tf), solUsd()]);
    value = usd
      ? { ...base, source: "reelpad", currency: "USD", candles: scale(own, supply * usd) }
      : { ...base, source: "reelpad", currency: "SOL", candles: scale(own, supply) };
  }
  chartCache.set(key, { at: Date.now(), value });
  if (chartCache.size > 2000) chartCache.delete(chartCache.keys().next().value!);
  return value;
}
