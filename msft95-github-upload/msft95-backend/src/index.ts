import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { buildServer } from "./server.js";
import { connect, LocalKeySigner } from "./chain.js";
import { indexOnce } from "./indexer.js";
import { expireWithdrawals } from "./withdrawals.js";
import { reconcile } from "./reconcile.js";
import { guardianPause } from "./guardian.js";

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
await migrate(db);
const chain = connect(cfg);
// Testnet: keys from env. Mainnet: replace with KMS-backed VoucherSigner implementations (see SECURITY.md).
const signers = cfg.SIGNER_KEY ? { signer: new LocalKeySigner(cfg.SIGNER_KEY), cosigner: cfg.COSIGNER_KEY ? new LocalKeySigner(cfg.COSIGNER_KEY) : undefined } : undefined;
const app = await buildServer({ db, cfg, chain, signers });
await app.listen({ port: cfg.PORT, host: "0.0.0.0" });

const log = (m: string) => app.log.info(m);
/** run fn every ms; a run that hangs is abandoned after 5 minutes so the loop can never stop for good */
function every(ms: number, name: string, fn: () => Promise<unknown>) {
  let busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timed out after 5 minutes")), 300_000); })]); }
    catch (e: any) { app.log.error(`${name}: ${e?.message}`); }
    finally { clearTimeout(timer); busy = false; }
  }, ms);
}
every(3_000, "indexer", async () => {
  let r; while ((r = await indexOnce(db, cfg, chain, log))) if (r.unexpected) await guardianPause(chain, cfg.GUARDIAN_KEY, "unexpected withdrawal", log);
});
every(30_000, "expiry", () => expireWithdrawals(db, cfg, chain, log));
every(60_000, "reconcile", () => reconcile(db, cfg, chain, cfg.GUARDIAN_KEY, log));
