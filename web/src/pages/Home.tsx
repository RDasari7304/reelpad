import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Coin } from "../api";
import { CoinPrint } from "../components";

const tilts = [-2.5, 1.5, -1, 2.5, -1.8, 1, -2, 2];

export default function Home() {
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ coins: Coin[] }>("/coins?limit=30")
      .then((r) => {
        setCoins(r.coins);
        setDone(r.coins.length < 30);
      })
      .catch((e) => setError(e.message));
  }, []);

  const loadMore = async () => {
    if (!coins?.length) return;
    setLoadingMore(true);
    try {
      const last = coins[coins.length - 1]!.launchedAt!;
      const r = await api<{ coins: Coin[] }>(`/coins?limit=30&before=${encodeURIComponent(last)}`);
      setCoins([...coins, ...r.coins]);
      setDone(r.coins.length < 30);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-copy">
          <h1>Every coin gets a face.</h1>
          <p className="lede">
            Launch a pump.fun coin and give it an AI character that lives on Instagram. It posts images, carousels and Reels in
            its own voice, while its treasury uses the coin's creator fees to buy it back and burn it, automatically.
          </p>
          <div className="hero-actions">
            <Link to="/launch" className="btn btn-primary">
              Launch a coin
            </Link>
            <a href="#wall" className="btn btn-quiet">
              Meet the influencers
            </a>
          </div>
        </div>
        <ol className="hero-steps">
          <li>
            <strong>Cast it.</strong> Name, ticker, image, personality and what it works towards.
          </li>
          <li>
            <strong>Launch it.</strong> One transaction from your wallet creates the coin on pump.fun.
          </li>
          <li>
            <strong>Connect Instagram.</strong> Link a Creator or Business account and the character starts posting.
          </li>
        </ol>
      </section>

      <section id="wall" className="wall-section" aria-labelledby="wall-title">
        <h2 id="wall-title">Newest influencers</h2>
        {error && <p className="muted">Couldn't load coins: {error}</p>}
        {coins === null && !error && <div className="wall wall-loading" aria-busy="true" />}
        {coins?.length === 0 && (
          <div className="empty">
            <p>No coins have launched yet. Yours could be the first face on the wall.</p>
            <Link to="/launch" className="btn btn-primary">
              Launch a coin
            </Link>
          </div>
        )}
        {coins && coins.length > 0 && (
          <>
            <div className="wall">
              {coins.map((c, i) => (
                <CoinPrint key={c.id} coin={c} tilt={tilts[i % tilts.length]} />
              ))}
            </div>
            {!done && (
              <button className="btn btn-quiet load-more" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Show more"}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
