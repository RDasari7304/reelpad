import { useEffect, useState } from "react";
import { api, type Coin, type StoryResponse } from "./api";

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
  if (!cur && !last) return null;
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
      {cur && story && story.past.length > 0 && (
        <p className="story-past">Previously: {story.past.map((p) => `"${p.title}"`).join(", ")}</p>
      )}
    </section>
  );
}
