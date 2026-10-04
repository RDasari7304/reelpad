import { useEffect, useState } from "react";
import { api } from "./api";

interface Request {
  coinId: string;
  username: string;
  status: "pending" | "invited";
  requestedAt: string;
  invitedAt: string | null;
  coin: { name: string; symbol: string; imageUrl: string; status: string };
}

const ago = (iso: string) => {
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

/** Admin: Instagram accounts waiting to be added as testers in the Meta dashboard. */
export function TesterQueue() {
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ requests: Request[] }>("/admin/instagram-requests")
      .then((r) => setRequests(r.requests))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const mark = async (r: Request, invited: boolean) => {
    setBusy(r.coinId);
    try {
      await api(`/admin/instagram-requests/${r.coinId}/invited`, { method: "POST", json: { invited } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copy = (u: string) => {
    navigator.clipboard.writeText(u);
    setCopied(u);
    setTimeout(() => setCopied(null), 1200);
  };

  if (error) return <p className="field-error">{error}</p>;
  if (!requests) return <div aria-busy="true" className="loading-block" />;

  const pending = requests.filter((r) => r.status === "pending");
  const invited = requests.filter((r) => r.status === "invited");

  return (
    <div className="tester-queue">
      <p className="sub-hint">
        For each account: in the{" "}
        <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">
          Meta developer dashboard
        </a>
        , open your app, go to App roles, then Roles, choose Add people, pick Instagram Tester, paste the username and send the
        invite. Then mark it invited here so the creator sees the next step.
      </p>
      {pending.length === 0 && <p className="muted">No accounts waiting.</p>}
      <ul className="queue">
        {pending.map((r) => (
          <li key={r.coinId}>
            <img src={r.coin.imageUrl} alt="" />
            <div className="queue-main">
              <button type="button" className="queue-user" onClick={() => copy(r.username)} title="Copy username">
                @{r.username} <span>{copied === r.username ? "Copied" : "Copy"}</span>
              </button>
              <small className="muted">
                {r.coin.name} ${r.coin.symbol} · requested {ago(r.requestedAt)}
              </small>
            </div>
            <button className="btn btn-small btn-primary" disabled={busy === r.coinId} onClick={() => mark(r, true)}>
              Mark invited
            </button>
          </li>
        ))}
      </ul>
      {invited.length > 0 && (
        <>
          <h3 className="sub">Invited, not connected yet</h3>
          <p className="sub-hint">The creator still needs to accept the invite on Instagram and log in.</p>
          <ul className="queue">
            {invited.map((r) => (
              <li key={r.coinId}>
                <img src={r.coin.imageUrl} alt="" />
                <div className="queue-main">
                  <span className="queue-user">@{r.username}</span>
                  <small className="muted">
                    {r.coin.name} ${r.coin.symbol} · invited {r.invitedAt ? ago(r.invitedAt) : ""}
                  </small>
                </div>
                <button className="btn btn-small btn-quiet" disabled={busy === r.coinId} onClick={() => mark(r, false)}>
                  Move back to waiting
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
