/* End-to-end against a real local chain: the step-1 vault contract on a hardhat node. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ethers } from "ethers";
import type { ChildProcess } from "node:child_process";
import { freshDb, testConfig, startNode, artifact, mine, bal, ETH } from "./helpers.js";
import type { Db } from "../src/db.js";
import type { Config } from "../src/config.js";
import { connect, LocalKeySigner, WITHDRAWAL_TYPES, type Chain } from "../src/chain.js";
import { indexOnce } from "../src/indexer.js";
import { requestWithdrawal, expireWithdrawals } from "../src/withdrawals.js";
import { reconcile } from "../src/reconcile.js";
import { playSlots } from "../src/games/service.js";
import { flag, setFlag } from "../src/flags.js";
import { checkIntegrity } from "../src/ledger.js";

const E = 10n ** 18n;
let node: { proc: ChildProcess; provider: ethers.JsonRpcProvider };
let db: Db, cfg: Config, ch: Chain;
let vault: ethers.Contract, tok: ethers.Contract, tokAddr: string;
const signerW = ethers.Wallet.createRandom(), cosignerW = ethers.Wallet.createRandom(), guardianW = ethers.Wallet.createRandom();
let alice: ethers.Signer & { address: string }, admin: ethers.JsonRpcSigner;
const signers = { signer: new LocalKeySigner(signerW.privateKey), cosigner: new LocalKeySigner(cosignerW.privateKey) };

async function index() { let r; while ((r = await indexOnce(db, cfg, ch))) if (process.env.DBG) console.log("IDX", r, await ch.provider.getBlockNumber()); }
async function wait(p: Promise<ethers.ContractTransactionResponse>) { return (await p).wait(); }
const uid = async (a: string) => (await db.query("SELECT id FROM users WHERE address=$1", [a.toLowerCase()])).rows[0]?.id as string;

beforeAll(async () => {
  node = await startNode(8546);
  const p = node.provider;
  admin = await p.getSigner(0);
  const aliceW = ethers.Wallet.createRandom().connect(p);
  alice = Object.assign(new ethers.NonceManager(aliceW), { address: aliceW.address });
  for (const w of [aliceW, guardianW]) await p.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);   // 100 ETH
  const V = artifact("MSFT95Vault"), T = artifact("TestToken", "mocks");
  tok = (await (await new ethers.ContractFactory(T.abi, T.bytecode, admin).deploy("Test IMD", "tIMD", 18)).waitForDeployment()) as unknown as ethers.Contract;
  tokAddr = (await tok.getAddress()).toLowerCase();
  const lim = { listed: true, depositsEnabled: true, minDeposit: 1n, maxWithdrawal: 500n * E, dailyCap: 5000n * E, cosignAbove: 50n * E };
  // vault v2: roles and tokens are set in the constructor
  vault = (await (await new ethers.ContractFactory(V.abi, V.bytecode, admin).deploy({
    admin: await admin.getAddress(), adminDelay: 0, signer: signerW.address, cosigner: cosignerW.address, guardian: guardianW.address,
    bankroller: ethers.ZeroAddress, allowlistOnly: false, allowed: [],
    tokens: [{ token: tokAddr, config: lim }, { token: ETH, config: { ...lim, maxWithdrawal: 5n * E, dailyCap: 50n * E, cosignAbove: 1n * E } }],
  })).waitForDeployment()) as unknown as ethers.Contract;
  const va = await vault.getAddress();
  await wait(tok.mint(await admin.getAddress(), 1_000_000n * E));
  await wait(tok.mint(alice.address, 1_000n * E));
  await wait(tok.approve(va, ethers.MaxUint256));
  await wait(vault.fundBankroll(tokAddr, 10_000n * E));
  await wait((tok.connect(alice) as ethers.Contract).approve(va, ethers.MaxUint256));

  db = await freshDb();
  cfg = testConfig({ VAULT_ADDRESS: va, CONFIRMATIONS: "2", WITHDRAWAL_TTL_SEC: "300" }, [
    { symbol: "ETH", address: ETH, decimals: 18, minBet: "1000", maxBet: (1n * E).toString(), maxPayout: (10_000n * E).toString(), minWithdrawal: "1", userDailyWithdrawal: (100n * E).toString() },
    { symbol: "tIMD", address: tokAddr, decimals: 18, minBet: "1000", maxBet: (10n * E).toString(), maxPayout: (100_000n * E).toString(), minWithdrawal: "1", userDailyWithdrawal: (1000n * E).toString() },
  ]);
  ch = connect(cfg);
  node.provider.pollingInterval = 100; ch.provider.pollingInterval = 100;
}, 180000);

afterAll(async () => { await db?.end(); node?.proc.kill(); });

describe("deposits → play → withdraw, on a real chain", () => {
  it("credits deposits only after confirmations, exactly once", async () => {
    await wait((vault.connect(alice) as ethers.Contract).deposit(tokAddr, 200n * E));
    await wait((vault.connect(alice) as ethers.Contract).depositETH({ value: 2n * E }));
    await index();
    expect(await uid(alice.address)).toBeUndefined();          // not deep enough yet
    await mine(node.provider, 3);
    await index();
    const id = await uid(alice.address);
    expect(await bal(db, id, tokAddr)).toBe(200n * E);
    expect(await bal(db, id, ETH)).toBe(2n * E);
    // replaying the same blocks books nothing new
    await db.query("UPDATE chain_cursor SET last_block=0");
    await index();
    expect(await bal(db, id, tokAddr)).toBe(200n * E);
    expect(await checkIntegrity(db)).toEqual([]);
  });

  it("plays with the deposited balance", async () => {
    const id = await uid(alice.address);
    for (let i = 0; i < 5; i++) await playSlots(db, cfg, { userId: id, token: tokAddr, bet: E.toString(), requestId: "chain" + i + "xxxxx", action: "spin" });
    const r = await reconcile(db, cfg, ch);
    expect(r.problems).toEqual([]);
    expect(r.reports.find((x) => x.token === tokAddr)!.drift).toBe("0");
  });

  it("signs a withdrawal the vault accepts, and books it when paid", async () => {
    const id = await uid(alice.address);
    const before = await bal(db, id, tokAddr);
    const w = await requestWithdrawal(db, cfg, ch, signers, id, tokAddr, (10n * E).toString());
    expect(w.signatures).toHaveLength(1);
    expect(await bal(db, id, tokAddr)).toBe(before - 10n * E);          // held as pending right away
    const got0 = await tok.balanceOf(alice.address);
    await wait((vault.connect(alice) as ethers.Contract).withdraw(w.voucher, w.signatures));
    expect(await tok.balanceOf(alice.address)).toBe(got0 + 10n * E);
    await mine(node.provider, 3); await index();
    const row = (await db.query("SELECT status FROM withdrawals WHERE id=$1", [w.id])).rows[0];
    expect(row.status).toBe("paid");
    expect((await reconcile(db, cfg, ch)).problems).toEqual([]);
  });

  it("large withdrawals carry the cosigner's signature too", async () => {
    const id = await uid(alice.address);
    const w = await requestWithdrawal(db, cfg, ch, signers, id, tokAddr, (60n * E).toString());
    expect(w.signatures).toHaveLength(2);
    await wait((vault.connect(alice) as ethers.Contract).withdraw(w.voucher, w.signatures));
    // ETH too
    const e = await requestWithdrawal(db, cfg, ch, signers, id, ETH, (5n * E / 10n).toString());
    await wait((vault.connect(alice) as ethers.Contract).withdraw(e.voucher, e.signatures));
    await mine(node.provider, 3); await index();
    expect((await db.query("SELECT count(*)::int AS n FROM withdrawals WHERE status='paid'")).rows[0].n).toBe(3);
  });

  it("refunds a voucher nobody used, only after it can no longer be used", async () => {
    const id = await uid(alice.address);
    const before = await bal(db, id, tokAddr);
    const w = await requestWithdrawal(db, cfg, ch, signers, id, tokAddr, (5n * E).toString());
    expect(await expireWithdrawals(db, cfg, ch)).toBe(0);              // not expired yet
    await mine(node.provider, 1, 301);
    expect(await expireWithdrawals(db, cfg, ch)).toBe(0);              // expired at head, but not in a confirmed block yet
    await mine(node.provider, 3);
    expect(await expireWithdrawals(db, cfg, ch)).toBe(1);
    expect(await bal(db, id, tokAddr)).toBe(before);
    await expect((vault.connect(alice) as ethers.Contract).withdraw(w.voucher, w.signatures)).rejects.toThrow(/VoucherExpired|reverted/);
    (alice as unknown as ethers.NonceManager).reset();
    expect(await checkIntegrity(db)).toEqual([]);
  });

  it("vouchers voided on-chain by the guardian are refunded once expired", async () => {
    const id = await uid(alice.address);
    const before = await bal(db, id, tokAddr);
    const w = await requestWithdrawal(db, cfg, ch, signers, id, tokAddr, (2n * E).toString());
    expect(BigInt(w.voucher.deadline) - BigInt(w.voucher.issuedAt)).toBe(300n);
    await mine(node.provider, 1, 5);
    const g = guardianW.connect(node.provider);
    await wait((vault.connect(g) as ethers.Contract).voidVouchersIssuedBefore((await node.provider.getBlock("latest"))!.timestamp));
    await expect((vault.connect(alice) as ethers.Contract).withdraw(w.voucher, w.signatures)).rejects.toThrow();
    (alice as unknown as ethers.NonceManager).reset();
    await mine(node.provider, 1, 301); await mine(node.provider, 3);
    expect(await expireWithdrawals(db, cfg, ch)).toBe(1);
    expect(await bal(db, id, tokAddr)).toBe(before);
  });

  it("can't withdraw more than the balance", async () => {
    const id = await uid(alice.address);
    await expect(requestWithdrawal(db, cfg, ch, signers, id, tokAddr, (499n * E).toString())).rejects.toMatchObject({ code: "insufficient_funds" });
    await expect(requestWithdrawal(db, cfg, ch, signers, id, tokAddr, (501n * E).toString())).rejects.toMatchObject({ code: "too_big" });
  });

  it("a payout the backend never issued freezes withdrawals AND pauses the vault (stolen-key scenario)", async () => {
    const id = await uid(alice.address);
    // a real voucher the backend issued...
    const legit = await requestWithdrawal(db, cfg, ch, signers, id, tokAddr, (5n * E).toString());
    // ...and a forged one signed with the (stolen) signer key, reusing its nonce with a different amount
    const ts = BigInt((await node.provider.getBlock("latest"))!.timestamp);
    const v = { user: alice.address, token: tokAddr, amount: 3n * E, nonce: BigInt(legit.voucher.nonce), issuedAt: ts, deadline: ts + 600n };
    const sig = await signerW.signTypedData(ch.domain, WITHDRAWAL_TYPES, v);
    await wait((vault.connect(alice) as ethers.Contract).withdraw(v, [sig]));
    await mine(node.provider, 3); await index();
    expect(await flag(db, "withdrawals_frozen")).toBe(true);
    expect((await db.query("SELECT status FROM withdrawals WHERE id=$1", [legit.id])).rows[0].status).toBe("review");   // parked, not stuck
    await expect(requestWithdrawal(db, cfg, ch, signers, id, tokAddr, E.toString())).rejects.toMatchObject({ code: "withdrawals_frozen" });
    // the books still balance, but the reconciler sees WHY withdrawals are frozen and pauses the vault on-chain
    const r = await reconcile(db, cfg, ch, guardianW.privateKey);
    expect(r.reports.find((x) => x.token === tokAddr)!.drift).toBe("0");
    expect(await vault.withdrawalsPaused()).toBe(true);
    // an operator reviews, then the admin unpauses
    await wait(vault.unpauseWithdrawals());
    await setFlag(db, "withdrawals_frozen", false, "test: reviewed");
  });

  it("reconcile never reports a false shortfall when a deposit is indexed mid-check", async () => {
    await wait((vault.connect(alice) as ethers.Contract).deposit(tokAddr, 30n * E));
    await mine(node.provider, 3);
    // run the indexer exactly while reconcile is waiting on the chain (the race the review found)
    const vaultProxy = new Proxy(ch.vault, { get(t, k) {
      if (k !== "getFunction") return (t as any)[k];
      return (name: string) => { const f = t.getFunction(name); if (name !== "balanceOf") return f;
        return async (...a: any[]) => { const out = await f(...a); await index(); return out; }; };
    } });
    const r = await reconcile(db, cfg, { ...ch, vault: vaultProxy as unknown as ethers.Contract }, guardianW.privateKey);
    expect(r.problems).toEqual([]);
    expect(await vault.withdrawalsPaused()).toBe(false);
    expect(await flag(db, "withdrawals_frozen")).toBe(false);
  });

  it("if the vault holds less than players are owed: freeze here and pause the vault on-chain", async () => {
    // the house sweeps more than its own share, leaving players under-covered
    const owed = (await db.query("SELECT COALESCE(sum(balance),0) AS s FROM accounts WHERE kind IN ('user','pending') AND token=$1", [tokAddr])).rows[0].s;
    const onchain: bigint = await vault.balanceOf(tokAddr);
    const take = onchain - BigInt(owed) + E;
    await wait(vault.setToken(tokAddr, { listed: true, depositsEnabled: true, minDeposit: 1n, maxWithdrawal: 500n * E, dailyCap: 100_000n * E, cosignAbove: 50n * E }));
    await wait(vault.sweep(tokAddr, await admin.getAddress(), take));
    await mine(node.provider, 3); await index();
    const r = await reconcile(db, cfg, ch, guardianW.privateKey);
    expect(r.frozen).toBe(true);
    expect(r.problems.join(" ")).toMatch(/players are owed/);
    expect(await vault.withdrawalsPaused()).toBe(true);
    expect(await flag(db, "withdrawals_frozen")).toBe(true);
  });
});
