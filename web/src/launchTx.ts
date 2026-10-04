import { VersionedTransaction } from "@solana/web3.js";
import { api } from "./api";

const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Builds the launch transaction on the server, has the wallet sign it, and submits it. */
export async function signAndLaunch(
  coinId: string,
  signTransaction: <T extends VersionedTransaction>(tx: T) => Promise<T>,
  onStage?: (s: "building" | "signing" | "confirming") => void,
) {
  onStage?.("building");
  const { transaction } = await api<{ transaction: string }>(`/coins/${coinId}/launch-tx`, { method: "POST" });
  onStage?.("signing");
  const signed = await signTransaction(VersionedTransaction.deserialize(fromB64(transaction)));
  onStage?.("confirming");
  return api<{ signature: string; mint: string }>(`/coins/${coinId}/submit`, {
    method: "POST",
    json: { transaction: toB64(signed.serialize()) },
  });
}

export const decodeTx = (b64: string) => VersionedTransaction.deserialize(fromB64(b64));
