import { useCallback, useEffect, useState } from "react";
import { api, type Coin, type CommentThread, type CommentView, type CommentsResponse } from "./api";
import { Notice } from "./components";

function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const STATUS: Record<string, string> = {
  new: "Waiting to reply",
  replied: "Replied",
  skipped: "Skipped",
  failed: "Couldn't reply",
};

function Line({ c, coin }: { c: CommentView; coin: Coin }) {
  return (
    <div className={c.isOwn ? "cm-line own" : "cm-line"}>
      {c.isOwn ? <img className="cm-avatar" src={coin.imageUrl} alt="" /> : <span className="cm-avatar cm-initial">{c.username.slice(0, 1).toUpperCase()}</span>}
      <div className="cm-body">
        <p>
          <strong>{c.isOwn ? coin.name : `@${c.username}`}</strong> {c.text}
        </p>
        <small className="muted">
          {ago(c.at)}
          {c.likeCount > 0 && ` · ${c.likeCount} like${c.likeCount === 1 ? "" : "s"}`}
        </small>
      </div>
    </div>
  );
}

function Thread({ t, coin, owner, onChange }: { t: CommentThread; coin: Coin; owner: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (commentId: string, action: "skip" | "retry") => {
    setBusy(true);
    try {
      await api(`/coins/${coin.id}/comments/${commentId}/${action}`, { method: "POST", json: {} });
      onChange();
    } finally {
      setBusy(false);
    }
  };
  // The owner sees why each comment from a fan was answered or not.
  const fanLines = [t, ...t.replies.filter((r) => !r.isOwn)];
  const statusFor = owner ? fanLines.filter((c) => c.status && c.status !== "replied") : [];
  return (
    <article className="cm-thread">
      {t.post.thumb && (
        <a className="cm-thumb" href={t.post.permalink ?? "#"} target="_blank" rel="noreferrer" title="Open the post on Instagram">
          <img src={t.post.thumb} alt="" loading="lazy" />
        </a>
      )}
      <div className="cm-main">
        <Line c={t} coin={coin} />
        {t.replies.length > 0 && (
          <div className="cm-replies">
            {t.replies.map((r) => (
              <Line key={r.id} c={r} coin={coin} />
            ))}
          </div>
        )}
        {statusFor.map((c) => (
          <div key={c.id} className={`cm-status ${c.status}`}>
            <span>
              {c.id !== t.id && `@${c.username}: `}
              {STATUS[c.status!] ?? c.status}
              {c.reason && c.status !== "new" ? ` · ${c.reason}` : ""}
            </span>
            {(c.status === "new" || c.status === "failed") && (
              <button type="button" className="link-btn" disabled={busy} onClick={() => act(c.id, "skip")}>
                Don't reply
              </button>
            )}
            {(c.status === "skipped" || c.status === "failed") && (
              <button type="button" className="link-btn" disabled={busy} onClick={() => act(c.id, "retry")}>
                Reply anyway
              </button>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}

export function CommentsTab({ coin, owner, onSettings }: { coin: Coin; owner: boolean; onSettings: () => void }) {
  const [data, setData] = useState<CommentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<CommentsResponse>(`/coins/${coin.id}/comments`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [coin.id]);

  useEffect(() => {
    load();
    const id = setInterval(() => !document.hidden && load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const ig = coin.instagram;
  const enabled = !!ig?.commentsEnabled;
  const repliesOn = coin.contentSettings.commentReplies !== false;
  const check = async () => {
    setChecking(true);
    try {
      await api(`/coins/${coin.id}/comments/check`, { method: "POST", json: {} });
      setTimeout(load, 6000);
    } finally {
      setTimeout(() => setChecking(false), 6000);
    }
  };

  return (
    <section className="comments-tab">
      {owner && ig && !enabled && (
        <Notice tone="warn">
          To let {coin.name} reply to comments, reconnect Instagram once and allow <strong>comment management</strong> when
          Instagram asks.{" "}
          <a href={`/api/instagram/connect?coinId=${coin.id}`}>Reconnect Instagram</a>
        </Notice>
      )}
      {owner && enabled && ig?.commentsError && <Notice tone="error">{ig.commentsError}</Notice>}
      {owner && enabled && !repliesOn && (
        <Notice>
          Comment replies are off.{" "}
          <button type="button" className="link-btn" onClick={onSettings}>
            Turn them on in Settings
          </button>
        </Notice>
      )}
      {owner && enabled && data?.stats && (
        <div className="cm-stats">
          <span>
            <strong>{data.stats.today}</strong> replies today (up to {coin.contentSettings.commentRepliesPerDay ?? 40})
          </span>
          <span>
            <strong>{data.stats.waiting}</strong> waiting
          </span>
          <button type="button" className="btn btn-small btn-quiet" onClick={check} disabled={checking}>
            {checking ? "Checking…" : "Check for new comments"}
          </button>
        </div>
      )}
      {error && !data && <p className="muted">Couldn't load comments: {error}</p>}
      {data && data.threads.length === 0 && (
        <p className="empty-line">
          No comments yet. When people comment on {coin.name}'s posts, the conversations show up here
          {enabled && repliesOn ? `. ${coin.name} answers the ones it finds interesting` : ""}.
        </p>
      )}
      <div className="cm-list">
        {data?.threads.map((t) => (
          <Thread key={t.id} t={t} coin={coin} owner={owner} onChange={load} />
        ))}
      </div>
    </section>
  );
}
