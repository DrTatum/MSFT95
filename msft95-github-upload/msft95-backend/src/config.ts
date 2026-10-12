import fs from "node:fs";
import { z } from "zod";

const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^\d{1,78}$/);

export const TokenSchema = z.object({
  symbol: z.string().min(1).max(16),
  address: addr,                 // 0x000…0 for native ETH
  decimals: z.number().int().min(0).max(36),
  minBet: uint,                  // base units
  maxBet: uint,
  maxPayout: uint,               // biggest single-round payout the house accepts (bets whose max win exceeds it are refused)
  minWithdrawal: uint,
  userDailyWithdrawal: uint,     // per player per 24h, on top of the vault's own global cap
});
export type TokenCfg = z.infer<typeof TokenSchema> & { key: string };

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8787),
  DATABASE_URL: z.string().min(1),
  CHAIN_ID: z.coerce.number().int(),
  RPC_URL: z.string().url(),
  VAULT_ADDRESS: addr,
  CONFIRMATIONS: z.coerce.number().int().min(0).default(10),
  START_BLOCK: z.coerce.number().int().min(0).default(0),
  SIWE_DOMAIN: z.string().min(1),          // e.g. msft95.com
  SIWE_ORIGIN: z.string().url(),           // e.g. https://msft95.com
  CORS_ORIGINS: z.string().default(""),    // comma list; defaults to SIWE_ORIGIN
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(24),
  SEED_KEY: hex32,                          // encrypts server seeds at rest
  SIGNER_KEY: hex32.optional(),             // local signer (testnet only unless ALLOW_LOCAL_KEYS)
  COSIGNER_KEY: hex32.optional(),
  GUARDIAN_KEY: hex32.optional(),           // optional: lets the reconciler pause vault withdrawals on-chain
  ALLOW_LOCAL_KEYS: z.enum(["0", "1"]).default("0"),
  WITHDRAWAL_TTL_SEC: z.coerce.number().int().min(300).max(86000).default(1800),   // must stay under the vault's 24h voucher lifetime
  TOKENS_FILE: z.string().default("config/tokens.testnet.json"),
  RATE_LIMIT_MULTIPLIER: z.coerce.number().int().min(1).max(1000).default(1),   // raise only for load tests
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),   // number of reverse proxies in front (0 = none); never "trust everything"
});

export type Config = z.infer<typeof Env> & { tokens: Map<string, TokenCfg>; corsOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env, tokensOverride?: unknown): Config {
  const e = Env.parse(env);
  const TESTNETS = new Set([31337, 46630]);   // hardhat, Robinhood Chain testnet: env keys are only allowed here
  if (!TESTNETS.has(e.CHAIN_ID) && (e.SIGNER_KEY || e.COSIGNER_KEY) && e.ALLOW_LOCAL_KEYS !== "1") {
    throw new Error("Refusing to use signing keys from env on mainnet: use a KMS signer (or set ALLOW_LOCAL_KEYS=1 knowingly).");
  }
  if (e.SIGNER_KEY && e.COSIGNER_KEY && e.SIGNER_KEY.toLowerCase().replace(/^0x/, "") === e.COSIGNER_KEY.toLowerCase().replace(/^0x/, "")) {
    throw new Error("SIGNER_KEY and COSIGNER_KEY must be different keys");
  }
  const raw = tokensOverride ?? JSON.parse(fs.readFileSync(e.TOKENS_FILE, "utf8"));
  const list = z.array(TokenSchema).parse(raw);
  const tokens = new Map<string, TokenCfg>();
  for (const t of list) {
    const key = t.address.toLowerCase();
    if (tokens.has(key)) throw new Error("duplicate token " + t.address);
    if (BigInt(t.minBet) <= 0n || BigInt(t.minBet) > BigInt(t.maxBet)) throw new Error(`bad bet limits for ${t.symbol}`);
    tokens.set(key, { ...t, key });
  }
  const corsOrigins = (e.CORS_ORIGINS || e.SIWE_ORIGIN).split(",").map((s) => s.trim()).filter(Boolean);
  return { ...e, tokens, corsOrigins };
}
