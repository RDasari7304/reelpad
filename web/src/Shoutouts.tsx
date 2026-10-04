import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type Coin, type Shoutout, type ShoutoutsResponse } from "./api";
import { Notice } from "./components";
import { decodeTx } from "./launchTx";
import { useSession } from "./session";

const RECIPIENT_MAX = 40;
const REQUEST_MAX = 220;
const IN_PROGRESS = new Set(["queued", "making"]);

type Step = "idle" | "checking" | "signing" | "confirming";
const STEP_TEXT: Record<Step, string> = {
  idle: "",
  checking: "Checking your request…",
  signing: "Approve the burn in your wallet…",
  confirming: "Confirming the burn on-chain…",
};

/** The shoutout itself: talking video (with its still as poster) or the photo. */
export function ShoutoutMedia({ s, autoPlay = false }: { s: Shoutout; autoPlay?: boolean }) {
  const video = s.media.find((m) => m.type === "video");
  const still = s.media.find((m) => m.type === "image");
  if (video) return <video src={video.url} poster={still?.url} controls playsInline autoPlay={autoPlay} preload="metadata" />;
  if (still) return <img src={still.url} alt={`Shoutout for ${s.recipient}`} loading="lazy" />;
  return null;
}

function MyShoutout({ s, coin, onChange, pendingSig, onConfirm }: { s: Shoutout; coin: Coin; onChange: () => void; pendingSig?: string; onConfirm: (id: string, sig: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`shout-mine shout-${s.status}`}>
      <div className="shout-mine-head">
        <strong>For {s.recipient}</strong>
        <span className="shout-format">{s.format === "video" ? "Talking video" : "Photo + note"}</span>
      </div>
      {s.request && <p className="shout-request">"{s.request}"</p>}
      {s.status === "awaiting_burn" && (
        <div className="shout-actions">
          <span className="muted">Waiting for the burn of {s.tokens} ${coin.symbol}.</span>
          {pendingSig && (
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => act(() => onConfirm(s.id, pendingSig))}>
              Check the burn again
            </button>
          )}
          <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => act(() => api(`/shoutouts/${s.id}/cancel`, { method: "POST" }))}>
            Cancel
          </button>
        </div>
      )}
      {IN_PROGRESS.has(s.status) && (
        <div className="shout-progress" role="progressbar" aria-valuenow={s.progress} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.max(4, s.progress)}%` }} />
          <small>{s.stage ?? "In the queue"}</small>
        </div>
      )}
      {s.status === "done" && (
        <div className="shout-actions">
          <Link className="btn btn-small btn-primary" to={`/shoutout/${s.id}`}>
            Open and share
          </Link>
          <span className="muted">Burned {s.tokensBurned} ${coin.symbol}</span>
        </div>
      )}
      {s.status === "failed" && (
        <div className="shout-actions">
          <span className="field-error">Couldn't make it{s.error ? `: ${s.error}` : ""}.</span>
          <button className="btn btn-small" disabled={busy} onClick={() => act(() => api(`/shoutouts/${s.id}/retry`, { method: "POST" }))}>
            Try again
          </button>
        </div>
      )}
      {err && <p className="field-error">{err}</p>}
    </li>
  );
}

/**
 * Burn-for-a-Shoutout. A holder burns some of the coin and the influencer records a personal shoutout
 * (talking video, or photo with a note) for anyone they choose. The burn is the price: coins leave supply for good.
 */
export function ShoutoutsTab({ coin }: { coin: Coin }) {
  const { wallet, signIn, signingIn } = useSession();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [data, setData] = useState<ShoutoutsResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [format, setFormat] = useState<"video" | "photo">("video");
  const [recipient, setRecipient] = useState("");
  const [request, setRequest] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // Burn signatures are remembered in this browser, so a burn whose confirmation got interrupted can be checked again.
  const [sigs, setSigsState] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("reelpad.shoutoutSigs") ?? "{}");
    } catch {
      return {};
    }
  });
  const setSigs = (fn: (m: Record<string, string>) => Record<string, string>) =>
    setSigsState((m) => {
      const next = fn(m);
      try {
        localStorage.setItem("reelpad.shoutoutSigs", JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });

  const load = useCallback(
    () =>
      api<ShoutoutsResponse>(`/coins/${coin.id}/shoutouts`)
        .then((r) => {
          setData(r);
          setLoadErr(null);
        })
        .catch((e) => setLoadErr((e as Error).message)),
    [coin.id],
  );
  useEffect(() => {
    load();
  }, [load, wallet]);
  const active = data?.mine.some((s) => IN_PROGRESS.has(s.status));
  useEffect(() => {
    const id = setInterval(load, active ? 5000 : 60_000);
    return () => clearInterval(id);
  }, [active, load]);

  const pricing = data?.pricing;
  useEffect(() => {
    if (pricing && !pricing.video && format === "video") setFormat("photo");
  }, [pricing, format]);
  const price = pricing ? (format === "video" ? pricing.video : pricing.photo) : null;

  const confirm = async (id: string, signature: string) => {
    await api(`/shoutouts/${id}/confirm`, { method: "POST", json: { signature } });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setOk(null);
    let createdId: string | null = null;
    try {
      if (!wallet) await signIn();
      if (!publicKey) throw new Error("Connect your wallet first.");
      setStep("checking");
      const r = await api<{ id: string; tokens: string; transaction: string }>(`/coins/${coin.id}/shoutouts`, {
        method: "POST",
        json: { recipient, request, format, public: isPublic },
      });
      createdId = r.id;
      setStep("signing");
      const sig = await sendTransaction(decodeTx(r.transaction), connection);
      setSigs((m) => ({ ...m, [r.id]: sig }));
      setStep("confirming");
      await connection.confirmTransaction(sig, "confirmed").catch(() => {});
      await confirm(r.id, sig);
      setOk(`Burned ${r.tokens} $${coin.symbol}. ${coin.name} is recording your shoutout now. It shows up below when it's ready.`);
      setRecipient("");
      setRequest("");
    } catch (e) {
      const msg = (e as Error).message;
      if (/reject|declin|cancel/i.test(msg)) {
        setErr("You cancelled in your wallet. Nothing was burned.");
        if (createdId) api(`/shoutouts/${createdId}/cancel`, { method: "POST" }).catch(() => {});
      } else setErr(msg);
    } finally {
      setStep("idle");
      load();
    }
  };

  if (loadErr && !data) return <p className="empty-line">Shoutouts couldn't be loaded right now.</p>;
  if (!data) return <div className="shoutouts" aria-busy="true" />;

  const busy = step !== "idle" || signingIn;
  return (
    <div className="shoutouts">
      <section className="shout-order">
        <div className="shout-intro">
          <span className="shout-kicker">Burn for a shoutout</span>
          <h2>Get a personal shoutout from {coin.name}</h2>
          <p>
            Burn some ${coin.symbol} and {coin.name} records a shoutout for anyone you pick: a birthday, a win, an inside joke.
            The coins you burn are gone for good, so every shoutout makes the supply smaller.
          </p>
          {data.stats.shoutouts > 0 && (
            <p className="shout-stat">
              <strong>{data.stats.shoutouts}</strong> shoutout{data.stats.shoutouts === 1 ? "" : "s"} recorded ·{" "}
              <strong>{data.stats.tokensBurned}</strong> ${coin.symbol} burned by fans
            </p>
          )}
        </div>

        {!pricing?.enabled ? (
          <Notice tone="warn">Shoutouts are turned off right now.</Notice>
        ) : !pricing.photo ? (
          <Notice tone="warn">Couldn't get the coin's price right now, so shoutouts can't be priced. Try again in a minute.</Notice>
        ) : (
          <form className="shout-form" onSubmit={submit}>
            <fieldset className="shout-formats">
              <legend>What kind</legend>
              {(["video", "photo"] as const).map((f) => {
                const p = f === "video" ? pricing.video : pricing.photo;
                if (!p) return null;
                return (
                  <label key={f} className={format === f ? "shout-kind on" : "shout-kind"}>
                    <input type="radio" name="format" value={f} checked={format === f} onChange={() => setFormat(f)} />
                    <span className="shout-kind-name">{f === "video" ? "Talking video" : "Photo + note"}</span>
                    <span className="shout-kind-desc">
                      {f === "video" ? `${coin.name} says it to camera, with sound` : `A photo of ${coin.name} with a written message`}
                    </span>
                    <span className="shout-kind-price">
                      {p.tokens} ${coin.symbol}
                      <small> ≈ {p.sol} SOL</small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <label className="shout-field">
              <span>Who's it for</span>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.slice(0, RECIPIENT_MAX))}
                placeholder="A name or @handle"
                maxLength={RECIPIENT_MAX}
                required
              />
            </label>
            <label className="shout-field">
              <span>What's it for</span>
              <textarea
                value={request}
                onChange={(e) => setRequest(e.target.value.slice(0, REQUEST_MAX))}
                placeholder={`e.g. My brother Sam turns 21 on Friday. He's obsessed with skateboarding and never lands a kickflip.`}
                rows={3}
                maxLength={REQUEST_MAX}
                required
              />
              <small className="muted">{REQUEST_MAX - request.length} characters left</small>
            </label>
            <label className="shout-check">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              Show it on {coin.name}'s shoutout wall (it can always be shared by link)
            </label>
            <button className="btn btn-primary shout-burn" disabled={busy || !price || recipient.trim().length < 2 || request.trim().length < 8}>
              {busy ? STEP_TEXT[step] || "Check your wallet…" : `Burn ${price?.tokens ?? ""} $${coin.symbol} for a shoutout`}
            </button>
            <p className="poll-foot">
              Your request is checked before anything is burned. If {coin.name} can't make it, nothing leaves your wallet.
              {!wallet && " Connect your wallet to start."}
            </p>
            {err && <p className="field-error">{err}</p>}
            {ok && <Notice tone="ok">{ok}</Notice>}
          </form>
        )}
      </section>

      {data.mine.length > 0 && (
        <section>
          <h3 className="sub">Your shoutouts</h3>
          <ul className="shout-mine-list">
            {data.mine.map((s) => (
              <MyShoutout key={s.id} s={s} coin={coin} onChange={load} pendingSig={sigs[s.id]} onConfirm={confirm} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="sub">Shoutout wall</h3>
        {data.wall.length === 0 ? (
          <p className="empty-line">No shoutouts yet. Be the first.</p>
        ) : (
          <div className="shout-wall">
            {data.wall.map((s) => (
              <Link key={s.id} to={`/shoutout/${s.id}`} className="shout-tile">
                <div className={`shout-tile-media ${s.format}`}>
                  {s.media.find((m) => m.type === "image") && <img src={s.media.find((m) => m.type === "image")!.url} alt="" loading="lazy" />}
                  {s.format === "video" && <span className="post-format">Video</span>}
                </div>
                <div className="shout-tile-body">
                  <strong>For {s.recipient}</strong>
                  {s.note && <p>{s.note}</p>}
                  <small>
                    {s.tokensBurned} ${coin.symbol} burned by {s.fan}
                  </small>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
