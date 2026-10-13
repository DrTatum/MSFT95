import crypto from "node:crypto";
import type { Config } from "./config.js";
import { tx, type Db } from "./db.js";
import { AppError, bad } from "./errors.js";
import { account, lockUser, post } from "./ledger.js";
import { flag, setFlag } from "./flags.js";
import { vaultLimits, type Chain, type VaultTokenLimits, type VoucherSigner, type Voucher } from "./chain.js";
import { safeBlock } from "./indexer.js";

const MAX_OPEN = 3;
const limitCache = new Map<string, { at: number; v: VaultTokenLimits }>();
async function limits(ch: Chain, token: string) {
  const hit = limitCache.get(token);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = await vaultLimits(ch, token); limitCache.set(token, { at: Date.now(), v }); return v;
}

export interface Signers { signer: VoucherSigner; cosigner?: VoucherSigner }

export async function requestWithdrawal(db: Db, cfg: Config, ch: Chain, s: Signers, userId: string, tokenIn: string, amountIn: string) {
  const token = String(tokenIn).toLowerCase();
  const t = cfg.tokens.get(token); if (!t) throw bad("bad_token", "That token isn't accepted.");
  const amount = BigInt(amountIn);
  if (amount < BigInt(t.minWithdrawal)) throw bad("too_small", `Minimum withdrawal is ${t.minWithdrawal}.`);
  if (await flag(db, "withdrawals_frozen")) throw new AppError(503, "withdrawals_frozen", "Withdrawals are paused while we check something. Your balance is safe.");
  const lim = await limits(ch, token);
  if (!lim.listed) throw bad("bad_token", "That token can't be withdrawn right now.");
  if (amount > lim.maxWithdrawal) throw bad("too_big", `The most you can withdraw at once is ${lim.maxWithdrawal}.`);
  const needCosign = amount > lim.cosignAbove;
  // vouchers are only valid for the vault's current epoch (bumped when vouchers are voided or a key is revoked)
  const epoch: bigint = await ch.vault.getFunction("voucherEpoch")();
  if (needCosign && !s.cosigner) throw new AppError(503, "cosigner_unavailable", "Large withdrawals are temporarily unavailable.");

  return tx(db, async (c) => {
    await lockUser(c, userId);
    if (await flag(c, "withdrawals_frozen")) throw new AppError(503, "withdrawals_frozen", "Withdrawals are paused while we check something. Your balance is safe.");
    const u = (await c.query("SELECT address FROM users WHERE id=$1", [userId])).rows[0];
    const open = await c.query("SELECT count(*)::int AS n FROM withdrawals WHERE user_id=$1 AND status='signed'", [userId]);
    if (open.rows[0].n >= MAX_OPEN) throw bad("too_many_open", "You have withdrawals waiting. Submit or let them expire first.");
    const day = await c.query("SELECT COALESCE(sum(amount),0) AS s FROM withdrawals WHERE user_id=$1 AND token=$2 AND status<>'refunded' AND created_at > now() - interval '24 hours'", [userId, token]);
    if (BigInt(day.rows[0].s) + amount > BigInt(t.userDailyWithdrawal)) throw bad("daily_limit", "That's over your 24-hour withdrawal limit for this token.");

    // random 128-bit nonce: nobody (not even someone holding a stolen signer key) can pre-burn the nonce of a future voucher
    let nonce = BigInt("0x" + crypto.randomBytes(16).toString("hex"));
    while ((await c.query("SELECT 1 FROM withdrawals WHERE user_id=$1 AND nonce=$2", [userId, nonce.toString()])).rowCount) nonce = BigInt("0x" + crypto.randomBytes(16).toString("hex"));
    const issuedAt = BigInt(Math.floor(Date.now() / 1000));
    const deadline = issuedAt + BigInt(cfg.WITHDRAWAL_TTL_SEC);   // vault v2 rejects deadline - issuedAt > 24h
    const ins = await c.query("INSERT INTO withdrawals(user_id, token, amount, nonce, epoch, issued_at, deadline, status, signatures) VALUES ($1,$2,$3,$4,$5,$6,$7,'signed','[]') RETURNING id",
      [userId, token, amount.toString(), nonce.toString(), epoch.toString(), issuedAt.toString(), deadline.toString()]);
    const id: string = ins.rows[0].id;
    // move the money out of the playable balance first; fails cleanly if the balance is too low
    await post(c, "withdrawal", id, [{ account: await account(c, "user", token, userId), amount: -amount }, { account: await account(c, "pending", token), amount }]);

    const v: Voucher = { user: u.address, token, amount, nonce, epoch, issuedAt, deadline };
    const sigs = [await s.signer.sign(ch.domain, v)];
    if (needCosign) sigs.push(await s.cosigner!.sign(ch.domain, v));
    await c.query("UPDATE withdrawals SET signatures=$2 WHERE id=$1", [id, JSON.stringify(sigs)]);
    return { id, vault: cfg.VAULT_ADDRESS, chainId: cfg.CHAIN_ID,
      voucher: { user: u.address, token, amount: amount.toString(), nonce: nonce.toString(), epoch: epoch.toString(), issuedAt: issuedAt.toString(), deadline: deadline.toString() }, signatures: sigs };
  });
}

