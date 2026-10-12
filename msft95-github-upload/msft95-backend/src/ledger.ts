import type { Tx } from "./db.js";
import { AppError } from "./errors.js";

export type AccountKind = "user" | "pending" | "house" | "deposits_in" | "bankroll_in" | "paid_out" | "swept_out";
export interface Leg { account: string; amount: bigint }

export class DuplicateEntry extends Error {}

/** id of an account, created on first use */
export async function account(c: Tx, kind: AccountKind, token: string, userId?: string): Promise<string> {
  token = token.toLowerCase();
  if (kind === "user") {
    if (!userId) throw new Error("user account needs a user");
    await c.query("INSERT INTO accounts(kind,user_id,token) VALUES ('user',$1,$2) ON CONFLICT (user_id, token) WHERE kind='user' DO NOTHING", [userId, token]);
    return (await c.query("SELECT id FROM accounts WHERE kind='user' AND user_id=$1 AND token=$2", [userId, token])).rows[0].id;
  }
  await c.query("INSERT INTO accounts(kind,token) VALUES ($1,$2) ON CONFLICT (kind, token) WHERE kind<>'user' DO NOTHING", [kind, token]);
  return (await c.query("SELECT id FROM accounts WHERE kind=$1 AND token=$2 AND user_id IS NULL", [kind, token])).rows[0].id;
}

/** Serialises everything that touches one player's money: call first in every money-moving transaction. */
export async function lockUser(c: Tx, userId: string): Promise<void> {
  const r = await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
  if (!r.rowCount) throw new AppError(404, "no_user", "unknown user");
}

export async function balance(c: Tx, accountId: string): Promise<bigint> {
  const r = await c.query("SELECT balance FROM accounts WHERE id=$1", [accountId]);
  return BigInt(r.rows[0]?.balance ?? 0);
}

/**
 * Book one balanced journal entry. Legs must sum to zero. The (kind, ref) pair is unique, so the same
 * real-world event can never be booked twice (throws DuplicateEntry). Player and pending balances can't go
 * negative (enforced by a CHECK constraint, surfaced as insufficient_funds).
 */
export async function post(c: Tx, kind: string, ref: string, legs: Leg[]): Promise<string | null> {
  const merged = new Map<string, bigint>();
  for (const l of legs) merged.set(l.account, (merged.get(l.account) ?? 0n) + l.amount);
  const list = [...merged].filter(([, a]) => a !== 0n).sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
  if (list.reduce((s, [, a]) => s + a, 0n) !== 0n) throw new Error("unbalanced journal entry");
  if (!list.length) return null;
  await c.query("SAVEPOINT post_entry");
  try {
    const j = await c.query("INSERT INTO journal(kind, ref) VALUES ($1,$2) RETURNING id", [kind, ref]);
    const jid: string = j.rows[0].id;
    for (const [acct, amt] of list) {
      await c.query("UPDATE accounts SET balance = balance + $2 WHERE id=$1", [acct, amt.toString()]);
      await c.query("INSERT INTO postings(journal_id, account_id, amount) VALUES ($1,$2,$3)", [jid, acct, amt.toString()]);
    }
    await c.query("RELEASE SAVEPOINT post_entry");
    return jid;
  } catch (e: any) {
    await c.query("ROLLBACK TO SAVEPOINT post_entry");
    if (e?.code === "23505" && /journal_kind_ref_key/.test(e?.constraint ?? e?.message ?? "")) throw new DuplicateEntry(`${kind}:${ref}`);
    if (e?.code === "23514") throw new AppError(402, "insufficient_funds", "Not enough balance.");
    throw e;
  }
}

/** Every journal entry sums to zero and stored balances equal the sum of their postings. Returns problems found. */
export async function checkIntegrity(c: Tx | import("pg").Pool): Promise<string[]> {
  const problems: string[] = [];
  const unbalanced = await c.query("SELECT journal_id FROM postings GROUP BY journal_id HAVING sum(amount) <> 0 LIMIT 5");
  for (const r of unbalanced.rows) problems.push("unbalanced journal " + r.journal_id);
  const drift = await c.query(`SELECT a.id, a.balance, COALESCE(sum(p.amount),0) AS s FROM accounts a LEFT JOIN postings p ON p.account_id=a.id
                               GROUP BY a.id HAVING a.balance <> COALESCE(sum(p.amount),0) LIMIT 5`);
  for (const r of drift.rows) problems.push(`account ${r.id} balance ${r.balance} != postings ${r.s}`);
  return problems;
}
