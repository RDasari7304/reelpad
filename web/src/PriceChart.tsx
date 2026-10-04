import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

/**
 * The coin's market-cap chart, drawn here as SVG from candles our own server provides, styled like a
 * trading terminal (DexScreener-style): dark panel, tight candles anchored to the right, volume along
 * the bottom, OHLC legend, crosshair, scroll to zoom and drag to pan. No iframes or third-party scripts.
 */

type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

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
  metric: "mcap";
  currency: "USD" | "SOL";
  supply: number;
  timeframe: Timeframe;
  candles: Candle[];
  updatedAt: string;
}

/** 626700 → "626.70K", 1234567 → "1.23M". */
export function fmtCap(n: number, currency: "USD" | "SOL" = "USD") {
  if (!Number.isFinite(n)) return "—";
  const pre = currency === "USD" ? "$" : "";
  const post = currency === "SOL" ? " SOL" : "";
  const a = Math.abs(n);
  const body =
    a >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toFixed(a >= 100 ? 0 : 2);
  return `${pre}${body}${post}`;
}
/** Axis labels without the currency sign, like trading charts. */
const axisCap = (n: number) => fmtCap(n, "USD").replace("$", "");

function fmtVol(n: number) {
  return fmtCap(n, "USD").replace("$", "");
}

