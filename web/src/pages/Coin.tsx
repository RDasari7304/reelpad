import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type Coin, type ContentSettings, type Post, type TreasuryView } from "../api";
import { Address, NextPostCountdown, Notice } from "../components";
import { ContentEditor, PersonaSummary } from "../editors";
import { ErrorBoundary } from "../ErrorBoundary";
import { InstagramConnect } from "../InstagramConnect";
import { DexScreenerChart } from "../DexScreenerChart";
import { PriceChart } from "../PriceChart";
import { useSession } from "../session";

type Tab = "chart" | "posts" | "treasury" | "settings";

const STATUS_LABEL: Record<string, string> = {
  generating: "Making it",
  awaiting_approval: "Waiting for your approval",
  ready: "Queued to post",
  publishing: "Posting",
  published: "Posted",
  failed: "Failed",
  rejected: "Rejected",
  planned: "Planned",
};

/** Statuses where the post is still being made or posted; shown as a loading card. */
const IN_PROGRESS = new Set(["planned", "generating", "ready", "publishing"]);

const FORMAT_LABEL: Record<Post["format"], string> = { image: "Image post", carousel: "Carousel", reel: "Reel" };

function sinceLabel(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return min < 1 ? "started just now" : `started ${min} min ago`;
}

/** A post-shaped card with a live progress bar while the post is being made. Turns into the finished post at 100%. */
function MakingTile({ post }: { post: Post }) {
  const pct = Math.max(2, Math.min(99, post.progress || 0));
  const cover = post.media.find((m) => m.role === "cover") ?? post.media.find((m) => m.type === "image");
  return (
    <article className="post post-making" aria-live="polite">
      <div className="post-media making-media" style={cover ? { backgroundImage: `url(${cover.url})` } : undefined}>
        <div className="making-overlay">
          <span className="making-pct">{pct}%</span>
          <span className="making-format">{FORMAT_LABEL[post.format]}</span>
        </div>
      </div>
      <div className="post-body">
        <div
          className="making-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`${FORMAT_LABEL[post.format]} ${pct}% done`}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="making-stage">{post.stage ?? "Getting started"}</p>
        {post.concept && <p className="post-caption making-concept">{post.concept}</p>}
        <small className="muted">{sinceLabel(post.created_at)}</small>
      </div>
    </article>
  );
}

