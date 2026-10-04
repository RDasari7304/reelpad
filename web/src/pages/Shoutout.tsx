import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Coin, type Shoutout } from "../api";
import { Notice } from "../components";
import { ShoutoutMedia } from "../Shoutouts";

/** A shoutout's own shareable page. */
export default function ShoutoutPage() {
  const { id } = useParams();
  const [data, setData] = useState<{ shoutout: Shoutout; coin: Coin } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ shoutout: Shoutout; coin: Coin }>(`/shoutouts/${id}`)
        .then((r) => alive && setData(r))
        .catch((e) => alive && setError((e as Error).message));
    load();
    const t = setInterval(() => {
      if (data?.shoutout.status === "done" || data?.shoutout.status === "failed") return;
      load();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, data?.shoutout.status]);

  if (error) return <div className="page narrow"><Notice tone="error">{error}</Notice></div>;
  if (!data) return <div className="page narrow" aria-busy="true" />;
  const { shoutout: s, coin } = data;
  const coinHref = `/coin/${coin.mint ?? coin.id}`;
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: `${coin.name} for ${s.recipient}`, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* share sheet closed */
    }
  };
  const download = s.media.find((m) => m.type === "video") ?? s.media.find((m) => m.type === "image");

  return (
    <div className="page shout-page">
      <article className="shout-card">
        <header className="shout-card-head">
          <Link to={coinHref} className="feed-who">
            <img src={coin.imageUrl} alt="" className="feed-avatar" />
            <span>
              <strong>{coin.name}</strong> <span className="feed-ticker">${coin.symbol}</span>
              <small>A shoutout for {s.recipient}</small>
            </span>
          </Link>
        </header>
        {s.status === "done" ? (
          <>
            <div className={`shout-card-media ${s.format}`}>
              <ShoutoutMedia s={s} />
            </div>
            <div className="shout-card-body">
              <h1>For {s.recipient}</h1>
              {s.note && <p className="shout-note">{s.note}</p>}
              <p className="shout-burnline">
                Paid for by burning {s.tokensBurned} ${coin.symbol}
                {s.burnSig && (
                  <>
                    {" · "}
                    <a href={`https://solscan.io/tx/${s.burnSig}`} target="_blank" rel="noreferrer">
                      burn transaction
                    </a>
                  </>
                )}
              </p>
              <div className="shout-card-actions">
                <button className="btn btn-primary" onClick={share}>
                  {copied ? "Link copied" : "Share"}
                </button>
                {download && (
                  <a className="btn" href={download.url} download target="_blank" rel="noreferrer">
                    Download
                  </a>
                )}
                <Link className="btn btn-quiet" to={`${coinHref}?tab=shoutouts`}>
                  Get your own shoutout
                </Link>
              </div>
            </div>
          </>
        ) : s.status === "failed" ? (
          <div className="shout-card-body">
            <Notice tone="error">This shoutout couldn't be made. {s.mine ? "You can try again from the coin's Shoutouts tab." : ""}</Notice>
          </div>
        ) : (
          <div className="shout-card-body">
            <h1>For {s.recipient}</h1>
            <p className="muted">{coin.name} is recording this shoutout. This page updates on its own.</p>
            <div className="shout-progress" role="progressbar" aria-valuenow={s.progress} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.max(4, s.progress)}%` }} />
              <small>{s.status === "awaiting_burn" ? "Waiting for the burn" : s.stage ?? "In the queue"}</small>
            </div>
          </div>
        )}
      </article>
    </div>
  );
}
