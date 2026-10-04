import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

/**
 * The coin's price chart, drawn here as plain SVG from candles our own server provides.
 * No iframes or third-party scripts, so nothing outside Reelpad can stop the page loading.
 */

type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";
const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
interface ChartData {
  source: "geckoterminal" | "reelpad";
  currency: "USD" | "SOL";
  timeframe: Timeframe;
  candles: Candle[];
  updatedAt: string;
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";
/** Tiny prices like 0.000004123 read as 0.0₅4123, the way trading sites show them. */
export function fmtPrice(n: number, currency: "USD" | "SOL") {
  const sym = currency === "USD" ? "$" : "";
  const unit = currency === "SOL" ? " SOL" : "";
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `${sym}${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}${unit}`;
  if (n >= 1) return `${sym}${n.toFixed(2)}${unit}`;
  if (n >= 0.001) return `${sym}${n.toPrecision(4)}${unit}`;
  if (n === 0) return `${sym}0${unit}`;
  const zeros = Math.floor(-Math.log10(n)) - 1; // zeros right after the decimal point
  const digits = Math.round(n * 10 ** (zeros + 4)).toString().slice(0, 4);
  const sub = String(zeros).split("").map((d) => SUB[Number(d)]).join("");
  return `${sym}0.0${sub}${digits}${unit}`;
}

function fmtVol(n: number) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtTime(t: number, tf: Timeframe, withDate = false) {
  const d = new Date(t * 1000);
  if (tf === "1d") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return withDate || tf === "4h" ? `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}` : time;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const H = 440;
const PAD = { top: 16, right: 84, bottom: 28, left: 8 };
const VOL_H = 70;

function Candles({ data }: { data: ChartData }) {
  const [wrap, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { candles, currency, timeframe } = data;
  const showVol = data.source === "geckoterminal" && candles.some((c) => c.v > 0);

  const g = useMemo(() => {
    const plotW = W - PAD.left - PAD.right;
    const priceH = H - PAD.top - PAD.bottom - (showVol ? VOL_H + 8 : 0);
    let lo = Math.min(...candles.map((c) => c.l));
    let hi = Math.max(...candles.map((c) => c.h));
    if (hi === lo) {
      hi *= 1.05;
      lo *= 0.95;
    }
    const span = hi - lo;
    hi += span * 0.06;
    lo = Math.max(0, lo - span * 0.06);
    const step = plotW / Math.max(candles.length, 1);
    const x = (i: number) => PAD.left + step * i + step / 2;
    const y = (p: number) => PAD.top + ((hi - p) / (hi - lo)) * priceH;
    const vMax = Math.max(1, ...candles.map((c) => c.v));
    const volTop = PAD.top + priceH + 8;
    const vy = (v: number) => volTop + VOL_H - (v / vMax) * VOL_H;
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    const every = Math.max(1, Math.ceil(candles.length / Math.max(2, Math.floor(plotW / 110))));
    return { plotW, priceH, step, x, y, vy, volTop, ticks, every };
  }, [W, candles, showVol]);

  const last = candles[candles.length - 1]!;
  const h = hover !== null ? candles[hover] : null;
  const bodyW = Math.max(1, Math.min(14, g.step * 0.7));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((px - PAD.left) / g.step);
    setHover(i >= 0 && i < candles.length ? i : null);
  };

  return (
    <div className="pc-plot" ref={wrap}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`Price chart, ${timeframe} candles, last price ${fmtPrice(last.c, currency)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {g.ticks.map((p) => (
          <g key={p}>
            <line className="pc-grid" x1={PAD.left} x2={PAD.left + g.plotW} y1={g.y(p)} y2={g.y(p)} />
            <text className="pc-axis" x={PAD.left + g.plotW + 8} y={g.y(p) + 4}>
              {fmtPrice(p, currency)}
            </text>
          </g>
        ))}
        {candles.map((c, i) =>
          i % g.every === 0 && g.x(i) > 34 && g.x(i) < PAD.left + g.plotW - 30 ? (
            <text key={`t${c.t}`} className="pc-axis" x={g.x(i)} y={H - 8} textAnchor="middle">
              {fmtTime(c.t, timeframe)}
            </text>
          ) : null,
        )}
        {showVol &&
          candles.map((c, i) => (
            <rect
              key={`v${c.t}`}
              className={c.c >= c.o ? "pc-vol up" : "pc-vol down"}
              x={g.x(i) - bodyW / 2}
              y={g.vy(c.v)}
              width={bodyW}
              height={Math.max(0, g.volTop + VOL_H - g.vy(c.v))}
            />
          ))}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const top = g.y(Math.max(c.o, c.c));
          const bottom = g.y(Math.min(c.o, c.c));
          return (
            <g key={c.t} className={up ? "pc-c up" : "pc-c down"}>
              <line x1={g.x(i)} x2={g.x(i)} y1={g.y(c.h)} y2={g.y(c.l)} />
              <rect x={g.x(i) - bodyW / 2} y={top} width={bodyW} height={Math.max(1, bottom - top)} />
            </g>
          );
        })}
        {/* Last price marker */}
        <line className="pc-last" x1={PAD.left} x2={PAD.left + g.plotW} y1={g.y(last.c)} y2={g.y(last.c)} />
        <rect className={last.c >= last.o ? "pc-tag up" : "pc-tag down"} x={PAD.left + g.plotW + 2} y={g.y(last.c) - 10} width={PAD.right - 4} height={20} rx={4} />
        <text className="pc-tag-text" x={PAD.left + g.plotW + 8} y={g.y(last.c) + 4}>
          {fmtPrice(last.c, currency)}
        </text>
        {h && hover !== null && (
          <g className="pc-cross">
            <line x1={g.x(hover)} x2={g.x(hover)} y1={PAD.top} y2={H - PAD.bottom} />
          </g>
        )}
      </svg>
      {h && hover !== null && (
        <div className="pc-tip" style={{ left: `${Math.min(78, Math.max(2, ((g.x(hover) / W) * 100) - 10))}%` }}>
          <strong>{fmtTime(h.t, timeframe, true)}</strong>
          <span>O {fmtPrice(h.o, currency)}</span>
          <span>H {fmtPrice(h.h, currency)}</span>
          <span>L {fmtPrice(h.l, currency)}</span>
          <span>C {fmtPrice(h.c, currency)}</span>
          {showVol && <span>Vol {fmtVol(h.v)}</span>}
        </div>
      )}
    </div>
  );
}

export function PriceChart({ coinKey, symbol, mint }: { coinKey: string; symbol: string; mint: string }) {
  const [tf, setTf] = useState<Timeframe>("5m");
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const d = await api<ChartData>(`/coins/${coinKey}/chart?tf=${tf}`);
        if (!alive) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (alive && first) setError((e as Error).message);
      } finally {
        if (alive && first) setLoading(false);
      }
    };
    load(true);
    const id = setInterval(() => !document.hidden && load(false), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [coinKey, tf]);

  const candles = data?.candles ?? [];
  const first = candles[0];
  const last = candles[candles.length - 1];
  const change = first && last && first.o > 0 ? ((last.c - first.o) / first.o) * 100 : null;
  const rangeLabel = { "5m": "24h", "15m": "2d", "1h": "7d", "4h": "30d", "1d": "6mo" }[tf];

  return (
    <section className="pc">
      <div className="pc-head">
        <div className="pc-price">
          <small>${symbol} price</small>
          <strong>{last && data ? fmtPrice(last.c, data.currency) : "—"}</strong>
          {change !== null && (
            <span className={change >= 0 ? "pc-change up" : "pc-change down"}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(1)}% <small>{rangeLabel}</small>
            </span>
          )}
        </div>
        <div className="pc-tfs" role="group" aria-label="Candle size">
          {TIMEFRAMES.map((t) => (
            <button key={t} type="button" className={t === tf ? "chip on" : "chip"} aria-pressed={t === tf} onClick={() => setTf(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="pc-frame" aria-busy={loading}>
        {loading && !data ? (
          <div className="pc-empty">Loading chart…</div>
        ) : error && !data ? (
          <div className="pc-empty">Couldn't load the chart right now. It'll try again shortly.</div>
        ) : candles.length < 2 ? (
          <div className="pc-empty">Not enough trades yet to draw a chart. Check back after the first few trades.</div>
        ) : (
          <Candles data={data!} />
        )}
      </div>

      <div className="pc-foot">
        <span className="muted">
          {data?.source === "geckoterminal"
            ? "Prices in USD from GeckoTerminal. Updates every minute."
            : "Prices in SOL from the pump.fun bonding curve, recorded by Reelpad every 15 minutes, until chart sites list this coin."}
        </span>
        <span className="pc-links">
          <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">
            Trade on pump.fun
          </a>
          <a href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer">
            DexScreener
          </a>
        </span>
      </div>
    </section>
  );
}
