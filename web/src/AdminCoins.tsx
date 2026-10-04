import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, normalizeInstagramUsername, shortAddr } from "./api";

type AccessState = "none" | "pending" | "invited" | "connected" | "expired" | "disconnected";

interface AdminCoin {
  id: string;
  name: string;
  symbol: string;
  imageUrl: string;
  mint: string | null;
  creatorWallet: string;
  status: "draft" | "awaiting_signature" | "launching" | "live" | "failed";
  createdAt: string;
  launchedAt: string | null;
  access: { state: AccessState; username: string | null; requestedAt: string | null; invitedAt: string | null };
}

interface AdminCoinsResponse {
  accessMode: "testers" | "open";
  metaRolesUrl: string;
  testersUsed: number;
  coins: AdminCoin[];
}

const TESTER_LIMIT = 50;

const STATE_LABEL: Record<AccessState, string> = {
  none: "No username yet",
  pending: "Needs tester invite",
  invited: "Invited, waiting for creator",
  connected: "Connected",
  expired: "Connection expired",
  disconnected: "Disconnected",
};

const COIN_STATUS: Record<AdminCoin["status"], string> = {
  draft: "Not launched",
  awaiting_signature: "Not launched",
  launching: "Launching",
  live: "Live",
  failed: "Launch failed",
};

type Filter = "all" | "pending" | "invited" | "connected" | "none";
const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["pending", "Needs invite"],
  ["invited", "Invited"],
  ["connected", "Connected"],
  ["none", "No username"],
];

const ago = (iso: string | null) => {
  if (!iso) return "";
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

/** Admin: every coin created so far, with its creator and Instagram tester status. */
export function AdminCoins() {
  const [data, setData] = useState<AdminCoinsResponse | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = (q = search) =>
    api<AdminCoinsResponse>(`/admin/coins${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, pending: 0, invited: 0, connected: 0, none: 0 };
    for (const coin of data?.coins ?? []) {
      c.all++;
      if (coin.access.state in c) c[coin.access.state as Filter]++;
    }
    return c;
  }, [data]);

  if (error) return <p className="field-error">{error}</p>;
  if (!data) return <div aria-busy="true" className="loading-block" />;

  const testers = data.accessMode === "testers";
  const shown = data.coins.filter((c) => filter === "all" || c.access.state === filter);

  return (
    <div className="admin-coins">
      {testers ? (
        <p className="sub-hint">
          To give a creator access: copy their Instagram username, open{" "}
          <a href={data.metaRolesUrl} target="_blank" rel="noreferrer">
            Roles in the Meta dashboard
          </a>
          , choose Add people, pick Instagram Tester, paste the username and send the invite. Then click Mark invited here so
          the creator's coin page shows them how to accept. Testers in use: <strong>{data.testersUsed}</strong> of about{" "}
          {TESTER_LIMIT}.
        </p>
      ) : (
        <p className="sub-hint">Open mode: creators log in with Instagram directly. No tester invites needed.</p>
      )}

      <div className="admin-coins-bar">
        <div className="chips" role="tablist" aria-label="Filter coins">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? "chip on" : "chip"}
              onClick={() => setFilter(key)}
            >
              {label} <span className="chip-count">{counts[key]}</span>
            </button>
          ))}
        </div>
        <form
          className="admin-search"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <input
            className="input"
            type="search"
            placeholder="Search name, ticker, wallet or @username"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search coins"
          />
        </form>
      </div>

      {shown.length === 0 ? (
        <p className="muted">{data.coins.length === 0 ? "No coins created yet." : "Nothing matches this filter."}</p>
      ) : (
        <ul className="admin-coin-list">
          {shown.map((c) => (
            <CoinRow key={c.id} coin={c} testers={testers} onChange={() => load()} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CoinRow({ coin, testers, onChange }: { coin: AdminCoin; testers: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(coin.access.username ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const { state, username } = coin.access;

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveUsername = (e: FormEvent) => {
    e.preventDefault();
    const u = normalizeInstagramUsername(value);
    if (!u) return setError("Use letters, numbers, periods and underscores (max 30).");
    run(() => api(`/admin/coins/${coin.id}/instagram-access`, { method: "PUT", json: { username: u } })).then(() =>
      setEditing(false),
    );
  };

  const markInvited = (invited: boolean) =>
    run(() => api(`/admin/instagram-requests/${coin.id}/invited`, { method: "POST", json: { invited } }));

  return (
    <li className={`admin-coin is-${state}`}>
      <img src={coin.imageUrl} alt="" />
      <div className="admin-coin-main">
        <Link to={`/coin/${coin.id}`} className="admin-coin-name">
          {coin.name} <span>${coin.symbol}</span>
        </Link>
        <span className="admin-coin-meta">
          <span className={`status status-${coin.status}`}>{COIN_STATUS[coin.status]}</span>
          <button type="button" className="admin-wallet" onClick={() => copy(coin.creatorWallet, "wallet")} title="Copy creator wallet">
            {copied === "wallet" ? "Copied" : shortAddr(coin.creatorWallet)}
          </button>
          <span className="muted">created {ago(coin.createdAt)}</span>
        </span>
      </div>

      <div className="admin-coin-ig">
        {editing ? (
          <form className="username-form" onSubmit={saveUsername}>
            <span className="at" aria-hidden>
              @
            </span>
            <input
              className="input"
              value={value}
              maxLength={31}
              autoFocus
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              aria-label={`Instagram username for ${coin.name}`}
            />
            <button className="btn btn-small btn-primary" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn btn-small btn-quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            {username && (
              <button type="button" className="queue-user" onClick={() => copy(username, "user")} title="Copy username">
                @{username} <span>{copied === "user" ? "Copied" : "Copy"}</span>
              </button>
            )}
            <span className={`ig-state ig-state-${state}`}>
              {STATE_LABEL[state]}
              {state === "pending" && coin.access.requestedAt ? `, requested ${ago(coin.access.requestedAt)}` : ""}
              {state === "invited" && coin.access.invitedAt ? ` (${ago(coin.access.invitedAt)})` : ""}
            </span>
          </>
        )}
        {error && <span className="field-error">{error}</span>}
      </div>

      {!editing && (
        <div className="admin-coin-actions">
          {testers && state === "pending" && (
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => markInvited(true)}>
              Mark invited
            </button>
          )}
          {testers && state === "invited" && (
            <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => markInvited(false)}>
              Undo invite
            </button>
          )}
          {state !== "connected" && (
            <button
              className="btn btn-small btn-quiet"
              onClick={() => {
                setValue(username ?? "");
                setEditing(true);
              }}
            >
              {username ? "Change username" : "Add username"}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
