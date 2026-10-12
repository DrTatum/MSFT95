import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { floats, encryptSeed, decryptSeed, sha256 } from "../src/fair.js";

describe("provably fair floats", () => {
  it("matches the published formula byte for byte", () => {
    const h = crypto.createHmac("sha256", "server").update("client:7:0").digest();
    const expected = h[0]! / 256 + h[1]! / 65536 + h[2]! / 16777216 + h[3]! / 4294967296;
    const r = floats("server", "client", 7);
    expect(r()).toBe(expected);
    const f2 = h[4]! / 256 + h[5]! / 65536 + h[6]! / 16777216 + h[7]! / 4294967296;
    expect(r()).toBe(f2);
    for (let i = 0; i < 6; i++) r();               // 8 floats per hash
    const h1 = crypto.createHmac("sha256", "server").update("client:7:1").digest();   // then the next cursor
    expect(r()).toBe(h1[0]! / 256 + h1[1]! / 65536 + h1[2]! / 16777216 + h1[3]! / 4294967296);
  });
  it("is deterministic and changes with every input", () => {
    const a = floats("s", "c", 1)(), b = floats("s", "c", 1)();
    expect(a).toBe(b);
    expect(floats("s", "c", 2)()).not.toBe(a);
    expect(floats("s2", "c", 1)()).not.toBe(a);
    expect(floats("s", "c2", 1)()).not.toBe(a);
  });
  it("is uniform (chi-square over 10 buckets, 200k draws)", () => {
    const n = 200000, k = 10, buckets = new Array(k).fill(0);
    for (let i = 0; i < n / 8; i++) { const r = floats("seed", "client", i); for (let j = 0; j < 8; j++) { const f = r(); expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThan(1); buckets[Math.floor(f * k)]++; } }
    const e = n / k, chi = buckets.reduce((s, o) => s + (o - e) ** 2 / e, 0);
    expect(chi).toBeLessThan(27.9);   // p = 0.001 for 9 degrees of freedom
  });
  it("encrypts server seeds at rest (and detects tampering)", () => {
    const key = "22".repeat(32), seed = "ab".repeat(32);
    const enc = encryptSeed(seed, key);
    expect(enc).not.toContain(seed);
    expect(decryptSeed(enc, key)).toBe(seed);
    const bad = enc.slice(0, -2) + (enc.endsWith("00") ? "11" : "00");
    expect(() => decryptSeed(bad, key)).toThrow();
    expect(() => decryptSeed(enc, "33".repeat(32))).toThrow();
    expect(sha256(seed)).toMatch(/^[0-9a-f]{64}$/);
  });
});
