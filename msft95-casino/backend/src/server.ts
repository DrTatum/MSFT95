import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { tx } from "./db.js";
import { AppError } from "./errors.js";
import { issueNonce, login, logout, sessionUser } from "./auth.js";
import { playKeno, playSlots, features } from "./games/service.js";
import { publicSeed, rotate, CLIENT_SEED_RE } from "./fair.js";
import { requestWithdrawal, listWithdrawals, type Signers } from "./withdrawals.js";
import type { Chain } from "./chain.js";
import { SLOTS_MATH, KENO_MATH } from "./games/rounds.js";
import { MATH_SOURCE_SHA256 } from "./games/math.js";

const COOKIE = "msft95_session";
const uint = z.string().regex(/^\d{1,78}$/);
const reqId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

declare module "fastify" { interface FastifyRequest { user?: { userId: string; address: string } } }

export interface Deps { db: Db; cfg: Config; chain?: Chain; signers?: Signers }

export async function buildServer({ db, cfg, chain, signers }: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: cfg.NODE_ENV !== "test", bodyLimit: 16 * 1024, trustProxy: cfg.TRUST_PROXY === "1" });
  await app.register(helmet, { contentSecurityPolicy: false });   // JSON API: no HTML served
  await app.register(cors, { origin: cfg.corsOrigins, credentials: true, methods: ["GET", "POST"] });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute", keyGenerator: (r) => r.user?.userId ?? r.ip });

  // CSRF: browsers always send Origin on cross-site POSTs; refuse any we don't know
  app.addHook("onRequest", async (req) => {
    if (req.method === "POST") {
      const o = req.headers.origin;
      if (o && !cfg.corsOrigins.includes(o)) throw new AppError(403, "bad_origin", "Request from an unknown site.");
    }
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : req.cookies?.[COOKIE];
    const u = await sessionUser(db, token);
    if (u) req.user = u;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: "bad_input", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (err.statusCode === 429) return reply.status(429).send({ error: "rate_limited", message: "Slow down a little." });
    if (err.validation || err.statusCode === 400 || err.statusCode === 415) return reply.status(400).send({ error: "bad_input", message: "Bad request." });
    req.log.error(err);
    return reply.status(500).send({ error: "server_error", message: "Something went wrong. Nothing was charged." });
  });

  const me = (req: FastifyRequest) => { if (!req.user) throw new AppError(401, "signed_out", "Sign in with your wallet first."); return req.user; };

  app.get("/health", async () => ({ ok: true }));

  app.get("/info", async () => ({
    chainId: cfg.CHAIN_ID, vault: cfg.VAULT_ADDRESS, mathSha256: MATH_SOURCE_SHA256,
    slots: { version: SLOTS_MATH.version, maxWinX: SLOTS_MATH.maxWinX, buyX: SLOTS_MATH.buyX, rtp: SLOTS_MATH.rtp },
    keno: { version: KENO_MATH.version, maxWinX: KENO_MATH.maxWinX, buyX: KENO_MATH.buyX, rtp: KENO_MATH.rtp },
    tokens: [...cfg.tokens.values()].map(({ key, ...t }) => t),
  }));

  // ---- auth
  app.get("/auth/nonce", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async () => ({ nonce: await issueNonce(db), domain: cfg.SIWE_DOMAIN, uri: cfg.SIWE_ORIGIN, chainId: cfg.CHAIN_ID }));
  app.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = z.object({ message: z.string().max(2000), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).parse(req.body);
    const s = await login(db, cfg, b.message, b.signature);
    reply.setCookie(COOKIE, s.token, { httpOnly: true, secure: cfg.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: cfg.SESSION_TTL_HOURS * 3600 });
    return { address: s.address, token: s.token };
  });
  app.post("/auth/logout", async (req, reply) => {
    const h = req.headers.authorization; const t = h?.startsWith("Bearer ") ? h.slice(7) : req.cookies?.[COOKIE];
    if (t) await logout(db, t);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---- account
  app.get("/me", async (req) => {
    const u = me(req);
    const bal = await db.query("SELECT token, balance FROM accounts WHERE kind='user' AND user_id=$1", [u.userId]);
    const seed = await tx(db, (c) => publicSeed(c, u.userId, cfg.SEED_KEY));
    return { address: u.address,
      balances: bal.rows.map((r) => ({ token: r.token, symbol: cfg.tokens.get(r.token)?.symbol ?? null, balance: r.balance })),
      seed, features: await features(db, u.userId) };
  });

  // ---- provably fair
  app.post("/fair/rotate", async (req) => {
    const u = me(req);
    const b = z.object({ clientSeed: z.string().regex(CLIENT_SEED_RE).optional() }).parse(req.body ?? {});
    return tx(db, (c) => rotate(c, u.userId, cfg.SEED_KEY, b.clientSeed));
  });
  app.get("/fair/history", async (req) => {
    const u = me(req);
    const r = await db.query("SELECT id, server_seed, server_seed_hash, client_seed, nonce, created_at, revealed_at FROM seeds WHERE user_id=$1 AND NOT active ORDER BY id DESC LIMIT 50", [u.userId]);
    return r.rows;
  });

  // ---- games
  app.post("/games/slots", async (req) => {
    const u = me(req);
    const b = z.object({ token: addr, bet: uint, requestId: reqId, action: z.enum(["spin", "buy"]).default("spin") }).parse(req.body);
    return playSlots(db, cfg, { userId: u.userId, ...b });
  });
  app.post("/games/keno", async (req) => {
    const u = me(req);
    const b = z.object({ token: addr, bet: uint, requestId: reqId, action: z.enum(["spin", "buy"]).default("spin"),
      picks: z.array(z.number().int().min(1).max(80)).min(1).max(10).optional() }).parse(req.body);
    return playKeno(db, cfg, { userId: u.userId, ...b });
  });
  app.get("/bets", async (req) => {
    const u = me(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.coerce.number().int().positive().optional() }).parse(req.query);
    const r = await db.query(`SELECT id, game, action, token, amount, bet, payout, nonce, params, result, created_at FROM bets
      WHERE user_id=$1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [u.userId, q.before ?? null, q.limit]);
    return r.rows;
  });

  // ---- money
  app.get("/deposits", async (req) => {
    const u = me(req);
    const r = await db.query("SELECT tx_hash, block_number, data, processed_at FROM chain_events WHERE event='Deposited' AND data->>'user'=$1 ORDER BY block_number DESC LIMIT 50", [u.address]);
    return r.rows;
  });
  app.post("/withdrawals", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const u = me(req);
    if (!chain || !signers) throw new AppError(503, "withdrawals_offline", "Withdrawals are offline.");
    const b = z.object({ token: addr, amount: uint }).parse(req.body);
    return requestWithdrawal(db, cfg, chain, signers, u.userId, b.token, b.amount);
  });
  app.get("/withdrawals", async (req) => listWithdrawals(db, me(req).userId));

  // ---- responsible gaming
  app.post("/self-exclude", async (req) => {
    const u = me(req);
    const b = z.object({ days: z.number().int().min(1).max(3650) }).parse(req.body);
    await db.query("UPDATE users SET self_excluded_until = GREATEST(COALESCE(self_excluded_until, now()), now() + make_interval(days => $2)) WHERE id=$1", [u.userId, b.days]);
    return { ok: true };
  });

  return app;
}
