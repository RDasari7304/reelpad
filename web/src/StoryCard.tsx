import { useEffect, useState } from "react";
import { api, type Coin, type StoryPoll, type StoryResponse } from "./api";
import { useSession } from "./session";

/** Holders vote on how the next episode goes. Results show live; one vote per wallet, changeable until it closes. */
function PollBox({ coin, poll, onVoted }: { coin: Coin; poll: StoryPoll; onVoted: (r: StoryResponse) => void }) {
  const { wallet, signIn, signingIn } = useSession();
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cast = async (option: number) => {
    setErr(null);
    setBusy(option);
    try {
      if (!wallet) await signIn();
      onVoted(await api<StoryResponse>(`/coins/${coin.id}/polls/${poll.id}/vote`, { method: "POST", json: { option } }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const voted = poll.myVote !== null;
  return (
    <div className="poll">
      <p className="poll-q">
        <span className="poll-tag">Fans decide episode {poll.episode}</span>
        {poll.question}
      </p>
      <ul className="poll-options">
        {poll.options.map((o, i) => {
          const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
          return (
            <li key={i}>
              <button
                type="button"
                className={poll.myVote === i ? "poll-opt mine" : "poll-opt"}
                onClick={() => cast(i)}
                disabled={busy !== null || signingIn}
                aria-pressed={poll.myVote === i}
              >
                <span className="poll-bar" style={{ width: `${voted ? pct : 0}%` }} aria-hidden />
                <span className="poll-text">{o.text}</span>
                {voted && <span className="poll-pct">{pct}%</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="poll-foot">
        {poll.total} vote{poll.total === 1 ? "" : "s"} · ${coin.symbol} holders only, one vote per wallet ·{" "}
        {voted ? "you can change your vote until this episode ends" : "closes when this episode ends"}
        {!wallet && " · connect your wallet to vote"}
      </p>
      {err && <p className="field-error">{err}</p>}
    </div>
  );
}

/** The character's current storyline, shown above its posts: title, premise and the episodes so far. */
export function StoryCard({ coin }: { coin: Coin }) {
  const [story, setStory] = useState<StoryResponse | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api<StoryResponse>(`/coins/${coin.id}/story`).then((r) => alive && setStory(r)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [coin.id]);

  const cur = story?.current;
  const last = story?.past[0];
  if (!cur && !last) {
    // No storyline yet: show the thread of the character's latest posts until the first one is planned.
    if (!story?.lately?.length) return null;
    return (
      <section className="story-card story-lately" aria-label="Storyline">
        <div className="story-head">
          <span className="story-kicker">Storyline · starts with the next post</span>
          <h3>The story so far</h3>
        </div>
        <p className="story-premise">
          {coin.name}'s first full storyline is planned with its next post. Here's what it has been up to lately:
        </p>
        <ol className="story-episodes">
          {story.lately.map((b, i) => (
            <li key={i}>
              {b.title && <strong>{b.title.replace(/^./, (c) => c.toUpperCase())}.</strong>}
              {b.recap && <span> {b.recap}</span>}
            </li>
          ))}
        </ol>
      </section>
    );
  }
  const arc = cur ?? last!;
  return (
    <section className="story-card" aria-label="Storyline">
      <div className="story-head">
        <span className="story-kicker">{cur ? "Current storyline" : "Last storyline"}</span>
        <h3>{arc.title}</h3>
        <span className="story-progress" aria-label={`Episode ${arc.episode} of ${arc.episodes}`}>
          {Array.from({ length: arc.episodes }, (_, i) => (
            <span key={i} className={i < arc.episode - (cur ? 1 : 0) ? "done" : i === arc.episode - 1 && cur ? "now" : ""} />
          ))}
          <small>{cur ? `Episode ${arc.episode} of ${arc.episodes}` : "Finished"}</small>
        </span>
      </div>
      <p className="story-premise">{arc.premise}</p>
      {arc.happened.length > 0 && (
        <>
          <button type="button" className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide the story so far" : "The story so far"}
          </button>
          {open && (
            <ol className="story-episodes">
              {arc.happened.map((b, i) => (
                <li key={i}>
                  <strong>{b.title}</strong>
                  {b.recap && <span> {b.recap}</span>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {cur && story?.poll && <PollBox coin={coin} poll={story.poll} onVoted={setStory} />}
      {cur && story && story.past.length > 0 && (
        <p className="story-past">Previously: {story.past.map((p) => `"${p.title}"`).join(", ")}</p>
      )}
    </section>
  );
}