/**
 * Refund vouchers that can never be used, once a confirmed block proves it and the vault says the nonce was not used as
 * of that block:
 *  - expired: the block is strictly past the deadline (the vault treats timestamp >= deadline as expired, and block
 *    timestamps only go up, so no later block can include the voucher); or
 *  - voided: the vault's voucherEpoch at that block is above the voucher's epoch (the epoch only ever goes up).
 */
export async function expireWithdrawals(db: Db, cfg: Config, ch: Chain, log: (m: string) => void = () => {}) {
  const b = await safeBlock(cfg, ch);
  const epochNow: bigint = await ch.vault.getFunction("voucherEpoch")({ blockTag: b.number });
  const due = await db.query(`SELECT w.*, u.address FROM withdrawals w JOIN users u ON u.id=w.user_id
    WHERE w.status='signed' AND (w.deadline < $1 OR w.epoch < $2)`, [b.timestamp, epochNow.toString()]);   // strictly past, or voided
  let refunded = 0;
  for (const w of due.rows) {
    const used: boolean = await ch.vault.getFunction("nonceUsed")(w.address, w.nonce, { blockTag: b.number });
    if (used) {
      // normally the indexer books the payout. If the indexer is already past this block and the row is still open,
      // the nonce was consumed by a voucher we did not issue: park it for a human instead of leaving it stuck.
      const cur = await db.query("SELECT last_block FROM chain_cursor WHERE name='vault'");
      if (cur.rowCount && Number(cur.rows[0].last_block) >= b.number) {
        await db.query("UPDATE withdrawals SET status='review' WHERE id=$1 AND status='signed'", [w.id]);
        await setFlag(db, "withdrawals_frozen", true, `review: withdrawal ${w.id} nonce used by a voucher we did not issue`);
        log(`ALERT withdrawal ${w.id} needs review: nonce used on-chain but no matching payout was booked`);
      }
      continue;
    }
    await tx(db, async (c) => {
      await lockUser(c, w.user_id);
      const r = await c.query("SELECT status FROM withdrawals WHERE id=$1 FOR UPDATE", [w.id]);
      if (r.rows[0].status !== "signed") return;
      await post(c, "withdrawal_refund", w.id, [{ account: await account(c, "pending", w.token), amount: -BigInt(w.amount) }, { account: await account(c, "user", w.token, w.user_id), amount: BigInt(w.amount) }]);
      await c.query("UPDATE withdrawals SET status='refunded', settled_at=now() WHERE id=$1", [w.id]);
      refunded++;
      log(`refunded expired withdrawal ${w.id}`);
    });
  }
  return refunded;
}

export async function listWithdrawals(db: Db, userId: string) {
  const r = await db.query("SELECT id, token, amount, nonce, epoch, issued_at, deadline, status, signatures, created_at, settled_at, tx_hash FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 50", [userId]);
  return r.rows;
}
