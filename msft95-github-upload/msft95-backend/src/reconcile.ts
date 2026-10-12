/*
  Every minute: does the vault actually hold what the ledger says it should?
  The ledger is read in ONE repeatable-read snapshot together with the indexer cursor (the indexer commits events and
  cursor together), and the chain is read at that same cursor block, so both sides describe the same moment.
  Vault balance must be >= player balances + pending withdrawals (equality with + house is expected, but value can be
  forced in without an event, so surplus is fine). If players are under-covered, or withdrawals are already frozen
  (e.g. the indexer saw a payout we never issued), freeze here and pause the vault on-chain with the guardian key.
*/
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { checkIntegrity } from "./ledger.js";
import { setFlag } from "./flags.js";
import type { Chain } from "./chain.js";
import { guardianPause } from "./guardian.js";

export interface TokenReport { token: string; symbol: string; onchain: string; players: string; pending: string; house: string; ok: boolean; drift: string }

export async function reconcile(db: Db, cfg: Config, ch: Chain, guardianKey?: string, log: (m: string) => void = () => {}) {
  // ---- one consistent snapshot of the ledger
  const c = await db.connect();
  let blockTag: number, sums: Map<string, { players: bigint; pending: bigint; house: bigint }>, problems: string[], frozen: { value: boolean; reason: string | null };
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const cur = await c.query("SELECT last_block FROM chain_cursor WHERE name='vault'");
    if (!cur.rowCount) { await c.query("COMMIT"); return { reports: [] as TokenReport[], problems: [] as string[], frozen: false }; }
    blockTag = Number(cur.rows[0].last_block);
    problems = await checkIntegrity(c);
    const r = await c.query(`SELECT token,
        COALESCE(sum(balance) FILTER (WHERE kind='user'),0) AS players,
        COALESCE(sum(balance) FILTER (WHERE kind='pending'),0) AS pending,
        COALESCE(sum(balance) FILTER (WHERE kind='house'),0) AS house
      FROM accounts GROUP BY token`);
    sums = new Map(r.rows.map((x) => [x.token, { players: BigInt(x.players), pending: BigInt(x.pending), house: BigInt(x.house) }]));
    const f = await c.query("SELECT value, reason FROM system_flags WHERE name='withdrawals_frozen'");
    frozen = { value: !!f.rows[0]?.value, reason: f.rows[0]?.reason ?? null };
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }

  // ---- the chain at the same block; every configured token AND every token anyone holds a balance in
  const tokens = new Set<string>([...cfg.tokens.keys(), ...sums.keys()]);
  const reports: TokenReport[] = [];
  let shortfall = false;
  for (const token of tokens) {
    const symbol = cfg.tokens.get(token)?.symbol ?? `unconfigured ${token}`;
    const s = sums.get(token) ?? { players: 0n, pending: 0n, house: 0n };
    const onchain: bigint = await ch.vault.getFunction("balanceOf")(token, { blockTag });
    const ok = onchain >= s.players + s.pending;
    const drift = onchain - (s.players + s.pending + s.house);   // >0: value forced in (harmless); <0: money left that we didn't book
    if (!ok) { shortfall = true; problems.push(`${symbol}: vault holds ${onchain} but players are owed ${s.players + s.pending}`); }
    else if (drift < 0n) { shortfall = true; problems.push(`${symbol}: vault is ${-drift} below the ledger (money left that was never booked)`); }
    if (!cfg.tokens.has(token) && s.players + s.pending > 0n) log(`ALERT ${symbol}: players hold balances in a token that is not configured (can't be withdrawn until it is added to the tokens file)`);
    reports.push({ token, symbol, onchain: onchain.toString(), players: s.players.toString(), pending: s.pending.toString(), house: s.house.toString(), ok, drift: drift.toString() });
  }

  if (problems.length) {
    await setFlag(db, "withdrawals_frozen", true, "reconciliation: " + problems.join("; ").slice(0, 900));
    log("ALERT reconciliation failed: " + problems.join("; "));
  }
  // pause the vault itself when players are under-covered, or when withdrawals were frozen for a reason the vault
  // can't see (an unexpected payout means a signing key may be in someone else's hands)
  const unexpected = frozen.value && /unexpected|review/.test(frozen.reason ?? "");
  if (shortfall || unexpected) await guardianPause(ch, guardianKey, shortfall ? "vault shortfall" : String(frozen.reason), log);
  return { reports, problems, frozen: problems.length > 0 || frozen.value };
}
