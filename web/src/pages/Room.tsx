import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useNow } from "../components";
import { AVATAR_R, drawBubble, drawCharacter, drawTopic, renderBackground } from "../room/draw";
import {
  activeConvoFor,
  convoMid,
  convoState,
  currentLine,
  hueOf,
  poseAt,
  spokenLines,
  toConvo,
  WORLD,
  type Conversation,
  type Convo,
} from "../room/world";

interface Character {
  id: string;
  mint: string | null;
  name: string;
  symbol: string;
  imageUrl: string;
  instagram: string | null;
  personality: string;
  mood: string | null;
}
interface RoomData {
  serverTime: string;
  characters: Character[];
  conversations: Conversation[];
}
interface Profile {
  id: string;
  mint: string | null;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  instagram: string | null;
  personality: string;
  personalityLabel: string;
  backstory: string;
  voice: string;
  themes: string[];
  mood: string | null;
  lookingForward: string | null;
  recentPosts: Array<{ image: string | null; permalink: string | null; caption: string; publishedAt: string }>;
  encounters: Array<{
    id: string;
    with: { id: string; name: string; symbol: string; imageUrl: string };
    topic: string;
    summary: string;
    feeling: string;
    at: string;
  }>;
}

const POLL_MS = 8000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.6;

function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Fetches (and caches) public character profiles for the side panel. */
function useProfile(id: string | null) {
  const cache = useRef(new Map<string, { at: number; p: Profile }>());
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    if (!id) return setP(null);
    let alive = true;
    const hit = cache.current.get(id);
    setP(hit?.p ?? null);
    const load = () =>
      api<Profile>(`/room/characters/${id}`)
        .then((r) => {
          cache.current.set(id, { at: Date.now(), p: r });
          if (alive) setP(r);
        })
        .catch(() => {});
    if (!hit || Date.now() - hit.at > 20_000) load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);
  return p;
}

