import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ethers } from "ethers";
import { SiweMessage } from "siwe";
import type { FastifyInstance } from "fastify";
import { freshDb, testConfig, fund, TOKEN } from "./helpers.js";
import type { Db } from "../src/db.js";
import { buildServer } from "../src/server.js";

let db: Db, app: FastifyInstance;
const cfg = testConfig({ RATE_LIMIT_MULTIPLIER: "100" });
const wallet = ethers.Wallet.createRandom();
const ORIGIN = "https://msft95.test";

async function siwe(over: Partial<Record<string, any>> = {}) {
  const n = await app.inject({ method: "GET", url: "/auth/nonce" });
  const nonce = n.json().nonce;
  const m = new SiweMessage({ domain: "msft95.test", address: over.address ?? wallet.address, statement: "Sign in to MSFT95", uri: ORIGIN, version: "1", chainId: 31337, nonce, issuedAt: new Date().toISOString(), ...over });
  const message = m.prepareMessage();
  return { message, signature: await (over.signer ?? wallet).signMessage(message), nonce };
}
const loginWith = (b: any) => app.inject({ method: "POST", url: "/auth/login", headers: { origin: ORIGIN, "x-session-token": "body" }, payload: { message: b.message, signature: b.signature } });

beforeAll(async () => { db = await freshDb(); app = await buildServer({ db, cfg }); });
afterAll(async () => { await app.close(); await db.end(); });

describe("sign in with ethereum", () => {
  let token = "";
  it("logs in with a valid signature and sets an httpOnly cookie", async () => {
    const r = await loginWith(await siwe());
    expect(r.statusCode).toBe(200);
    expect(r.json().address).toBe(wallet.address.toLowerCase());
    expect(String(r.headers["set-cookie"])).toMatch(/HttpOnly/i);
    token = r.json().token;
    const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer " + token } });
    expect(me.statusCode).toBe(200);
    expect(me.json().seed.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("won't accept the same signed message twice", async () => {
    const b = await siwe();
    expect((await loginWith(b)).statusCode).toBe(200);
    expect((await loginWith(b)).json().error).toBe("bad_nonce");
  });
  it("rejects other domains, chains, made-up nonces, stale messages and wrong signers", async () => {
    expect((await loginWith(await siwe({ domain: "evil.test" }))).json().error).toBe("wrong_domain");
    expect((await loginWith(await siwe({ uri: "https://evil.test" }))).json().error).toBe("wrong_uri");
    expect((await loginWith(await siwe({ chainId: 1 }))).json().error).toBe("wrong_chain");
    expect((await loginWith(await siwe({ issuedAt: new Date(Date.now() - 3600e3).toISOString() }))).json().error).toBe("stale_message");
    const fake = await siwe(); const forged = fake.message.replace(fake.nonce, "abcdefabcdefabcdefabcdefabcdef12");
    expect((await loginWith({ message: forged, signature: await wallet.signMessage(forged) })).json().error).toBe("bad_nonce");
    const other = ethers.Wallet.createRandom();
    expect((await loginWith(await siwe({ signer: other }))).json().error).toBe("bad_signature");
  });
  it("requires a session for player endpoints, and logout ends it", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: "Bearer " + token, origin: ORIGIN } });
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer " + token } })).statusCode).toBe(401);
  });
});

