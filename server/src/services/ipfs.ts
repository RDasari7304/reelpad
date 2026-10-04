import { config } from "../config.js";

/**
 * pump.fun no longer accepts direct metadata uploads, so token image + metadata JSON go to IPFS via Pinata.
 */
async function pin(file: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("network", "public");
  form.append("file", file, filename);
  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.PINATA_JWT}` },
    body: form,
  });
  if (!res.ok) throw new Error(`IPFS upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data?: { cid?: string } };
  const cid = json.data?.cid;
  if (!cid) throw new Error("IPFS upload returned no CID");
  return `${config.IPFS_GATEWAY.replace(/\/$/, "")}/${cid}`;
}

export async function pinImage(buf: Buffer, contentType: string): Promise<string> {
  return pin(new Blob([new Uint8Array(buf)], { type: contentType }), "image.png");
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  instagram?: string;
}

export async function pinMetadata(meta: TokenMetadata): Promise<string> {
  const body = JSON.stringify({ ...meta, showName: true, createdOn: config.PUBLIC_URL });
  return pin(new Blob([body], { type: "application/json" }), "metadata.json");
}