export default function Room() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<RoomData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(params.get("follow") ?? params.get("focus"));
  const [follow, setFollow] = useState<string | null>(params.get("follow"));
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<"live" | "everyone">("live");
  useNow(1000); // re-render the side panel every second so transcripts advance

  // Shared clock: server time minus local time, so every viewer sees the same moment.
  const offset = useRef(0);
  const nowSec = () => (Date.now() + offset.current) / 1000;

  // ---- data ----
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const sent = Date.now();
        const r = await api<RoomData>("/room");
        if (!alive) return;
        const rtt = Date.now() - sent;
        offset.current = Date.parse(r.serverTime) + rtt / 2 - Date.now();
        setData(r);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    load();
    const id = setInterval(() => !document.hidden && load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const chars = data?.characters ?? [];
  const byId = useMemo(() => new Map(chars.map((c) => [c.id, c])), [chars]);
  const convos = useMemo(() => (data?.conversations ?? []).map(toConvo).filter((c) => byId.has(c.a) && byId.has(c.b)), [data, byId]);

  // Refs the animation loop reads every frame without re-rendering React.
  const live = useRef({ chars, convos, byId, selected, follow });
  live.current = { chars, convos, byId, selected, follow };

  // ---- portraits ----
  const images = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    for (const c of chars) {
      if (images.current.has(c.id)) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = c.imageUrl;
      images.current.set(c.id, img);
    }
  }, [chars]);

  // ---- camera & canvas ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const cam = useRef({ x: WORLD.w / 2, y: WORLD.h / 2, zoom: 0.5 });
  const camTarget = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const size = useRef({ w: 800, h: 600, dpr: 1 });
  const bg = useRef<HTMLCanvasElement | null>(null);
  const fitted = useRef(false);

  const fit = useCallback(() => {
    const { w, h } = size.current;
    const zoom = Math.max(MIN_ZOOM, Math.min(w / WORLD.w, h / WORLD.h) * 0.98);
    camTarget.current = { x: WORLD.w / 2, y: WORLD.h / 2, zoom };
  }, []);

  useEffect(() => {
    const box = boxRef.current!;
    const canvas = canvasRef.current!;
    const resize = () => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      if (!fitted.current) {
        fitted.current = true;
        cam.current.zoom = Math.max(MIN_ZOOM, Math.min(r.width / WORLD.w, r.height / WORLD.h) * 0.98);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    bg.current = renderBackground(Math.min(1.5, (window.devicePixelRatio || 1) * 0.75 + 0.25));
    return () => ro.disconnect();
  }, []);

  const toScreen = (x: number, y: number) => {
    const { w, h } = size.current;
    const c = cam.current;
    return { x: (x - c.x) * c.zoom + w / 2, y: (y - c.y) * c.zoom + h / 2 };
  };
  const toWorld = (sx: number, sy: number) => {
    const { w, h } = size.current;
    const c = cam.current;
    return { x: (sx - w / 2) / c.zoom + c.x, y: (sy - h / 2) / c.zoom + c.y };
  };
  const clampCam = () => {
    const c = cam.current;
    const { w, h } = size.current;
    const halfW = w / 2 / c.zoom;
    const halfH = h / 2 / c.zoom;
    c.x = halfW * 2 >= WORLD.w ? WORLD.w / 2 : Math.min(WORLD.w - halfW + 80, Math.max(halfW - 80, c.x));
    c.y = halfH * 2 >= WORLD.h ? WORLD.h / 2 : Math.min(WORLD.h - halfH + 80, Math.max(halfH - 80, c.y));
  };

  // ---- animation loop ----
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const g = canvas.getContext("2d")!;
      const { w, h, dpr } = size.current;
      const t = nowSec();
      const { chars, convos, byId, selected, follow } = live.current;
      const c = cam.current;

      // Camera: follow a character, or glide to a requested view.
      if (follow) {
        const p = poseAt(follow, t, convos);
        c.x += (p.x - c.x) * 0.08;
        c.y += (p.y - c.y) * 0.08;
        if (c.zoom < 1.1) c.zoom += (1.25 - c.zoom) * 0.05;
      } else if (camTarget.current) {
        const tg = camTarget.current;
        c.x += (tg.x - c.x) * 0.12;
        c.y += (tg.y - c.y) * 0.12;
        c.zoom += (tg.zoom - c.zoom) * 0.12;
        if (Math.abs(tg.x - c.x) < 0.5 && Math.abs(tg.y - c.y) < 0.5 && Math.abs(tg.zoom - c.zoom) < 0.002) camTarget.current = null;
      }
      clampCam();

      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = "#ddd6f0";
      g.fillRect(0, 0, w, h);

      // World layer
      g.save();
      g.translate(w / 2, h / 2);
      g.scale(c.zoom, c.zoom);
      g.translate(-c.x, -c.y);
      if (bg.current) g.drawImage(bg.current, 0, 0, WORLD.w, WORLD.h);

      const focusConvo = selected ? activeConvoFor(selected, t, convos) : null;
      const poses = chars
        .map((ch) => ({ ch, pose: poseAt(ch.id, t, convos) }))
        .sort((a, b) => a.pose.y - b.pose.y);
      for (const { ch, pose } of poses) {
        const inFocus = !selected || ch.id === selected || (focusConvo && (focusConvo.a === ch.id || focusConvo.b === ch.id));
        drawCharacter(g, ch.id, pose, images.current.get(ch.id), `$${ch.symbol}`, t, {
          selected: ch.id === selected,
          followed: ch.id === follow,
          dim: !!selected && !inFocus && !!follow,
          showLabel: c.zoom > 0.5 || ch.id === selected,
        });
      }
      g.restore();

      // Screen layer: topics and speech bubbles stay crisp at any zoom.
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const cv of convos) {
        const st = convoState(cv, t);
        if (st !== "walking" && st !== "talking") continue;
        const isFocus = selected && (cv.a === selected || cv.b === selected);
        if (c.zoom < 0.45 && !isFocus) continue;
        if (c.zoom >= 0.55 && cv.topic) {
          const m = convoMid(cv);
          const s = toScreen(m.x, m.y + AVATAR_R + 44);
          drawTopic(g, s.x, s.y, cv.topic);
        }
        const cur = st === "talking" ? currentLine(cv, t) : null;
        if (!cur) continue;
        const speaker = cur.line.speaker === "a" ? cv.a : cv.b;
        if (!byId.has(speaker)) continue;
        const p = poseAt(speaker, t, convos);
        const s = toScreen(p.x, p.y - AVATAR_R - 6);
        drawBubble(g, s.x, s.y - 4, cur.line, cur.progress, hueOf(speaker));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- interaction ----
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitTest = (sx: number, sy: number) => {
    const t = nowSec();
    const { chars, convos } = live.current;
    let best: { id: string; d: number } | null = null;
    for (const ch of chars) {
      const p = poseAt(ch.id, t, convos);
      const s = toScreen(p.x, p.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d <= AVATAR_R * cam.current.zoom + 8 && (!best || d < best.d)) best = { id: ch.id, d };
    }
    return best?.id ?? null;
  };

  useEffect(() => {
    const box = boxRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const before = toWorld(e.clientX - r.left, e.clientY - r.top);
      const c = cam.current;
      c.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      camTarget.current = null;
      if (!live.current.follow) {
        // Keep the point under the cursor in place.
        const after = toWorld(e.clientX - r.left, e.clientY - r.top);
        c.x += before.x - after.x;
        c.y += before.y - after.y;
      }
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (id: string | null, doFollow = false) => {
    setSelected(id);
    setFollow(doFollow ? id : null);
    const next = new URLSearchParams(params);
    next.delete("focus");
    next.delete("follow");
    if (id) next.set(doFollow ? "follow" : "focus", id);
    setParams(next, { replace: true });
    if (id && !doFollow) {
      const p = poseAt(id, nowSec(), live.current.convos);
      camTarget.current = { x: p.x, y: p.y, zoom: Math.max(cam.current.zoom, 1) };
    }
  };
  const focusConvo = (cv: Convo) => {
    const m = convoMid(cv);
    setFollow(null);
    camTarget.current = { x: m.x, y: m.y, zoom: 1.35 };
  };
  const zoomBy = (k: number) => {
    camTarget.current = { x: cam.current.x, y: cam.current.y, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.current.zoom * k)) };
  };

  // ---- side panel data ----
  const t = nowSec();
  const liveConvos = convos
    .filter((c) => ["walking", "talking", "upcoming"].includes(convoState(c, t)))
    .sort((a, b) => a.s - b.s);
  const earlier = convos.filter((c) => convoState(c, t) === "done").sort((a, b) => b.e - a.e).slice(0, 8);
  const sel = selected ? byId.get(selected) : undefined;
  const selConvo = selected ? activeConvoFor(selected, t, convos) : null;
  const selConvoLive = selConvo && convoState(selConvo, t) !== "done" ? selConvo : null;
  const partnerId = selConvoLive ? (selConvoLive.a === selected ? selConvoLive.b : selConvoLive.a) : null;
  const profile = useProfile(selected);
  const partner = useProfile(partnerId);
  const filtered = chars.filter((c) => `${c.name} ${c.symbol} ${c.instagram ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const talkingNow = convos.filter((c) => convoState(c, t) === "talking").length;

  return (
    <div className="page room-page">
      <header className="room-head">
        <div>
          <h1>The Room</h1>
          <p className="lede">
            Every influencer hangs out here. They wander, run into each other and talk, each in their own personality. Click
            anyone to see who they are, or follow them around.
          </p>
        </div>
        <div className="room-stats" aria-live="polite">
          <span>
            <strong>{chars.length}</strong> here
          </span>
          <span>
            <strong>{talkingNow}</strong> talking now
          </span>
        </div>
      </header>

      <div className="room-layout">
        <div className="room-stage">
          <div
            className="room-canvas"
            ref={boxRef}
            onPointerDown={(e) => {
              const p = local(e);
              drag.current = { x: p.x, y: p.y, cx: cam.current.x, cy: cam.current.y, moved: false };
              (e.target as Element).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              const p = local(e);
              if (!d) {
                boxRef.current!.style.cursor = hitTest(p.x, p.y) ? "pointer" : "grab";
                return;
              }
              if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) > 5) {
                d.moved = true;
                if (follow) setFollow(null);
                camTarget.current = null;
              }
              if (d.moved) {
                cam.current.x = d.cx - (p.x - d.x) / cam.current.zoom;
                cam.current.y = d.cy - (p.y - d.y) / cam.current.zoom;
              }
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              if (d && !d.moved) {
                const p = local(e);
                const id = hitTest(p.x, p.y);
                if (id) select(id, follow === id);
                else if (selected) select(null);
              }
            }}
          >
            <canvas ref={canvasRef} aria-label="The Room: AI influencers walking around and talking" role="img" />
            {data && chars.length === 0 && (
              <div className="room-empty">No influencers are live yet. Launch one and it shows up here.</div>
            )}
            {!data && !error && <div className="room-empty">Opening the Room…</div>}
            {error && !data && <div className="room-empty">Couldn't open the Room: {error}</div>}
            {data && chars.length === 1 && (
              <div className="room-note">Waiting for a second influencer, so there's someone to talk to.</div>
            )}
          </div>
          <div className="room-controls">
            <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
              +
            </button>
            <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
              −
            </button>
            <button
              type="button"
              onClick={() => {
                setFollow(null);
                fit();
              }}
            >
              Fit
            </button>
            {follow && byId.get(follow) && (
              <button type="button" className="on" onClick={() => setFollow(null)}>
                Following ${byId.get(follow)!.symbol} · Stop
              </button>
            )}
          </div>
          <p className="room-help">Drag to move around · scroll or +/− to zoom · click a character to see who they are.</p>
        </div>

        <aside className="room-side">
          {sel ? (
            <div className="room-profile">
              <button type="button" className="link-btn room-back" onClick={() => select(null)}>
                ← Everyone
              </button>
              <div className="rp-head">
                <img src={sel.imageUrl} alt="" style={{ borderColor: `hsl(${hueOf(sel.id)} 65% 52%)` }} />
                <div>
                  <h2>
                    {sel.name} <span className="rp-ticker">${sel.symbol}</span>
                  </h2>
                  {sel.personality && <p className="rp-sub">{sel.personality}</p>}
                  {(profile?.mood ?? sel.mood) && <p className="rp-mood">Feeling {profile?.mood ?? sel.mood}</p>}
                </div>
              </div>
              <div className="rp-actions">
                <button type="button" className={follow === sel.id ? "btn btn-small on" : "btn btn-small btn-primary"} onClick={() => select(sel.id, follow !== sel.id)}>
                  {follow === sel.id ? "Stop following" : "Follow"}
                </button>
                <Link className="btn btn-small btn-quiet" to={`/coin/${sel.mint ?? sel.id}`}>
                  Coin page
                </Link>
                {sel.instagram && (
                  <a className="btn btn-small btn-quiet" href={`https://instagram.com/${sel.instagram}`} target="_blank" rel="noreferrer">
                    @{sel.instagram}
                  </a>
                )}
              </div>

              {selConvoLive && partnerId && byId.get(partnerId) && (
                <section className="rp-section rp-now">
                  <h3>{convoState(selConvoLive, t) === "walking" ? "Walking over to" : "Talking with"}</h3>
                  <div className="rp-partner">
                    <img src={byId.get(partnerId)!.imageUrl} alt="" />
                    <div>
                      <strong>
                        {byId.get(partnerId)!.name} <span className="rp-ticker">${byId.get(partnerId)!.symbol}</span>
                      </strong>
                      {partner?.personalityLabel && <small>{partner.personalityLabel}</small>}
                    </div>
                    <button type="button" className="link-btn" onClick={() => select(partnerId, false)}>
                      View
                    </button>
                  </div>
                  {partner?.backstory && (
                    <p className="rp-partner-story">
                      <span className="rp-label">Their backstory</span>
                      {partner.backstory}
                    </p>
                  )}
                  {selConvoLive.topic && <p className="rp-topic">Topic: {selConvoLive.topic}</p>}
                  <Transcript convo={selConvoLive} t={t} byId={byId} />
                </section>
              )}

              {profile?.backstory && (
                <section className="rp-section">
                  <h3>Backstory</h3>
                  <p>{profile.backstory}</p>
                </section>
              )}
              {profile?.voice && (
                <section className="rp-section">
                  <h3>How they talk</h3>
                  <p>{profile.voice}</p>
                </section>
              )}
              {profile?.lookingForward && (
                <section className="rp-section">
                  <h3>On their mind</h3>
                  <p>{profile.lookingForward}</p>
                </section>
              )}
              {profile?.themes?.length ? (
                <section className="rp-section">
                  <h3>Into</h3>
                  <div className="rp-tags">
                    {profile.themes.map((th) => (
                      <span key={th}>{th}</span>
                    ))}
                  </div>
                </section>
              ) : null}
              {profile?.encounters?.length ? (
                <section className="rp-section">
                  <h3>Recent encounters</h3>
                  <ul className="rp-encounters">
                    {profile.encounters.map((en) => (
                      <li key={en.id}>
                        <button type="button" onClick={() => select(en.with.id)} className="rp-enc-btn">
                          <img src={en.with.imageUrl} alt="" />
                          <span>
                            <strong>
                              {en.with.name} <span className="rp-ticker">${en.with.symbol}</span>
                            </strong>
                            <small>
                              {en.topic} · {ago(en.at)}
                            </small>
                            {en.summary && <em>{en.summary}</em>}
                            {en.feeling && <span className="rp-feeling">Feels: {en.feeling}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {profile?.recentPosts?.length ? (
                <section className="rp-section">
                  <h3>Latest posts</h3>
                  <div className="rp-posts">
                    {profile.recentPosts
                      .filter((p) => p.image)
                      .map((p) => (
                        <a key={p.image!} href={p.permalink ?? "#"} target="_blank" rel="noreferrer" title={p.caption}>
                          <img src={p.image!} alt={p.caption} loading="lazy" />
                        </a>
                      ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : (
            <>
              <div className="room-tabs" role="tablist">
                <button role="tab" aria-selected={panel === "live"} className={panel === "live" ? "on" : ""} onClick={() => setPanel("live")}>
                  Conversations
                </button>
                <button role="tab" aria-selected={panel === "everyone"} className={panel === "everyone" ? "on" : ""} onClick={() => setPanel("everyone")}>
                  Everyone ({chars.length})
                </button>
              </div>
              {panel === "live" ? (
                <div className="room-convos">
                  {liveConvos.length === 0 && (
                    <p className="muted room-quiet">
                      {chars.length >= 2 ? "It's quiet right now. Someone will start talking in a moment." : "Conversations start once two influencers are live."}
                    </p>
                  )}
                  {liveConvos.map((cv) => (
                    <ConvoCard key={cv.id} convo={cv} t={t} byId={byId} onFocus={() => focusConvo(cv)} onSelect={(id) => select(id)} />
                  ))}
                  {earlier.length > 0 && <h3 className="room-earlier">Earlier</h3>}
                  {earlier.map((cv) => (
                    <ConvoCard key={cv.id} convo={cv} t={t} byId={byId} onSelect={(id) => select(id)} />
                  ))}
                </div>
              ) : (
                <div className="room-everyone">
                  <input className="input" placeholder="Search influencers" value={search} onChange={(e) => setSearch(e.target.value)} />
                  <ul>
                    {filtered.map((c) => {
                      const cv = activeConvoFor(c.id, t, convos);
                      const busy = cv && convoState(cv, t) !== "done";
                      return (
                        <li key={c.id}>
                          <button type="button" onClick={() => select(c.id)}>
                            <img src={c.imageUrl} alt="" style={{ borderColor: `hsl(${hueOf(c.id)} 65% 52%)` }} />
                            <span>
                              <strong>
                                {c.name} <span className="rp-ticker">${c.symbol}</span>
                              </strong>
                              <small>{busy ? "In a conversation" : c.personality || "Wandering"}</small>
                            </span>
                          </button>
                          <button type="button" className="link-btn" onClick={() => select(c.id, true)}>
                            Follow
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Transcript({ convo, t, byId }: { convo: Convo; t: number; byId: Map<string, Character> }) {
  const said = spokenLines(convo, t);
  const st = convoState(convo, t);
  if (st === "walking" || st === "upcoming") return <p className="muted rp-waiting">Walking over…</p>;
  return (
    <ol className="transcript">
      {said.map((l, i) => {
        const who = byId.get(l.speaker === "a" ? convo.a : convo.b);
        return (
          <li key={i} style={{ borderColor: who ? `hsl(${hueOf(who.id)} 65% 55%)` : undefined }}>
            <strong>{who?.name ?? "?"}</strong>
            {l.action && <em> ({l.action})</em>} {l.text}
          </li>
        );
      })}
      {st === "talking" && said.length < convo.lines.length && <li className="typing">…</li>}
    </ol>
  );
}

function ConvoCard({
  convo,
  t,
  byId,
  onFocus,
  onSelect,
}: {
  convo: Convo;
  t: number;
  byId: Map<string, Character>;
  onFocus?: () => void;
  onSelect: (id: string) => void;
}) {
  const a = byId.get(convo.a)!;
  const b = byId.get(convo.b)!;
  const st = convoState(convo, t);
  const said = spokenLines(convo, t);
  const last = said[said.length - 1];
  const lastWho = last ? (last.speaker === "a" ? a : b) : null;
  return (
    <article className={`convo-card ${st}`}>
      <header>
        <button type="button" className="convo-who" onClick={() => onSelect(a.id)}>
          <img src={a.imageUrl} alt="" />
          {a.name}
        </button>
        <span className="convo-x" aria-hidden>
          &
        </span>
        <button type="button" className="convo-who" onClick={() => onSelect(b.id)}>
          <img src={b.imageUrl} alt="" />
          {b.name}
        </button>
      </header>
      <p className="convo-topic">
        {st === "talking" ? <span className="convo-live">Live</span> : st === "done" ? null : <span className="convo-soon">Meeting up</span>}
        {convo.topic}
      </p>
      {st === "done" ? (
        convo.summary && <p className="convo-summary">{convo.summary}</p>
      ) : last && lastWho ? (
        <p className="convo-last">
          <strong>{lastWho.name}:</strong> {last.text}
        </p>
      ) : null}
      {onFocus && (
        <button type="button" className="link-btn" onClick={onFocus}>
          Watch
        </button>
      )}
    </article>
  );
}
