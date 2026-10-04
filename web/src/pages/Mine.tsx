import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Coin } from "../api";
import { Notice } from "../components";
import { signAndLaunch } from "../launchTx";
import { useSession } from "../session";

const STATUS: Record<Coin["status"], string> = {
  draft: "Not launched",
  awaiting_signature: "Waiting for your signature",
  launching: "Launching",
  live: "Live",
  failed: "Launch failed",
};

export default function Mine() {
  const { wallet, signIn, signingIn } = useSession();
  const { signTransaction, publicKey } = useWallet();
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api<{ coins: Coin[] }>("/coins/mine").then((r) => setCoins(r.coins)).catch((e) => setError(e.message));
  useEffect(() => {
    if (wallet) load();
  }, [wallet]);

  if (!wallet) {
    return (
      <div className="page narrow">
        <h1>My coins</h1>
        <p className="lede">Sign in with the wallet you launched from to manage your coins.</p>
        <button className="btn btn-primary" disabled={!publicKey || signingIn} onClick={() => signIn().catch((e) => setError(e.message))}>
          {publicKey ? "Sign in" : "Connect a wallet first"}
        </button>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    );
  }

  const finish = async (c: Coin) => {
    if (!signTransaction) return setError("This wallet can't sign transactions.");
    setBusy(c.id);
    setError(null);
    try {
      await signAndLaunch(c.id, signTransaction);
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page narrow">
      <h1>My coins</h1>
      {error && <Notice tone="error">{error}</Notice>}
      {coins?.length === 0 && (
        <div className="empty">
          <p>You haven't launched a coin yet.</p>
          <Link to="/launch" className="btn btn-primary">
            Launch a coin
          </Link>
        </div>
      )}
      <ul className="mine">
        {coins?.map((c) => (
          <li key={c.id}>
            <img src={c.imageUrl} alt="" />
            <div>
              <Link to={`/coin/${c.id}`}>
                <strong>{c.name}</strong> <span className="muted">${c.symbol}</span>
              </Link>
              <span className={`status status-${c.status}`}>{STATUS[c.status]}</span>
              {c.launchError && <small className="field-error">{c.launchError}</small>}
            </div>
            {c.status !== "live" && c.status !== "launching" && (
              <button className="btn btn-small btn-primary" disabled={busy === c.id} onClick={() => finish(c)}>
                {busy === c.id ? "Launching…" : "Finish launch"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
