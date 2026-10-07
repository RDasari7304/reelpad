import { useEffect, useState } from "react";
import { api } from "../api";
import { Notice } from "../components";
import { AdminCoins } from "../AdminCoins";
import { useSession } from "../session";

interface Overview {
  killSwitch: { content: boolean; treasury: boolean; launches: boolean };
  aiSpendToday: number;
  aiBudget: number;
  treasuryDryRun: boolean;
  tiktokAccessMode: "testers" | "open";
  coins: Array<{ status: string; n: number }>;
  posts24h: Array<{ status: string; n: number }>;
  failedJobs24h: Array<{ type: string; n: number }>;
  recentFailures: Array<{ id: string; type: string; last_error: string; updated_at: string }>;
}

const SWITCHES: Array<[keyof Overview["killSwitch"], string, string]> = [
  ["launches", "Launches", "Stop new coins from being created."],
  ["content", "Posting", "Stop every influencer from planning or publishing posts."],
  ["treasury", "Treasury trading", "Stop every agent from buying or burning."],
];

export default function Admin() {
  const { isAdmin } = useSession();
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api<Overview>("/admin/overview").then(setO).catch((e) => setErr(e.message));
  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  if (!isAdmin) return <div className="page narrow"><h1>Admin</h1><p>Sign in with an admin wallet.</p></div>;
  if (err) return <div className="page narrow"><Notice tone="error">{err}</Notice></div>;
  if (!o) return <div className="page" aria-busy="true" />;

  const toggle = async (k: keyof Overview["killSwitch"]) => {
    await api("/admin/kill-switch", { method: "POST", json: { [k]: !o.killSwitch[k] } });
    load();
  };

  return (
    <div className="page admin">
      <h1>Admin</h1>
      <h2 className="sub-section">Emergency stops</h2>
      {SWITCHES.map(([k, label, hint]) => (
        <label className="switch" key={k}>
          <input type="checkbox" checked={o.killSwitch[k]} onChange={() => toggle(k)} />
          <span>
            <strong>
              {label}: {o.killSwitch[k] ? "stopped" : "running"}
            </strong>
            <small>{hint}</small>
          </span>
        </label>
      ))}
      <h2 className="sub-section">Coins and TikTok access</h2>
      <AdminCoins />
      <h2 className="sub-section">Today</h2>
      <dl className="treasury-figures">
        <div>
          <dt>AI spend</dt>
          <dd>
            ${o.aiSpendToday.toFixed(2)} of ${o.aiBudget}
          </dd>
        </div>
        <div>
          <dt>Treasury mode</dt>
          <dd>{o.treasuryDryRun ? "Simulation" : "Live trading"}</dd>
        </div>
        {o.coins.map((c) => (
          <div key={c.status}>
            <dt>Coins {c.status}</dt>
            <dd>{c.n}</dd>
          </div>
        ))}
        {o.posts24h.map((p) => (
          <div key={p.status}>
            <dt>Posts {p.status} (24h)</dt>
            <dd>{p.n}</dd>
          </div>
        ))}
      </dl>
      <h2 className="sub-section">Recent job failures</h2>
      {o.recentFailures.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="ledger">
          {o.recentFailures.map((f) => (
            <li key={f.id} className="ledger-failed">
              <time>{new Date(f.updated_at).toLocaleString()}</time>
              <span className="ledger-kind">{f.type}</span>
              <span className="ledger-reason">{f.last_error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
