import { Keypair } from "@solana/web3.js";
import { config } from "../config.js";
import { decrypt, decryptString, encrypt, parseMasterKey } from "./crypto.js";

const key = parseMasterKey(config.MASTER_KEY);

export const seal = (plain: Buffer | string) => encrypt(plain, key);
export const open = (env: string) => decrypt(env, key);
export const openString = (env: string) => decryptString(env, key);

export const sealKeypair = (kp: Keypair) => seal(Buffer.from(kp.secretKey));
export const openKeypair = (env: string) => Keypair.fromSecretKey(new Uint8Array(open(env)));
