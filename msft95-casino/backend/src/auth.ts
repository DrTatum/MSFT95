/*
  Sign-In With Ethereum (EIP-4361). The player's wallet signs a message containing our domain, chain id and a
  one-time nonce. We check all of it, burn the nonce, and issue a random session token (only its hash is stored).
*/
import crypto from "node:crypto";
import { SiweMessage } from "siwe";
import type { Config } from "./config.js";
import { tx, type Db } from "./db.js";
import { AppError } from "./errors.js";

const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function issueNonce(db: Db): Promise<string> {
  const nonce = crypto.randomBytes(16).toString("hex");   // 32 alphanumeric chars, as SIWE requires
  await db.query("INSERT INTO auth_nonces(nonce, expires_at) VALUES ($1, now() + interval '10 minutes')", [nonce]);
  await db.query("DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 day'");
  return nonce;
}

export async function login(db: Db, cfg: Config, message: string, signature: string) {
  if (typeof message !== "string" || message.length > 2000) throw new AppError(400, "bad_message", "bad sign-in message");
  let msg: SiweMessage;
  try { msg = new SiweMessage(message); } catch { throw new AppError(400, "bad_message", "bad sign-in message"); }
  if (msg.domain !== cfg.SIWE_DOMAIN) throw new AppError(401, "wrong_domain", "This sign-in message is for another site.");
  if (new URL(msg.uri).origin !== new URL(cfg.SIWE_ORIGIN).origin) throw new AppError(401, "wrong_uri", "This sign-in message is for another site.");
  if (Number(msg.chainId) !== cfg.CHAIN_ID) throw new AppError(401, "wrong_chain", "Switch your wallet to the right network and sign again.");
  const issued = msg.issuedAt ? Date.parse(msg.issuedAt) : NaN;
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_MESSAGE_AGE_MS) throw new AppError(401, "stale_message", "Sign-in message expired. Try again.");

  try {
    await msg.verify({ signature, domain: cfg.SIWE_DOMAIN, nonce: msg.nonce, time: new Date().toISOString() });
  } catch {
    throw new AppError(401, "bad_signature", "Signature check failed.");
  }

  return tx(db, async (c) => {
    // burn the nonce: it must exist, be fresh, and never have been used
    const n = await c.query("UPDATE auth_nonces SET used_at=now() WHERE nonce=$1 AND used_at IS NULL AND expires_at > now() RETURNING nonce", [msg.nonce]);
    if (!n.rowCount) throw new AppError(401, "bad_nonce", "Sign-in link already used or expired. Try again.");
    const address = msg.address.toLowerCase();
    await c.query("INSERT INTO users(address) VALUES ($1) ON CONFLICT (address) DO NOTHING", [address]);
    const u = await c.query("SELECT id FROM users WHERE address=$1", [address]);
    const token = crypto.randomBytes(32).toString("base64url");
    await c.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))",
      [hash(token), u.rows[0].id, cfg.SESSION_TTL_HOURS]);
    return { token, userId: u.rows[0].id as string, address };
  });
}

export async function sessionUser(db: Db, token: string | undefined): Promise<{ userId: string; address: string } | null> {
  if (!token || token.length > 100) return null;
  const r = await db.query(
    `SELECT u.id, u.address FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [hash(token)]);
  return r.rows[0] ? { userId: r.rows[0].id, address: r.rows[0].address } : null;
}

export async function logout(db: Db, token: string) {
  await db.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [hash(token)]);
}
