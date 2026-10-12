import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { buildServer } from "./server.js";
import { connect, LocalKeySigner } from "./chain.js";
import { indexOnce } from "./indexer.js";
import { expireWithdrawals } from "./withdrawals.js";
import { reconcile } from "./reconcile.js";

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
await migrate(db);
const chain = connect(cfg);
// Testnet: keys from env. Mainnet: replace with KMS-backed VoucherSigner implementations (see SECURITY.md).
const signers = cfg.SIGNER_KEY ? { signer: new LocalKeySigner(cfg.SIGNER_KEY), cosigner: cfg.COSIGNER_KEY ? new LocalKeySigner(cfg.COSIGNER_KEY) : undefined } : undefined;
const app = await buildServer({ db, cfg, chain, signers });
await app.listen({ port: cfg.PORT, host: "0.0.0.0" });

const log = (m: string) => app.log.info(m);
function every(ms: number, name: string, fn: () => Promise<unknown>) {
  let busy = false;
  setInterval(async () => { if (busy) return; busy = true; try { await fn(); } catch (e: any) { app.log.error(`${name}: ${e?.message}`); } finally { busy = false; } }, ms);
}
every(3_000, "indexer", async () => { while (await indexOnce(db, cfg, chain, log)); });
every(30_000, "expiry", () => expireWithdrawals(db, cfg, chain, log));
every(60_000, "reconcile", () => reconcile(db, cfg, chain, cfg.GUARDIAN_KEY, log));