function fmtTime(t: number, tf: Timeframe) {
  const d = new Date(t * 1000);
  if (tf === "1d") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (d.getHours() === 0 && d.getMinutes() === 0) return String(d.getDate());
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtFull(t: number) {
  const d = new Date(t * 1000);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

const H = 520;
const PAD = { top: 44, right: 78, bottom: 26, left: 0 };
const VOL_FRAC = 0.2;
const MIN_SLOT = 3;
const MAX_SLOT = 40;
const DEFAULT_SLOT = 9;

/** Picks round numbers for the value axis. */
function niceTicks(lo: number, hi: number, count = 6) {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

function Terminal({ data, symbol }: { data: ChartData; symbol: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(900);
  const [slot, setSlot] = useState(DEFAULT_SLOT);
  const [offset, setOffset] = useState(0); // candles hidden on the right (panning back in time)
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null);
  const drag = useRef<{ x: number; offset: number } | null>(null);
  const { candles, currency, timeframe } = data;
  const n = candles.length;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(([e]) => setW(Math.max(300, Math.floor(e!.contentRect.width)))) : null;
    ro?.observe(el);
    // Scroll to zoom (non-passive so the page doesn't scroll while zooming the chart).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setSlot((s) => Math.min(MAX_SLOT, Math.max(MIN_SLOT, s * (e.deltaY < 0 ? 1.12 : 1 / 1.12))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro?.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  // New timeframe: back to the latest candles.
  useEffect(() => setOffset(0), [timeframe]);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const visible = Math.max(5, Math.floor(plotW / slot));
  const off = Math.min(offset, Math.max(0, n - 5));
  const end = n - off; // exclusive
  const start = Math.max(0, end - visible);
  const view = candles.slice(start, end);

  const g = useMemo(() => {
    const priceH = plotH * (1 - VOL_FRAC);
    let lo = Math.min(...view.map((c) => c.l));
    let hi = Math.max(...view.map((c) => c.h));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (hi === lo) {
      hi *= 1.05;
      lo *= 0.95;
    }
    const span = hi - lo;
    hi += span * 0.08;
    lo = Math.max(0, lo - span * 0.08);
    // Candle i sits `end - i` slots from the right edge, so a young coin's few candles hug the right like DexScreener.
    const x = (i: number) => PAD.left + plotW - (end - i - 0.5) * slot;
    const y = (p: number) => PAD.top + ((hi - p) / (hi - lo)) * priceH;
    const vMax = Math.max(1, ...view.map((c) => c.v));
    const volBottom = PAD.top + plotH;
    const vh = (v: number) => (v / vMax) * plotH * VOL_FRAC * 0.9;
    const ticks = niceTicks(lo, hi);
    const every = Math.max(1, Math.round(90 / slot));
    const valueAt = (py: number) => hi - ((py - PAD.top) / priceH) * (hi - lo);
    return { priceH, x, y, vh, volBottom, ticks, every, valueAt };
  }, [view, plotH, plotW, slot, end]);

  const last = candles[n - 1]!;
  const shown = hover ? candles[hover.i]! : last;
  const prev = candles[(hover ? hover.i : n - 1) - 1];
  const chg = shown.c - (prev?.c ?? shown.o);
  const chgPct = (prev?.c ?? shown.o) > 0 ? (chg / (prev?.c ?? shown.o)) * 100 : 0;
  const up = chg >= 0;
  const body = Math.max(1, Math.min(slot * 0.72, 18));
  const showVol = view.some((c) => c.v > 0);

  const toLocal = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * W, py: ((e.clientY - r.top) / r.height) * H };
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const { px, py } = toLocal(e);
    if (drag.current) {
      const dx = px - drag.current.x;
      setOffset(Math.max(0, Math.min(n - 5, Math.round(drag.current.offset + dx / slot))));
      return;
    }
    const i = Math.round(end - 0.5 - (PAD.left + plotW - px) / slot);
    setHover(i >= start && i < end && px <= PAD.left + plotW ? { i, y: Math.min(Math.max(py, PAD.top), PAD.top + g.priceH) } : null);
  };

  const tag = (y: number, text: string, cls: string) => (
    <g className={cls}>
      <rect x={PAD.left + plotW + 1} y={y - 9} width={PAD.right - 2} height={18} rx={2} />
      <text x={PAD.left + plotW + 7} y={y + 4}>
        {text}
      </text>
    </g>
  );

  return (
    <div className="term-plot" ref={wrap}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`$${symbol} market cap chart, ${timeframe} candles, now ${fmtCap(last.c, currency)}`}
        onPointerMove={onMove}
        onPointerDown={(e) => {
          drag.current = { x: toLocal(e).px, offset: off };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => {
          drag.current = null;
          setHover(null);
        }}
        onDoubleClick={() => {
          setSlot(DEFAULT_SLOT);
          setOffset(0);
        }}
        style={{ cursor: drag.current ? "grabbing" : "crosshair" }}
      >
        <rect className="term-bg" x={0} y={0} width={W} height={H} />
        {/* Grid */}
        {g.ticks.map((v) => (
          <line key={`gy${v}`} className="term-grid" x1={PAD.left} x2={PAD.left + plotW} y1={g.y(v)} y2={g.y(v)} />
        ))}
        {view.map((c, k) =>
          (start + k) % (g.every * 2) === 0 ? (
            <line key={`gx${c.t}`} className="term-grid" x1={g.x(start + k)} x2={g.x(start + k)} y1={PAD.top - 20} y2={PAD.top + plotH} />
          ) : null,
        )}
        {/* Volume */}
        {showVol &&
          view.map((c, k) => (
            <rect
              key={`v${c.t}`}
              className={c.c >= c.o ? "term-vol up" : "term-vol down"}
              x={g.x(start + k) - body / 2}
              y={g.volBottom - g.vh(c.v)}
              width={body}
              height={g.vh(c.v)}
            />
          ))}
        {/* Candles */}
        {view.map((c, k) => {
          const i = start + k;
          const isUp = c.c >= c.o;
          const top = g.y(Math.max(c.o, c.c));
          const bot = g.y(Math.min(c.o, c.c));
          return (
            <g key={c.t} className={isUp ? "term-c up" : "term-c down"}>
              <line x1={g.x(i)} x2={g.x(i)} y1={g.y(c.h)} y2={g.y(c.l)} />
              <rect x={g.x(i) - body / 2} y={top} width={body} height={Math.max(1, bot - top)} />
            </g>
          );
        })}
        {/* Right axis */}
        <line className="term-axis-line" x1={PAD.left + plotW} x2={PAD.left + plotW} y1={0} y2={H} />
        {g.ticks.map((v) => (
          <text key={`ty${v}`} className="term-axis" x={PAD.left + plotW + 8} y={g.y(v) + 4}>
            {axisCap(v)}
          </text>
        ))}
        {/* Time axis */}
        <line className="term-axis-line" x1={0} x2={W} y1={PAD.top + plotH} y2={PAD.top + plotH} />
        {view.map((c, k) =>
          (start + k) % (g.every * 2) === 0 && g.x(start + k) > 24 && g.x(start + k) < PAD.left + plotW - 24 ? (
            <text key={`tx${c.t}`} className="term-axis" x={g.x(start + k)} y={H - 8} textAnchor="middle">
              {fmtTime(c.t, timeframe)}
            </text>
          ) : null,
        )}
        {/* Last value */}
        {off === 0 && <line className={up ? "term-last up" : "term-last down"} x1={PAD.left} x2={PAD.left + plotW} y1={g.y(last.c)} y2={g.y(last.c)} />}
        {off === 0 && tag(g.y(last.c), axisCap(last.c), last.c >= (candles[n - 2]?.c ?? last.o) ? "term-tag up" : "term-tag down")}
        {/* Crosshair */}
        {hover && (
          <g className="term-cross">
            <line x1={g.x(hover.i)} x2={g.x(hover.i)} y1={PAD.top - 20} y2={PAD.top + plotH} />
            <line x1={PAD.left} x2={PAD.left + plotW} y1={hover.y} y2={hover.y} />
            {tag(hover.y, axisCap(g.valueAt(hover.y)), "term-tag cross")}
            <g className="term-tag cross">
              <rect x={g.x(hover.i) - 52} y={PAD.top + plotH + 2} width={104} height={20} rx={2} />
              <text x={g.x(hover.i)} y={PAD.top + plotH + 16} textAnchor="middle">
                {fmtFull(candles[hover.i]!.t)}
              </text>
            </g>
          </g>
        )}
      </svg>
      {/* Legend, top-left like a trading terminal */}
      <div className="term-legend">
        <div>
          <strong>${symbol}</strong> <span className="term-dim">(Market Cap) · {timeframe} · {currency}</span>
          <span className={up ? "term-ohlc up" : "term-ohlc down"}>
            <span>O</span>
            {axisCap(shown.o)} <span>H</span>
            {axisCap(shown.h)} <span>L</span>
            {axisCap(shown.l)} <span>C</span>
            {axisCap(shown.c)} {up ? "+" : ""}
            {axisCap(chg)} ({up ? "+" : ""}
            {chgPct.toFixed(2)}%)
          </span>
        </div>
        {showVol && (
          <div className="term-dim">
            Volume <span className={up ? "term-ohlc up" : "term-ohlc down"}>{fmtVol(shown.v)}</span>
          </div>
        )}
      </div>
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
    const id = setInterval(() => !document.hidden && load(false), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [coinKey, tf]);

  const candles = data && data.timeframe === tf ? data.candles : [];
  const last = candles[candles.length - 1];
  const first = candles[0];
  const change = first && last && first.o > 0 ? ((last.c - first.o) / first.o) * 100 : null;

  return (
    <section className="pc">
      <div className="pc-head">
        <div className="pc-price">
          <small>${symbol} market cap</small>
          <strong>{last && data ? fmtCap(last.c, data.currency) : "—"}</strong>
          {change !== null && (
            <span className={change >= 0 ? "pc-change up" : "pc-change down"}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      <div className="term">
        <div className="term-bar" role="group" aria-label="Candle size">
          {TIMEFRAMES.map((t) => (
            <button key={t} type="button" className={t === tf ? "on" : ""} aria-pressed={t === tf} onClick={() => setTf(t)}>
              {t}
            </button>
          ))}
          <span className="term-bar-sep" />
          <span className="term-bar-label">
            Price / <b>Mcap</b>
          </span>
          <span className="term-bar-label">
            <b>{data?.currency ?? "USD"}</b>
          </span>
          <span className="term-bar-hint">Scroll to zoom · drag to pan · double-click to reset</span>
        </div>
        <div className="term-body" aria-busy={loading}>
          {loading && candles.length === 0 ? (
            <div className="term-empty">Loading chart…</div>
          ) : error && !data ? (
            <div className="term-empty">Couldn't load the chart right now. It'll try again shortly.</div>
          ) : candles.length === 0 ? (
            <div className="term-empty">No trades yet. The chart starts with the first trade.</div>
          ) : (
            <Terminal data={{ ...data!, candles }} symbol={symbol} />
          )}
        </div>
      </div>

      <div className="pc-foot">
        <span className="muted">
          {data?.source === "geckoterminal"
            ? "Market cap = price × supply. Prices from GeckoTerminal, updated every 30 seconds."
            : "Market cap from the pump.fun bonding curve, recorded by Reelpad, until chart sites list this coin."}
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
