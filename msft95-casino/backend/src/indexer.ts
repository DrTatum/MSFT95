/*
  Reads vault events once they are CONFIRMATIONS blocks deep and books them in the ledger exactly once
  (chain_events primary key + journal (kind, ref) uniqueness make re-processing harmless).
*/
import { ethers } from "ethers";
import type { Config } from "./config.js";
import { tx, type Db, type Tx } from "./db.js";
import { account, post } from "./ledger.js";
import { setFlag } from "./flags.js";
import type { Chain } from "./chain.js";

const CURSOR = "vault";
const MAX_RANGE = 2000;

export interface IndexResult { from: number; to: number; booked: number }

async function userIdFor(c: Tx, address: string): Promise<string> {
  const a = address.toLowerCase();
  await c.query("INSERT INTO users(address) VALUES ($1) ON CONFLICT (address) DO NOTHING", [a]);
  return (await c.query("SELECT id FROM users WHERE address=$1", [a])).rows[0].id;
}

export async function indexOnce(db: Db, cfg: Config, ch: Chain, log: (m: string) => void = () => {}): Promise<IndexResult | null> {
  const head = await headBlock(ch);
  const safe = head - cfg.CONFIRMATIONS;
  const cur = await db.query("SELECT last_block FROM chain_cursor WHERE name=$1", [CURSOR]);
  const last = cur.rowCount ? Number(cur.rows[0].last_block) : cfg.START_BLOCK - 1;
  if (safe <= last) return null;
  const from = last + 1, to = Math.min(safe, last + MAX_RANGE);
  const topics = ["Deposited", "BankrollFunded", "Withdrawn", "HouseWithdrawal"].map((n) => ch.iface.getEvent(n)!.topicHash);
  const logs = await ch.provider.getLogs({ address: cfg.VAULT_ADDRESS, fromBlock: from, toBlock: to, topics: [topics] });
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

  let booked = 0;
  await tx(db, async (c) => {
    for (const l of logs) {
      const ev = ch.iface.parseLog({ topics: l.topics as string[], data: l.data });
      if (!ev) continue;
      const data: Record<string, string> = {};
      ev.fragment.inputs.forEach((inp, i) => { const v = ev.args[i]; data[inp.name] = typeof v === "bigint" ? v.toString() : String(v).toLowerCase(); });
      const ins = await c.query(
        "INSERT INTO chain_events(chain_id, tx_hash, log_index, block_number, event, data) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING 1",
        [cfg.CHAIN_ID, l.transactionHash, l.index, l.blockNumber, ev.name, JSON.stringify(data)]);
      if (!ins.rowCount) continue;   // already booked
      const key = `${cfg.CHAIN_ID}:${l.transactionHash}:${l.index}`;
      const token = data.token!, amount = BigInt(data.amount!);
      booked++;
      if (ev.name === "Deposited") {
        const uid = await userIdFor(c, data.user!);
        await post(c, "deposit", key, [{ account: await account(c, "user", token, uid), amount }, { account: await account(c, "deposits_in", token), amount: -amount }]);
        log(`deposit ${amount} of ${token} for ${data.user}`);
      } else if (ev.name === "BankrollFunded") {
        await post(c, "bankroll", key, [{ account: await account(c, "house", token), amount }, { account: await account(c, "bankroll_in", token), amount: -amount }]);
      } else if (ev.name === "HouseWithdrawal") {
        await post(c, "sweep", key, [{ account: await account(c, "house", token), amount: -amount }, { account: await account(c, "swept_out", token), amount }]);
      } else if (ev.name === "Withdrawn") {
        const uid = await userIdFor(c, data.user!);
        const w = await c.query("SELECT * FROM withdrawals WHERE user_id=$1 AND nonce=$2 FOR UPDATE", [uid, data.nonce]);
        const row = w.rows[0];
        if (row && row.status === "signed" && BigInt(row.amount) === amount && row.token === token) {
          await post(c, "withdrawal_paid", row.id, [{ account: await account(c, "pending", token), amount: -amount }, { account: await account(c, "paid_out", token), amount }]);
          await c.query("UPDATE withdrawals SET status='paid', settled_at=now(), tx_hash=$2 WHERE id=$1", [row.id, l.transactionHash]);
        } else {
          // A payout we did not expect (unknown voucher, refunded voucher, or mismatched amount). Book it against the
          // house so the ledger still matches the chain, and stop all withdrawals until a human looks at it.
          await post(c, "withdrawal_unexpected", key, [{ account: await account(c, "house", token), amount: -amount }, { account: await account(c, "paid_out", token), amount }]);
          await setFlag(c, "withdrawals_frozen", true, `unexpected Withdrawn event ${key} (record: ${row ? row.status : "none"})`);
          log(`ALERT unexpected withdrawal ${key}`);
        }
      }
    }
    await c.query("INSERT INTO chain_cursor(name,last_block) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET last_block=EXCLUDED.last_block", [CURSOR, to]);
  });
  return { from, to, booked };
}

/** latest block number straight from the node (ethers caches getBlockNumber briefly) */
export async function headBlock(ch: Chain): Promise<number> {
  return Number(BigInt(await ch.provider.send("eth_blockNumber", [])));
}

export async function safeBlock(cfg: Config, ch: Chain): Promise<ethers.Block> {
  const head = await headBlock(ch);
  const b = await ch.provider.getBlock(Math.max(0, head - cfg.CONFIRMATIONS));
  if (!b) throw new Error("no block");
  return b;
}
