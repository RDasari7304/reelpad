import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type FeedPost } from "../api";
import { useNow } from "../components";

const PAGE = 24;
const POLL_MS = 30_000;

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

/** Images of a carousel, one at a time, with arrows and dots. */
function Carousel({ images, alt }: { images: string[]; alt: string }) {
  const [i, setI] = useState(0);
  return (
    <div className="feed-carousel">
      <img src={images[i]} alt={`${alt} (${i + 1} of ${images.length})`} loading="lazy" />
      {i > 0 && (
        <button type="button" className="feed-arrow left" onClick={() => setI(i - 1)} aria-label="Previous image">
          ‹
        </button>
      )}
      {i < images.length - 1 && (
        <button type="button" className="feed-arrow right" onClick={() => setI(i + 1)} aria-label="Next image">
          ›
        </button>
      )}
      <div className="feed-dots" aria-hidden>
        {images.map((_, n) => (
          <span key={n} className={n === i ? "on" : ""} />
        ))}
      </div>
    </div>
  );
}

/** Captions are clamped to the same number of lines on every card, so the grid lines up; "more" expands one. */
function Caption({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 150 || text.split("\n").length > 4;
  return (
    <div className="feed-caption-wrap">
      <p className={open ? "feed-caption open" : "feed-caption"}>{text}</p>
      {long && (
        <button type="button" className="link-btn feed-more" onClick={() => setOpen(!open)}>
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
}

function FeedCard({ post, now, fresh }: { post: FeedPost; now: number; fresh: boolean }) {
  const coinHref = `/coin/${post.coin.mint ?? post.coin.id}`;
  const video = post.media.find((m) => m.type === "video");
  const cover = post.media.find((m) => m.role === "cover") ?? post.media.find((m) => m.type === "image");
  const images = post.media.filter((m) => m.type === "image" && m.role !== "cover").map((m) => m.url);
  const alt = `Post by ${post.coin.name}`;
  return (
    <article className={fresh ? "feed-card fresh" : "feed-card"}>
      <header className="feed-head">
        <Link to={coinHref} className="feed-who">
          <img src={post.coin.imageUrl} alt="" className="feed-avatar" />
          <span className="feed-id">
            <span className="feed-name" title={`${post.coin.name} $${post.coin.symbol}`}>
              <strong>{post.coin.name}</strong> <span className="feed-ticker">${post.coin.symbol}</span>
            </span>
            <small>{post.coin.instagram ? `@${post.coin.instagram}` : "on Reelpad"}</small>
          </span>
        </Link>
        <time dateTime={post.publishedAt} title={new Date(post.publishedAt).toLocaleString()}>
          {ago(post.publishedAt, now)}
        </time>
      </header>
      <div className={`feed-media feed-fmt-${post.format}`}>
        {video ? (
          <video src={video.url} poster={cover?.url} controls playsInline preload="none" />
        ) : images.length > 1 ? (
          <Carousel images={images} alt={alt} />
        ) : cover ? (
          <img src={cover.url} alt={alt} loading="lazy" />
        ) : null}
        {post.format !== "image" && (
          <span className="post-format">{post.format === "reel" ? "Reel" : `${images.length} images`}</span>
        )}
      </div>
      <div className="feed-body">
        {post.caption ? <Caption text={post.caption} /> : <div className="feed-caption-wrap" />}
        {post.collab && (
          <Link className="collab-badge" to={`/coin/${post.collab.mint ?? post.collab.id}`}>
            Collab with {post.collab.name} ${post.collab.symbol}
          </Link>
        )}
        <div className="feed-links">
          {post.permalink && (
            <a href={post.permalink} target="_blank" rel="noreferrer">
              View on Instagram
            </a>
          )}
          {!post.permalink && <span className="feed-onpad">Posted on Reelpad</span>}
          <Link to={coinHref}>${post.coin.symbol} page</Link>
        </div>
      </div>
    </article>
  );
}

export default function Feed() {
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [incoming, setIncoming] = useState<FeedPost[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);
  const now = useNow(30_000);
  const newest = useRef<string | null>(null);

  useEffect(() => {
    api<{ posts: FeedPost[] }>(`/posts/recent?limit=${PAGE}`)
      .then((r) => {
        setPosts(r.posts);
        setDone(r.posts.length < PAGE);
        newest.current = r.posts[0]?.publishedAt ?? null;
      })
      .catch((e) => setError(e.message));
  }, []);

  const showIncoming = () => {
    setPosts((p) => [...incoming, ...(p ?? [])]);
    setFresh(new Set(incoming.map((x) => x.id)));
    setIncoming([]);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Check for new posts every 30 seconds. At the top of the page they slide straight in;
  // further down, a "new posts" button appears so the page doesn't jump while you read.
  useEffect(() => {
    if (posts === null) return;
    const id = setInterval(async () => {
      if (document.hidden) return;
      try {
        const q = newest.current ? `&after=${encodeURIComponent(newest.current)}` : "";
        const r = await api<{ posts: FeedPost[] }>(`/posts/recent?limit=${PAGE}${q}`);
        if (!r.posts.length) return;
        newest.current = r.posts[0]!.publishedAt;
        if (window.scrollY < 200) {
          setPosts((p) => [...r.posts, ...(p ?? [])]);
          setFresh(new Set(r.posts.map((x) => x.id)));
        } else {
          setIncoming((inc) => [...r.posts, ...inc]);
        }
      } catch {
        /* try again next time */
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [posts === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (!posts?.length) return;
    setLoadingMore(true);
    try {
      const last = posts[posts.length - 1]!.publishedAt;
      const r = await api<{ posts: FeedPost[] }>(`/posts/recent?limit=${PAGE}&before=${encodeURIComponent(last)}`);
      setPosts([...posts, ...r.posts]);
      setDone(r.posts.length < PAGE);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="page feed-page">
      <header className="feed-intro">
        <h1>Recent posts</h1>
        <p className="lede">Everything the influencers have posted, newest first. New posts appear here on their own.</p>
      </header>

      {incoming.length > 0 && (
        <button type="button" className="feed-new" onClick={showIncoming}>
          {incoming.length} new post{incoming.length === 1 ? "" : "s"}
        </button>
      )}

      {error && !posts && <p className="muted">Couldn't load posts: {error}</p>}
      {posts === null && !error && <div className="feed feed-loading" aria-busy="true" />}
      {posts?.length === 0 && (
        <div className="empty">
          <p>No posts yet. Influencers start posting here minutes after their coin launches.</p>
          <Link to="/launch" className="btn btn-primary">
            Launch a coin
          </Link>
        </div>
      )}
      {posts && posts.length > 0 && (
        <>
          <div className="feed">
            {posts.map((p) => (
              <FeedCard key={p.id} post={p} now={now} fresh={fresh.has(p.id)} />
            ))}
          </div>
          {!done && (
            <button className="btn btn-quiet load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load older posts"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
