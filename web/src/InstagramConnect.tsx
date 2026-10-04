import { useState, type FormEvent, type ReactNode } from "react";
import { api, normalizeInstagramUsername, type Coin, type InstagramAccess } from "./api";
import { useSession } from "./session";

/**
 * The "connect Instagram" card on a coin page.
 *
 * Open mode (after Meta approval): one button straight to Instagram's login.
 * Tester mode (before approval): username → waiting to be added → accept invite → log in.
 */
export function InstagramConnect({ coin, launched, onChange }: { coin: Coin; launched: boolean; onChange: (c: Coin) => void }) {
  const { config } = useSession();
  const access = coin.instagramAccess ?? null;
  const expired = coin.instagram?.status === "expired";
  const connectHref = `/api/instagram/connect?coinId=${coin.id}`;
  const title = launched ? `${coin.name} is live and posting on Reelpad. Take it to Instagram too?` : `Take ${coin.name} to Instagram (optional)`;

  const setupSteps = (
    <p>
      {coin.name} already posts here on Reelpad. Connect an Instagram account and everything it posts also goes to Instagram,
      more often, where it answers comments and grows a real following. Create an account for {coin.name} and switch it to a
      Creator or Business account (in Instagram: Settings, then Account type and tools).
    </p>
  );

  // Already connected once (expired) or open mode: just log in.
  if (config?.igAccessMode !== "testers" || expired || access?.status === "connected") {
    return (
      <section className="connect-card">
        <div>
          <h2>{title}</h2>
          {expired ? <p className="field-error">The connection expired. Log in again to resume posting.</p> : setupSteps}
        </div>
        <a className="btn btn-primary" href={connectHref}>
          Log in with Instagram
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
              Instagram requires each account to be approved for this site while it's in early access. This usually takes
              under a day. Check back here; the next step appears when it's ready.
            </p>
          )}
        </Step>
        <Step n={3} state={access?.status === "invited" ? "current" : "todo"} title="Accept the invite and log in">
          {access?.status === "invited" && (
            <>
              <p>
                On the Instagram <strong>website</strong> (not the app), logged in as @{access.username}, open{" "}
                <a href="https://www.instagram.com/accounts/manage_access/" target="_blank" rel="noreferrer">
                  Settings, then Apps and websites, then Tester invites
                </a>
                , and accept the invite. Then come back and log in.
              </p>
              <a className="btn btn-primary" href={connectHref}>
                Log in with Instagram
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

function UsernameForm({ coin, access, onChange }: { coin: Coin; access: InstagramAccess | null; onChange: (c: Coin) => void }) {
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
    const username = normalizeInstagramUsername(value);
    if (!username) return setError("Instagram usernames use letters, numbers, periods and underscores (max 30).");
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ instagramAccess: InstagramAccess }>(`/coins/${coin.id}/instagram-access`, {
        method: "PUT",
        json: { username },
      });
      onChange({ ...coin, instagramAccess: r.instagramAccess });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="username-form" onSubmit={submit}>
      <label className="sr-only" htmlFor={`ig-${coin.id}`}>
        Instagram username
      </label>
      <span className="at" aria-hidden>
        @
      </span>
      <input
        id={`ig-${coin.id}`}
        className="input"
        value={value}
        maxLength={31}
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
