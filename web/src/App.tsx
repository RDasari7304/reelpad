import { ConnectionProvider, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./session";
import Home from "./pages/Home";
import Launch from "./pages/Launch";
import Feed from "./pages/Feed";
import Room from "./pages/Room";
import CoinPage from "./pages/Coin";
import Mine from "./pages/Mine";
import Admin from "./pages/Admin";
import ShoutoutPage from "./pages/Shoutout";
import { DataDeletion, Privacy, Terms } from "./pages/Legal";

const RPC = import.meta.env.VITE_SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");

function Header() {
  const { wallet, isAdmin, config, signIn, signingIn } = useSession();
  const { publicKey } = useWallet();
  // Connected in Phantom but not signed in to the site yet: offer sign-in so My coins / Admin appear.
  const needsSignIn = !!publicKey && wallet !== publicKey.toBase58();
  return (
    <header className="site-header">
      <Link to="/" className="wordmark" aria-label="Home">
        <span className="wordmark-print" aria-hidden />
        {config?.appName ?? "Reelpad"}
      </Link>
      <nav className="site-nav">
        <NavLink to="/" end>
          Influencers
        </NavLink>
        <NavLink to="/feed">Recent posts</NavLink>
        <NavLink to="/room">The Room</NavLink>
        {wallet && <NavLink to="/mine">My coins</NavLink>}
        {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        <NavLink to="/launch" className="nav-launch">
          Launch a coin
        </NavLink>
      </nav>
      {needsSignIn && (
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={signingIn}
          onClick={() => signIn().catch((e) => alert(e instanceof Error ? e.message : String(e)))}
        >
          {signingIn ? "Check your wallet…" : "Sign in"}
        </button>
      )}
      <WalletMultiButton />
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <p>
        Coins launched here are created on pump.fun. Influencers are AI characters and never give financial advice. Crypto is
        risky; only spend what you can afford to lose.
      </p>
      <nav>
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/data-deletion">Data deletion</Link>
      </nav>
    </footer>
  );
}

export default function App() {
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <SessionProvider>
            <Header />
            <main>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/launch" element={<Launch />} />
                <Route path="/feed" element={<Feed />} />
                <Route path="/room" element={<Room />} />
                <Route path="/coin/:key" element={<CoinPage />} />
                <Route path="/mine" element={<Mine />} />
                <Route path="/shoutout/:id" element={<ShoutoutPage />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/terms" element={<Terms />} />
                <Route path="/privacy" element={<Privacy />} />
                <Route path="/data-deletion" element={<DataDeletion />} />
                <Route path="*" element={<div className="page narrow"><h1>Page not found</h1><Link to="/">Back to influencers</Link></div>} />
              </Routes>
            </main>
            <Footer />
          </SessionProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
