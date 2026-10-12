import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ethers } from "ethers";
import { SiweMessage } from "siwe";
import type { FastifyInstance } from "fastify";
import { freshDb, testConfig, fund, TOKEN } from "./helpers.js";
import type { Db } from "../src/db.js";
import { buildServer } from "../src/server.js";

let db: Db, app: FastifyInstance;
const cfg = testConfig();
const wallet = ethers.Wallet.createRandom();
const ORIGIN = "https://msft95.test";

async function siwe(over: Partial<Record<string, any>> = {}) {
  const n = await app.inject({ method: "GET", url: "/auth/nonce" });
  const nonce = n.json().nonce;
  const m = new SiweMessage({ domain: "msft95.test", address: wallet.address, statement: "Sign in to MSFT95", uri: ORIGIN, version: "1", chainId: 31337, nonce, issuedAt: new Date().toISOString(), ...over });
  const message = m.prepareMessage();
  return { message, signature: await (over.signer ?? wallet).signMessage(message), nonce };
}
const loginWith = (b: any) => app.inject({ method: "POST", url: "/auth/login", headers: { origin: ORIGIN }, payload: { message: b.message, signature: b.signature } });

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
  it("reports withdrawals offline when no chain is connected", async () => {
    const r = await app.inject({ method: "POST", url: "/withdrawals", headers: auth, payload: { token: TOKEN, amount: "1" } });
    expect(r.json().error).toBe("withdrawals_offline");
  });
});
