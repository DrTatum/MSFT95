/*
  Provably fair randomness, the same scheme Stake uses:
    hash_i = HMAC_SHA256(key = serverSeed, message = `${clientSeed}:${nonce}:${i}`)   (i = 0, 1, 2 …)
  Each hash gives 8 floats in [0,1): every 4 bytes b0..b3 -> b0/256 + b1/256^2 + b2/256^3 + b3/256^4.
  The player sees sha256(serverSeed) before betting, picks the clientSeed, and every bet uses the next nonce.
  When the player rotates seeds the old serverSeed is revealed, so every past result can be recomputed.
*/
import crypto from "node:crypto";
import type { Tx } from "./db.js";

export function floats(serverSeed: string, clientSeed: string, nonce: number | bigint): () => number {
  let cursor = 0, buf: Buffer | null = null, pos = 0;
  return () => {
    if (!buf || pos >= 32) {
      buf = crypto.createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}:${cursor++}`).digest();
      pos = 0;
    }
    let f = 0;
    for (let k = 0; k < 4; k++) f += buf[pos + k]! / Math.pow(256, k + 1);
    pos += 4;
    return f;
  };
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// --- server seeds are encrypted at rest so a database leak doesn't reveal future results
export function encryptSeed(seed: string, keyHex: string): string {
  const key = Buffer.from(keyHex.replace(/^0x/, ""), "hex");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(seed, "utf8"), c.final()]);
  return [iv.toString("hex"), c.getAuthTag().toString("hex"), ct.toString("hex")].join(".");
}
export function decryptSeed(enc: string, keyHex: string): string {
  const [iv, tag, ct] = enc.split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyHex.replace(/^0x/, ""), "hex"), Buffer.from(iv!, "hex"));
  d.setAuthTag(Buffer.from(tag!, "hex"));
  return Buffer.concat([d.update(Buffer.from(ct!, "hex")), d.final()]).toString("utf8");
}

export const newServerSeed = () => crypto.randomBytes(32).toString("hex");
export const newClientSeed = () => crypto.randomBytes(8).toString("hex");
export const CLIENT_SEED_RE = /^[\x21-\x7e]{1,64}$/;   // printable ASCII, no spaces or colons issues (colon is fine: it's inside the message)

export interface ActiveSeed { id: string; serverSeed: string; serverSeedHash: string; clientSeed: string; nonce: bigint }

async function create(c: Tx, userId: string, key: string, clientSeed?: string) {
  const s = newServerSeed();
  const r = await c.query(
    "INSERT INTO seeds(user_id, server_seed_enc, server_seed_hash, client_seed) VALUES ($1,$2,$3,$4) RETURNING id",
    [userId, encryptSeed(s, key), sha256(s), clientSeed ?? newClientSeed()]);
  return r.rows[0].id as string;
}

/** Locks the user's active seed pair (creating one if needed). Call inside the bet transaction. */
export async function lockSeed(c: Tx, userId: string, key: string): Promise<ActiveSeed> {
  let r = await c.query("SELECT * FROM seeds WHERE user_id=$1 AND active FOR UPDATE", [userId]);
  if (!r.rowCount) { await create(c, userId, key); r = await c.query("SELECT * FROM seeds WHERE user_id=$1 AND active FOR UPDATE", [userId]); }
  const row = r.rows[0];
  return { id: row.id, serverSeed: decryptSeed(row.server_seed_enc, key), serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: BigInt(row.nonce) };
}

/** Use the next nonce of the locked seed pair; returns the nonce the round is played with. */
export async function useNonce(c: Tx, seed: ActiveSeed): Promise<bigint> {
  await c.query("UPDATE seeds SET nonce = nonce + 1 WHERE id=$1", [seed.id]);
  return seed.nonce;
}

/** Public view of the active pair (never the server seed itself). */
export async function publicSeed(c: Tx, userId: string, key: string) {
  const s = await lockSeed(c, userId, key);
  return { serverSeedHash: s.serverSeedHash, clientSeed: s.clientSeed, nonce: s.nonce.toString() };
}

/** Retire the active pair (revealing its server seed) and start a new one with the player's client seed. */
export async function rotate(c: Tx, userId: string, key: string, clientSeed?: string) {
  const old = await lockSeed(c, userId, key);
  await c.query("UPDATE seeds SET active=false, revealed_at=now(), server_seed=$2 WHERE id=$1", [old.id, old.serverSeed]);
  await create(c, userId, key, clientSeed);
  const next = await lockSeed(c, userId, key);
  return {
    previous: { serverSeed: old.serverSeed, serverSeedHash: old.serverSeedHash, clientSeed: old.clientSeed, nonce: old.nonce.toString() },
    current: { serverSeedHash: next.serverSeedHash, clientSeed: next.clientSeed, nonce: "0" },
  };
}
