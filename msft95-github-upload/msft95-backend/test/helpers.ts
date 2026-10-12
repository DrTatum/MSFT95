import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { loadConfig, type Config } from "../src/config.js";
import { createPool, migrate, type Db } from "../src/db.js";

export const DB_URL = process.env.TEST_DATABASE_URL || "postgres://casino:casino@localhost:5432/casino_test";
export const SEED_KEY = "11".repeat(32);
export const ETH = ethers.ZeroAddress;
export const TOKEN = "0x00000000000000000000000000000000000000aa";

export async function freshDb(): Promise<Db> {
  const db = createPool(DB_URL);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  return db;
}

export function testConfig(over: Record<string, string> = {}, tokens?: unknown[]): Config {
  return loadConfig({
    NODE_ENV: "test", DATABASE_URL: DB_URL, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8546",
    VAULT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3", CONFIRMATIONS: "2",
    SIWE_DOMAIN: "msft95.test", SIWE_ORIGIN: "https://msft95.test", SEED_KEY, ...over,
  } as any, tokens ?? [
    { symbol: "ETH", address: ETH, decimals: 18, minBet: "1000", maxBet: "1000000000000000000", maxPayout: "100000000000000000000000", minWithdrawal: "1", userDailyWithdrawal: "100000000000000000000" },
    { symbol: "TOK", address: TOKEN, decimals: 18, minBet: "1000", maxBet: "1000000000000000000000", maxPayout: "10000000000000000000000000", minWithdrawal: "1", userDailyWithdrawal: "100000000000000000000000" },
  ]);
}

/** give a user some balance straight from "deposits_in" (as if a deposit had been indexed) */
export async function fund(db: Db, address: string, token: string, amount: bigint): Promise<string> {
  const { tx } = await import("../src/db.js");
  const { account, post } = await import("../src/ledger.js");
  return tx(db, async (c) => {
    await c.query("INSERT INTO users(address) VALUES ($1) ON CONFLICT DO NOTHING", [address.toLowerCase()]);
    const uid = (await c.query("SELECT id FROM users WHERE address=$1", [address.toLowerCase()])).rows[0].id;
    await post(c, "deposit", "test:" + Math.random(), [{ account: await account(c, "user", token, uid), amount }, { account: await account(c, "deposits_in", token), amount: -amount }]);
    await post(c, "bankroll", "test:" + Math.random(), [{ account: await account(c, "house", token), amount: amount * 1000n }, { account: await account(c, "bankroll_in", token), amount: -amount * 1000n }]);
    return uid;
  });
}

export async function bal(db: Db, userId: string, token: string): Promise<bigint> {
  const r = await db.query("SELECT balance FROM accounts WHERE kind='user' AND user_id=$1 AND token=$2", [userId, token.toLowerCase()]);
  return BigInt(r.rows[0]?.balance ?? 0);
}

// ---------------------------------------------------------------- local chain (hardhat node from ../contracts)
// the vault project sits next to this folder: "contracts" in the zip, "msft95-vault" in the GitHub repo
const CONTRACTS = process.env.CONTRACTS_DIR || ["contracts", "msft95-vault"].map((d) => path.resolve(__dirname, "..", "..", d)).find((d) => fs.existsSync(d)) || path.resolve(__dirname, "..", "..", "contracts");
export function artifact(name: string, sub = "") {
  const p = path.join(CONTRACTS, "artifacts", "contracts", sub, `${sub ? "Mocks" : name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export async function startNode(port = 8546): Promise<{ proc: ChildProcess; provider: ethers.JsonRpcProvider }> {
  const cli = path.join(CONTRACTS, "node_modules", "hardhat", "internal", "cli", "cli.js");
  const proc = spawn(process.execPath, [cli, "node", "--port", String(port)], { cwd: CONTRACTS, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("hardhat node did not start")), 90000);
    proc.stdout!.on("data", (d) => { if (String(d).includes("Started HTTP")) { clearTimeout(t); res(); } });
    proc.on("exit", (c) => rej(new Error("hardhat node exited " + c)));
  });
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true });
  return { proc, provider };
}

export async function mine(provider: ethers.JsonRpcProvider, n = 1, seconds = 0) {
  if (seconds) await provider.send("evm_increaseTime", [seconds]);
  for (let i = 0; i < n; i++) await provider.send("evm_mine", []);
}
