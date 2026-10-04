/**
 * DexScreener's chart, embedded. The iframe is sandboxed without top-navigation rights, so nothing
 * inside it can redirect or take over the Reelpad page; it only runs inside its own box.
 */
export function DexScreenerChart({ mint, symbol }: { mint: string; symbol: string }) {
  const params = new URLSearchParams({
    embed: "1",
    loadChartSettings: "0",
    chartLeftToolbar: "0",
    chartTheme: "dark",
    theme: "dark",
    chartStyle: "1",
    chartType: "marketCap",
    interval: "5",
    trades: "0",
    tabs: "0",
    info: "0",
  });
  return (
    <section className="dex-embed">
      <div className="dex-frame">
        <iframe
          src={`https://dexscreener.com/solana/${mint}?${params}`}
          title={`$${symbol} chart on DexScreener`}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
      <div className="pc-foot">
        <span className="muted">Chart by DexScreener.</span>
        <span className="pc-links">
          <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">
            Trade on pump.fun
          </a>
          <a href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer">
            Open on DexScreener
          </a>
        </span>
      </div>
    </section>
  );
}
