import { useState, type FormEvent, type ReactNode } from "react";
import { api, normalizeTikTokUsername, type Coin, type TikTokAccess } from "./api";
import { useSession } from "./session";

/**
 * The "connect TikTok" card on a coin page.
 *
 * Open mode (after TikTok approves the app): one button straight to TikTok's login.
 * Tester mode (before approval): username → waiting to be added as a sandbox user → log in.
 */
export function TikTokConnect({ coin, launched, onChange }: { coin: Coin; launched: boolean; onChange: (c: Coin) => void }) {
  const { config } = useSession();
  const access = coin.tiktokAccess ?? null;
  const expired = coin.tiktok?.status === "expired";
  const connectHref = `/api/tiktok/connect?coinId=${coin.id}`;
  const title = launched ? `${coin.name} is live and posting on Reelpad. Take it to TikTok too?` : `Take ${coin.name} to TikTok (optional)`;

  const setupSteps = (
    <p>
      {coin.name} already posts here on Reelpad. Connect a TikTok account and everything it posts also goes to TikTok, more
      often: videos as TikToks and images as photo posts, labelled as AI-generated. Create a TikTok account for {coin.name},
      then log in with it here.
    </p>
  );

  // Already connected once (expired) or open mode: just log in.
  if (config?.tiktokAccessMode !== "testers" || expired || access?.status === "connected") {
    return (
      <section className="connect-card">
        <div>
          <h2>{title}</h2>
          {expired ? <p className="field-error">The connection expired. Log in again to resume posting.</p> : setupSteps}
        </div>
        <a className="btn btn-primary" href={connectHref}>
          Log in with TikTok
        </a>
      </section>
    );
  }

  return (
    <section className="connect-card connect-steps">
      <div className="connect-head">
        <h2>{title}</h2>
        {setupSteps}
      </div>
      <ol className="connect-track">
        <Step n={1} state={access ? "done" : "current"} title="Tell us the account">
          <UsernameForm coin={coin} access={access} onChange={onChange} />
        </Step>
        <Step
          n={2}
          state={!access ? "todo" : access.status === "pending" ? "current" : "done"}
          title={access?.status === "pending" ? `We're giving @${access.username} access` : "We give the account access"}
        >
          {access?.status === "pending" && (
            <p>
              TikTok requires each account to be approved for this site while it's in early access. This usually takes under a
              day. Check back here; the next step appears when it's ready.
            </p>
          )}
        </Step>
        <Step n={3} state={access?.status === "invited" ? "current" : "todo"} title="Log in with TikTok">
          {access?.status === "invited" && (
            <>
              <p>
                @{access.username} has access. Log in to TikTok as @{access.username} and allow Reelpad to post for you.
              </p>
              <a className="btn btn-primary" href={connectHref}>
                Log in with TikTok
              </a>
            </>
          )}
        </Step>
      </ol>
    </section>
  );
}

function Step({ n, state, title, children }: { n: number; state: "done" | "current" | "todo"; title: string; children?: ReactNode }) {
  return (
    <li className={`connect-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
      <span className="connect-n" aria-hidden>
        {state === "done" ? "✓" : n}
      </span>
      <div>
        <strong>{title}</strong>
        {state !== "todo" && children}
      </div>
    </li>
  );
}

function UsernameForm({ coin, access, onChange }: { coin: Coin; access: TikTokAccess | null; onChange: (c: Coin) => void }) {
  const [editing, setEditing] = useState(!access);
  const [value, setValue] = useState(access?.username ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!editing && access) {
    return (
      <p>
        @{access.username}{" "}
        <button type="button" className="link-btn" onClick={() => setEditing(true)}>
          Change
        </button>
      </p>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const username = normalizeTikTokUsername(value);
    if (!username) return setError("TikTok usernames use letters, numbers, periods and underscores (2-24, not ending in a period).");
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ tiktokAccess: TikTokAccess }>(`/coins/${coin.id}/tiktok-access`, {
        method: "PUT",
        json: { username },
      });
      onChange({ ...coin, tiktokAccess: r.tiktokAccess });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="username-form" onSubmit={submit}>
      <label className="sr-only" htmlFor={`tt-${coin.id}`}>
        TikTok username
      </label>
      <span className="at" aria-hidden>
        @
      </span>
      <input
        id={`tt-${coin.id}`}
        className="input"
        value={value}
        maxLength={25}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="mooncat.coin"
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="btn btn-small btn-primary" disabled={busy || !value.trim()}>
        {access ? "Save" : "Request access"}
      </button>
      {error && <span className="field-error">{error}</span>}
    </form>
  );
}
