/*
  Every minute: does the vault actually hold what the ledger says it should?
  At the last indexed block, vault balance must equal player balances + pending withdrawals + house balance.
  If the vault holds LESS than what players are owed (balances + pending), freeze withdrawals here and,
  if a guardian key is configured, pause withdrawals in the vault too.
*/
import { ethers } from "ethers";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { checkIntegrity } from "./ledger.js";
import { setFlag } from "./flags.js";
import type { Chain } from "./chain.js";

export interface TokenReport { token: string; symbol: string; onchain: string; players: string; pending: string; house: string; ok: boolean; drift: string }

export async function reconcile(db: Db, cfg: Config, ch: Chain, guardianKey?: string, log: (m: string) => void = () => {}) {
  const cur = await db.query("SELECT last_block FROM chain_cursor WHERE name='vault'");
  if (!cur.rowCount) return { reports: [] as TokenReport[], problems: [] as string[], frozen: false };
  const blockTag = Number(cur.rows[0].last_block);
  const problems = await checkIntegrity(db);
  const reports: TokenReport[] = [];
  for (const t of cfg.tokens.values()) {
    const onchain: bigint = await ch.vault.getFunction("balanceOf")(t.address, { blockTag });
    const r = await db.query(`SELECT
        COALESCE(sum(balance) FILTER (WHERE kind='user'),0) AS players,
        COALESCE(sum(balance) FILTER (WHERE kind='pending'),0) AS pending,
        COALESCE(sum(balance) FILTER (WHERE kind='house'),0) AS house
      FROM accounts WHERE token=$1`, [t.key]);
    const players = BigInt(r.rows[0].players), pending = BigInt(r.rows[0].pending), house = BigInt(r.rows[0].house);
    const ok = onchain >= players + pending;
    const drift = onchain - (players + pending + house);   // >0: someone sent tokens straight to the vault; <0: money left we didn't book
    if (!ok) problems.push(`${t.symbol}: vault holds ${onchain} but players are owed ${players + pending}`);
    else if (drift < 0n) problems.push(`${t.symbol}: vault is ${-drift} below the ledger`);
    reports.push({ token: t.key, symbol: t.symbol, onchain: onchain.toString(), players: players.toString(), pending: pending.toString(), house: house.toString(), ok, drift: drift.toString() });
  }
  let frozen = false;
  if (problems.length) {
    frozen = true;
    await setFlag(db, "withdrawals_frozen", true, "reconciliation: " + problems.join("; ").slice(0, 900));
    log("ALERT reconciliation failed: " + problems.join("; "));
    if (guardianKey) {
      try {
        const g = new ethers.Wallet(guardianKey, ch.provider);
        const v = ch.vault.connect(g) as ethers.Contract;
        if (!(await v.getFunction("withdrawalsPaused")())) await (await v.getFunction("pauseWithdrawals")()).wait();
        log("vault withdrawals paused on-chain by guardian");
      } catch (e: any) { log("guardian pause failed: " + e?.message); }
    }
  }
  return { reports, problems, frozen };
}
