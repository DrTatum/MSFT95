import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, TOKEN } from "./helpers.js";
import { tx, type Db } from "../src/db.js";
import { account, post, checkIntegrity, DuplicateEntry } from "../src/ledger.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); await db.query("INSERT INTO users(address) VALUES ('0x00000000000000000000000000000000000000a1')"); });
afterAll(async () => { await db.end(); });

describe("ledger", () => {
  it("books balanced entries and keeps balances equal to postings", async () => {
    await tx(db, async (c) => {
      const u = await account(c, "user", TOKEN, "1"), d = await account(c, "deposits_in", TOKEN);
      await post(c, "deposit", "d1", [{ account: u, amount: 500n }, { account: d, amount: -500n }]);
    });
    expect(await checkIntegrity(db)).toEqual([]);
    const r = await db.query("SELECT balance FROM accounts WHERE kind='user'");
    expect(r.rows[0].balance).toBe("500");
  });
  it("refuses unbalanced entries", async () => {
    await expect(tx(db, async (c) => {
      const u = await account(c, "user", TOKEN, "1"), h = await account(c, "house", TOKEN);
      await post(c, "bet", "x", [{ account: u, amount: -5n }, { account: h, amount: 4n }]);
    })).rejects.toThrow(/unbalanced/);
  });
  it("never books the same event twice", async () => {
    await expect(tx(db, async (c) => {
      const u = await account(c, "user", TOKEN, "1"), d = await account(c, "deposits_in", TOKEN);
      await post(c, "deposit", "d1", [{ account: u, amount: 500n }, { account: d, amount: -500n }]);
    })).rejects.toBeInstanceOf(DuplicateEntry);
  });
  it("never lets a player balance go negative", async () => {
    await expect(tx(db, async (c) => {
      const u = await account(c, "user", TOKEN, "1"), h = await account(c, "house", TOKEN);
      await post(c, "bet", "big", [{ account: u, amount: -501n }, { account: h, amount: 501n }]);
    })).rejects.toMatchObject({ code: "insufficient_funds" });
    const r = await db.query("SELECT balance FROM accounts WHERE kind='user'");
    expect(r.rows[0].balance).toBe("500");
  });
  it("integrity check catches a balance edited by hand", async () => {
    await db.query("UPDATE accounts SET balance = balance + 1 WHERE kind='user'");
    expect((await checkIntegrity(db)).length).toBeGreaterThan(0);
    await db.query("UPDATE accounts SET balance = balance - 1 WHERE kind='user'");
    expect(await checkIntegrity(db)).toEqual([]);
  });
});
