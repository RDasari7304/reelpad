import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type AppConfig } from "./api";

interface SessionValue {
  wallet: string | null;
  isAdmin: boolean;
  config: AppConfig | null;
  signingIn: boolean;
  signIn: () => Promise<string>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, disconnect } = useWallet();
  const [wallet, setWallet] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    api<AppConfig>("/config").then((c) => {
      setConfig(c);
      document.title = c.appName;
    });
    api<{ wallet: string | null; isAdmin: boolean }>("/auth/me").then((me) => {
      setWallet(me.wallet);
      setIsAdmin(me.isAdmin);
    });
  }, []);

  // If the connected wallet changes, the old session no longer matches.
  useEffect(() => {
    if (wallet && publicKey && publicKey.toBase58() !== wallet) {
      api("/auth/logout", { method: "POST" }).finally(() => {
        setWallet(null);
        setIsAdmin(false);
      });
    }
  }, [publicKey, wallet]);

  const signIn = useCallback(async () => {
    if (!publicKey) throw new Error("Connect a wallet first");
    const address = publicKey.toBase58();
    if (wallet === address) return address;
    if (!signMessage) throw new Error("This wallet can't sign messages. Try Phantom or Solflare.");
    setSigningIn(true);
    try {
      const { nonce, message } = await api<{ nonce: string; message: string }>("/auth/nonce", {
        method: "POST",
        json: { wallet: address },
      });
      const sig = await signMessage(new TextEncoder().encode(message));
      const me = await api<{ wallet: string; isAdmin: boolean }>("/auth/verify", {
        method: "POST",
        json: { wallet: address, nonce, signature: bs58.encode(sig) },
      });
      setWallet(me.wallet);
      setIsAdmin(me.isAdmin);
      return me.wallet;
    } finally {
      setSigningIn(false);
    }
  }, [publicKey, signMessage, wallet]);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    setWallet(null);
    setIsAdmin(false);
    await disconnect().catch(() => {});
  }, [disconnect]);

  return (
    <SessionContext.Provider value={{ wallet, isAdmin, config, signingIn, signIn, signOut }}>{children}</SessionContext.Provider>
  );
}

export function useSession() {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession outside provider");
  return v;
}