describe("game endpoints", () => {
  let auth: Record<string, string>;
  beforeAll(async () => {
    const r = await loginWith(await siwe());
    auth = { authorization: "Bearer " + r.json().token, origin: ORIGIN };
    await fund(db, wallet.address, TOKEN, 100n * 10n ** 18n);
  });
  it("spins slots and plays keno", async () => {
    const s = await app.inject({ method: "POST", url: "/games/slots", headers: auth, payload: { token: TOKEN, bet: "1000000000000000000", requestId: "abc12345" } });
    expect(s.statusCode).toBe(200); expect(s.json().result.stops).toHaveLength(6);
    const k = await app.inject({ method: "POST", url: "/games/keno", headers: auth, payload: { token: TOKEN, bet: "1000000000000000000", requestId: "abc12346", picks: [1, 2, 3] } });
    expect(k.statusCode).toBe(200); expect(k.json().result.drawn).toHaveLength(20);
    const h = await app.inject({ method: "GET", url: "/bets?limit=5", headers: auth });
    expect(h.json().length).toBe(2);
  });
  it("rejects malformed input with 400 and no charge", async () => {
    for (const payload of [{ token: TOKEN, bet: "-1", requestId: "abc12347" }, { token: TOKEN, bet: "1e18", requestId: "abc12348" }, { token: "x", bet: "1", requestId: "abc12349" },
                           { token: TOKEN, bet: "1000000", requestId: "short" }, { token: TOKEN, bet: "1000000", requestId: "abc12350", action: "steal" }]) {
      const r = await app.inject({ method: "POST", url: "/games/slots", headers: auth, payload });
      expect(r.statusCode).toBe(400);
    }
  });
  it("refuses POSTs from other websites", async () => {
    const r = await app.inject({ method: "POST", url: "/games/slots", headers: { ...auth, origin: "https://evil.test" }, payload: { token: TOKEN, bet: "1000000", requestId: "abc12399" } });
    expect(r.statusCode).toBe(403);
  });
  it("rotates seeds and lists revealed ones", async () => {
    const r = await app.inject({ method: "POST", url: "/fair/rotate", headers: auth, payload: { clientSeed: "hon-hon" } });
    expect(r.json().previous.serverSeed).toMatch(/^[0-9a-f]{64}$/);
    const h = await app.inject({ method: "GET", url: "/fair/history", headers: auth });
    expect(h.json()[0].server_seed).toBe(r.json().previous.serverSeed);
  });
  it("replays a requestId with the current balance, and refuses it on another game", async () => {
    const a = await app.inject({ method: "POST", url: "/games/slots", headers: auth, payload: { token: TOKEN, bet: "1000000000000000000", requestId: "replay-123" } });
    const b = await app.inject({ method: "POST", url: "/games/slots", headers: auth, payload: { token: TOKEN, bet: "1000000000000000000", requestId: "replay-123" } });
    expect(b.json().id).toBe(a.json().id); expect(b.json().replay).toBe(true); expect(b.json().balance).toMatch(/^\d+$/);
    const k = await app.inject({ method: "POST", url: "/games/keno", headers: auth, payload: { token: TOKEN, bet: "1000000000000000000", requestId: "replay-123", picks: [1] } });
    expect(k.statusCode).toBe(409); expect(k.json().error).toBe("request_id_reused");
  });
  it("bets carry everything needed to verify them, including the server seed once revealed", async () => {
    await app.inject({ method: "POST", url: "/fair/rotate", headers: auth, payload: {} });
    const h = await app.inject({ method: "GET", url: "/bets?limit=100", headers: auth });
    const old = h.json().find((x: any) => x.revealed_server_seed);
    expect(old.server_seed_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(old.revealed_server_seed).toMatch(/^[0-9a-f]{64}$/);
    const byHash = await app.inject({ method: "GET", url: "/fair/history?hash=" + old.server_seed_hash, headers: auth });
    expect(byHash.json()[0].server_seed).toBe(old.revealed_server_seed);
  });
  it("the next server seed is committed before the player picks a client seed", async () => {
    const me1 = await app.inject({ method: "GET", url: "/me", headers: auth });
    const committed = me1.json().seed.nextServerSeedHash;
    expect(committed).toMatch(/^[0-9a-f]{64}$/);
    const r = await app.inject({ method: "POST", url: "/fair/rotate", headers: auth, payload: { clientSeed: "chosen-after-commit" } });
    expect(r.json().current.serverSeedHash).toBe(committed);           // the server could not pick it after seeing our seed
    expect(r.json().current.clientSeed).toBe("chosen-after-commit");
  });
  it("concurrent first /me calls never fail", async () => {
    const w2 = ethers.Wallet.createRandom();
    const b = await siwe({ address: w2.address, signer: w2 });
    const t = (await loginWith(b)).json().token;
    const res = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer " + t } })));
    expect(res.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
  });
  it("bad input is a 4xx, never a 500", async () => {
    expect((await app.inject({ method: "GET", url: "/bets?before=10000000000000000000", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/games/slots", headers: { ...auth, "content-type": "application/json" }, payload: JSON.stringify({ pad: "x".repeat(20000) }) })).statusCode).toBe(413);
    expect((await loginWith(await siwe({ uri: "https://msft95.test:99999" }))).json().error).toBe("wrong_uri");
  });
  it("cookie sessions need an Origin header on POST; the token isn't returned unless asked for", async () => {
    const b = await siwe();
    const r = await app.inject({ method: "POST", url: "/auth/login", headers: { origin: ORIGIN }, payload: { message: b.message, signature: b.signature } });
    expect(r.json().token).toBeUndefined();
    const cookie = String(r.headers["set-cookie"]).split(";")[0];
    const noOrigin = await app.inject({ method: "POST", url: "/self-exclude", headers: { cookie }, payload: { days: 1 } });
    expect(noOrigin.statusCode).toBe(403);
    const ok = await app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(ok.statusCode).toBe(200);
  });
  it("ignores forged X-Forwarded-For (no proxy configured): rate limits still apply", async () => {
    const strict = await buildServer({ db, cfg: testConfig() });
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await strict.inject({ method: "GET", url: "/auth/nonce", headers: { "x-forwarded-for": `10.0.${i}.1` } })).statusCode);
    expect(codes).toContain(429);
    await strict.close();
  });
  it("outside tests the session cookie is always Secure", async () => {
    const prod = await buildServer({ db, cfg: testConfig({ NODE_ENV: "production", RATE_LIMIT_MULTIPLIER: "100" }) });
    const r = await prod.inject({ method: "POST", url: "/auth/login", headers: { origin: ORIGIN }, payload: await siwe().then((b) => ({ message: b.message, signature: b.signature })) });
    expect(String(r.headers["set-cookie"])).toMatch(/; Secure/);
    await prod.close();
  });
  it("reports withdrawals offline when no chain is connected", async () => {
    const r = await app.inject({ method: "POST", url: "/withdrawals", headers: auth, payload: { token: TOKEN, amount: "1" } });
    expect(r.json().error).toBe("withdrawals_offline");
  });
});