function PostTile({ post, owner, onChange }: { post: Post; owner: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(post.caption ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const video = post.media.find((m) => m.type === "video");
  const cover = post.media.find((m) => m.role === "cover") ?? post.media.find((m) => m.type === "image");

  const act = async (path: string, init?: Parameters<typeof api>[1]) => {
    setBusy(true);
    setErr(null);
    try {
      await api(path, { method: "POST", ...init });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`post post-${post.status}`}>
      <div className="post-media">
        {video ? (
          <video src={video.url} poster={cover?.url} controls playsInline preload="none" />
        ) : cover ? (
          <img src={cover.url} alt={post.concept ?? ""} loading="lazy" />
        ) : (
          <div className="post-placeholder">{post.status === "failed" ? "No media" : "Generating…"}</div>
        )}
        {post.format !== "image" && <span className="post-format">{post.format === "reel" ? "Reel" : `${post.media.length} images`}</span>}
      </div>
      <div className="post-body">
        {owner && <span className={`status status-${post.status}`}>{STATUS_LABEL[post.status] ?? post.status}</span>}
        {editing ? (
          <textarea className="input" rows={6} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} />
        ) : (
          <p className="post-caption">{post.caption ?? post.concept}</p>
        )}
        {post.error && owner && <p className="field-error">{post.error}</p>}
        {err && <p className="field-error">{err}</p>}
        <div className="post-actions">
          {post.permalink && (
            <a href={post.permalink} target="_blank" rel="noreferrer">
              View on Instagram
            </a>
          )}
          {owner && post.status === "awaiting_approval" && (
            <>
              {editing ? (
                <button
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() =>
                    act(`/posts/${post.id}`, { method: "PATCH", json: { caption } }).then(() => setEditing(false))
                  }
                >
                  Save caption
                </button>
              ) : (
                <button className="btn btn-small btn-quiet" onClick={() => setEditing(true)}>
                  Edit caption
                </button>
              )}
              <button className="btn btn-small btn-primary" disabled={busy || editing} onClick={() => act(`/posts/${post.id}/approve`)}>
                Approve and post
              </button>
              <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => act(`/posts/${post.id}/reject`)}>
                Reject
              </button>
            </>
          )}
          {owner && post.status === "failed" && (
            <button className="btn btn-small" disabled={busy} onClick={() => act(`/posts/${post.id}/retry`)}>
              Retry
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function PriceLine({ prices }: { prices: TreasuryView["prices"] }) {
  if (prices.length < 2) return <p className="muted">Price history appears after the first few treasury checks.</p>;
  const w = 600;
  const h = 120;
  const ps = prices.map((p) => p.p);
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  const pts = ps.map((p, i) => `${(i / (ps.length - 1)) * w},${h - ((p - min) / (max - min || 1)) * (h - 8) - 4}`).join(" ");
  return (
    <figure className="priceline">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Price over the last 7 days">
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption>Price in SOL, last 7 days</figcaption>
    </figure>
  );
}

function TreasuryTab({ coin }: { coin: Coin }) {
  const [t, setT] = useState<TreasuryView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<TreasuryView>(`/coins/${coin.id}/treasury`).then(setT).catch((e) => setErr(e.message));
  }, [coin.id]);
  if (err) return <Notice tone="error">{err}</Notice>;
  if (!t) return <div aria-busy="true" className="loading-block" />;
  return (
    <div className="treasury">
      <p className="treasury-lede">
        This treasury automatically uses ${coin.symbol}'s creator fees to buy the coin back and burn it.
        {t.paused && " Buybacks are paused by the site admin right now."}
      </p>
      <dl className="treasury-figures">
        <div>
          <dt>${coin.symbol} burned</dt>
          <dd>{Math.round(t.totals.tokensBurned).toLocaleString()}</dd>
        </div>
        <div>
          <dt>SOL spent on buybacks</dt>
          <dd>{t.totals.boughtBackSol.toFixed(4)}</dd>
        </div>
        <div>
          <dt>Creator fees collected</dt>
          <dd>{t.totals.feesCollectedSol.toFixed(4)} SOL</dd>
        </div>
        <div>
          <dt>Waiting to buy back</dt>
          <dd>{t.solBalance !== null ? `${Math.max(0, t.solBalance - t.rules.gasReserveSol).toFixed(4)} SOL` : "—"}</dd>
        </div>
        <div>
          <dt>Agent wallet</dt>
          <dd>
            <Address value={t.agentWallet} href={`https://solscan.io/account/${t.agentWallet}`} />
          </dd>
        </div>
      </dl>
      <p className="sub-hint">
        Buys back once at least {t.rules.minBuySol} SOL in fees has collected, at most every {t.rules.buyIntervalMin} minutes,
        up to {t.rules.maxSolPerBuy} SOL per buyback and {t.rules.maxSolPerDay} SOL a day. Everything bought is burned.
      </p>
      {t.dryRun && <Notice tone="warn">Simulation mode: buybacks and burns below are logged but were not sent on-chain.</Notice>}
      <PriceLine prices={t.prices} />
      <h3 className="sub">Activity</h3>
      {t.actions.length === 0 ? (
        <p className="muted">No activity yet. Creator fees start collecting once the coin trades.</p>
      ) : (
        <ul className="ledger">
          {t.actions.map((a, i) => (
            <li key={i} className={`ledger-${a.status}`}>
              <time dateTime={a.created_at}>{new Date(a.created_at).toLocaleString()}</time>
              <span className="ledger-kind">
                {a.kind === "claim_fees" ? "Collected creator fees" : a.kind === "buy" ? "Bought back" : a.kind === "burn" ? "Burned" : a.kind}
                {a.sol_amount && ` · ${Number(a.sol_amount).toFixed(4)} SOL`}
                {a.token_amount && ` · ${Math.round(Number(a.token_amount)).toLocaleString()} ${coin.symbol}`}
                {a.status === "simulated" && " · simulated"}
                {a.status === "failed" && " · failed"}
              </span>
              <span className="ledger-reason">{a.reason}</span>
              {a.tx_sig && (
                <a href={`https://solscan.io/tx/${a.tx_sig}`} target="_blank" rel="noreferrer">
                  Transaction
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SettingsTab({ coin, onSaved }: { coin: Coin; onSaved: (c: Coin) => void }) {
  const { config } = useSession();
  const [content, setContent] = useState<ContentSettings>(coin.contentSettings);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!config) return null;

  const save = async (patch: Record<string, unknown>, okText = "Saved.") => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ coin: Coin }>(`/coins/${coin.id}/settings`, { method: "PATCH", json: patch });
      onSaved({ ...coin, ...r.coin });
      setMsg({ tone: "ok", text: okText });
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <div className="settings-bar">
        <label className="switch">
          <input type="checkbox" checked={!coin.contentPaused} onChange={(e) => save({ contentPaused: !e.target.checked }, e.target.checked ? "Posting resumed." : "Posting paused.")} />
          <span>
            <strong>Posting</strong>
            <small>{coin.contentPaused ? "Paused" : "On"}</small>
          </span>
        </label>
      </div>
      <h3 className="sub-section">Character</h3>
      <PersonaSummary persona={coin.persona} config={config} />
      <h3 className="sub-section">Posting</h3>
      <ContentEditor value={content} onChange={setContent} config={config} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <button className="btn btn-primary" disabled={busy} onClick={() => save({ contentSettings: content })}>
        Save changes
      </button>
    </div>
  );
}

/** DexScreener's own chart by default; Reelpad's built-in chart as a backup (e.g. a coin DexScreener hasn't listed yet). */
function ChartTab({ coinKey, symbol, mint }: { coinKey: string; symbol: string; mint: string }) {
  const [source, setSource] = useState<"dexscreener" | "builtin">("dexscreener");
  return (
    <>
      {source === "dexscreener" ? (
        <DexScreenerChart mint={mint} symbol={symbol} />
      ) : (
        <PriceChart coinKey={coinKey} symbol={symbol} mint={mint} />
      )}
      <p className="sub-hint chart-switch">
        {source === "dexscreener" ? (
          <>
            Chart blank or "pair not found"? New coins can take a few minutes to appear on DexScreener.{" "}
            <button type="button" className="link-btn" onClick={() => setSource("builtin")}>
              Use the built-in chart
            </button>
          </>
        ) : (
          <button type="button" className="link-btn" onClick={() => setSource("dexscreener")}>
            Back to the DexScreener chart
          </button>
        )}
      </p>
    </>
  );
}

export default function CoinPage() {
  const { key } = useParams();
  const [params, setParams] = useSearchParams();
  const { publicKey } = useWallet();
  const { wallet, signIn, signingIn } = useSession();
  const [coin, setCoin] = useState<Coin | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  // The chart is the default tab for launched coins; the page switches to Posts if there's no chart yet.
  const [tab, setTab] = useState<Tab>("chart");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ coin: Coin }>(`/coins/${key}`);
      setCoin(r.coin);
      const p = await api<{ posts: Post[] }>(`/coins/${r.coin.id}/posts`);
      setPosts(p.posts);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [key]);

  useEffect(() => {
    load();
  }, [load, wallet]);

  // While waiting to be added as an Instagram tester, check every 30s so the next step appears on its own.
  useEffect(() => {
    if (!coin?.isOwner || coin.instagramAccess?.status !== "pending") return;
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [coin?.isOwner, coin?.instagramAccess?.status, load]);

  // Refresh every few seconds while a post is being made (or expected to start), so the progress card moves.
  const [expectUntil, setExpectUntil] = useState(0);
  const making = posts.some((p) => IN_PROGRESS.has(p.status));
  useEffect(() => {
    if (!making && Date.now() > expectUntil) return;
    const id = setInterval(() => {
      if (!making && Date.now() > expectUntil) clearInterval(id);
      load();
    }, 4000);
    return () => clearInterval(id);
  }, [making, expectUntil, load]);

  useEffect(() => {
    if (params.get("ig") === "connected") {
      setFlash("Instagram connected. Your first post is being made now. Watch its progress below.");
      setTab("posts");
      setExpectUntil(Date.now() + 120_000);
    }
    if (params.get("ig_error")) setError(params.get("ig_error"));
    if (params.has("ig") || params.has("ig_error")) {
      params.delete("ig");
      params.delete("ig_error");
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  if (error && !coin) return <div className="page narrow"><Notice tone="error">{error}</Notice></div>;
  if (!coin) return <div className="page" aria-busy="true" />;

  const owner = !!coin.isOwner;
  const couldOwn = !owner && publicKey?.toBase58() === coin.creatorWallet;
  const launched = params.get("launched") === "1";
  const igActive = coin.instagram?.status === "active";
  const hasChart = coin.status === "live" && !!coin.mint;
  const shown: Tab = tab === "chart" && !hasChart ? "posts" : tab;

  const generate = async () => {
    try {
      await api(`/coins/${coin.id}/posts/generate`, { method: "POST", json: {} });
      setFlash("A new post is being made. Watch its progress in the Posts tab.");
      setTab("posts");
      setExpectUntil(Date.now() + 90_000);
      setTimeout(load, 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page coin">
      <header className="profile">
        <img className="profile-avatar" src={coin.imageUrl} alt="" />
        <div className="profile-main">
          <h1>
            {coin.name} <span className="profile-ticker">${coin.symbol}</span>
          </h1>
          <p className="profile-handle">
            {igActive && coin.instagram ? (
              <a href={`https://instagram.com/${coin.instagram.username}`} target="_blank" rel="noreferrer">
                @{coin.instagram.username}
              </a>
            ) : (
              "No Instagram account connected"
            )}
          </p>
          {coin.description && <p className="profile-bio">{coin.description}</p>}
          <div className="profile-links">
            {coin.mint && (
              <>
                <Address value={coin.mint} />
                <a href={`https://pump.fun/coin/${coin.mint}`} target="_blank" rel="noreferrer">
                  Trade on pump.fun
                </a>
              </>
            )}
            {coin.website && <a href={coin.website} target="_blank" rel="noreferrer">Website</a>}
            {coin.twitter && <a href={coin.twitter} target="_blank" rel="noreferrer">X</a>}
            {coin.telegram && <a href={coin.telegram} target="_blank" rel="noreferrer">Telegram</a>}
          </div>
        </div>
        <dl className="profile-stats">
          <div>
            <dt>Posts</dt>
            <dd>{posts.filter((p) => p.status === "published").length}</dd>
          </div>
          <div>
            <dt>Launched</dt>
            <dd>{coin.launchedAt ? new Date(coin.launchedAt).toLocaleDateString() : "—"}</dd>
          </div>
        </dl>
      </header>

      {igActive && coin.status === "live" && (
        <NextPostCountdown
          coin={coin}
          making={making}
          onDue={() => {
            // The scheduler picks up due posts within a minute; refresh so the new post card appears.
            setExpectUntil(Date.now() + 120_000);
            setTimeout(load, 5000);
          }}
        />
      )}

      {flash && <Notice tone="ok">{flash}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {couldOwn && (
        <Notice>
          This is your coin.{" "}
          <button className="link-btn" onClick={() => signIn().catch((e) => setError(e.message))} disabled={signingIn}>
            Sign in to manage it
          </button>
        </Notice>
      )}

      {owner && coin.status !== "live" && (
        <Notice tone="warn">
          This coin hasn't launched yet ({coin.status}). {coin.launchError && `Last error: ${coin.launchError}. `}
          <Link to="/mine">Go to my coins</Link>
        </Notice>
      )}

      {owner && coin.status === "live" && !igActive && <InstagramConnect coin={coin} launched={launched} onChange={setCoin} />}

      <nav className="tabs" role="tablist">
        {([...(hasChart ? ["chart"] : []), "posts", "treasury", ...(owner ? ["settings"] : [])] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={shown === t} className={shown === t ? "tab on" : "tab"} onClick={() => setTab(t)}>
            {t === "chart" ? "Chart" : t === "posts" ? "Posts" : t === "treasury" ? "Treasury" : "Settings"}
          </button>
        ))}
        {owner && igActive && coin.status === "live" && shown === "posts" && (
          <button className="btn btn-small tabs-action" onClick={generate}>
            Make a post now
          </button>
        )}
      </nav>

      {shown === "chart" && hasChart && (
        // Its own error boundary: if the chart ever fails, only the chart shows a message; the page keeps working.
        <ErrorBoundary fallback={<p className="empty-line">The chart couldn't be shown right now. Posts and Treasury still work.</p>}>
          <ChartTab coinKey={coin.mint!} symbol={coin.symbol} mint={coin.mint!} />
        </ErrorBoundary>
      )}
      {shown === "posts" &&
        (posts.length === 0 ? (
          <p className="empty-line">
            {igActive ? "The first post is being planned. It appears here as soon as it's made." : "Posts appear here once Instagram is connected."}
          </p>
        ) : (
          <div className="posts">
            {posts.map((p) =>
              owner && IN_PROGRESS.has(p.status) ? (
                <MakingTile key={p.id} post={p} />
              ) : (
                <PostTile key={p.id} post={p} owner={owner} onChange={load} />
              ),
            )}
          </div>
        ))}
      {shown === "treasury" && coin.status === "live" && <TreasuryTab coin={coin} />}
      {shown === "settings" && owner && (
        <>
          <SettingsTab coin={coin} onSaved={setCoin} />
          {igActive && (
            <button
              className="btn btn-quiet danger"
              onClick={async () => {
                if (!confirm("Disconnect Instagram? The character stops posting until you reconnect.")) return;
                await api("/instagram/disconnect", { method: "POST", json: { coinId: coin.id } });
                load();
              }}
            >
              Disconnect Instagram
            </button>
          )}
        </>
      )}
    </div>
  );
}
