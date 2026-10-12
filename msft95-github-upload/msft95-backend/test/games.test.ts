import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, testConfig, fund, bal, TOKEN, ETH } from "./helpers.js";
import type { Db } from "../src/db.js";
import { tx } from "../src/db.js";
import { playSlots, playKeno } from "../src/games/service.js";
import { rotate } from "../src/fair.js";
import { slotsRound, kenoRound, SLOTS_MATH, KENO_MATH } from "../src/games/rounds.js";
import { floats } from "../src/fair.js";
import { checkIntegrity } from "../src/ledger.js";

let db: Db; const cfg = testConfig();
const rid = () => "r" + Math.random().toString(36).slice(2, 12);
const E = 10n ** 18n;
let alice: string, bob: string;

/** results are random: an earlier spin may have triggered free spins, so play any running bonus to the end first */
async function finishBonuses(userId: string) {
  for (let i = 0; i < 1000; i++) {
    const f = await db.query("SELECT game FROM features WHERE user_id=$1 AND token=$2", [userId, TOKEN]);
    if (!f.rowCount) return;
    for (const r of f.rows) {
      if (r.game === "slots") await playSlots(db, cfg, { userId, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin" });
      else await playKeno(db, cfg, { userId, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin", picks: [1] });
    }
  }
  throw new Error("bonus never ended");
}

beforeAll(async () => {
  db = await freshDb();
  alice = await fund(db, "0x00000000000000000000000000000000000000a1", TOKEN, 1000n * E);
  bob = await fund(db, "0x00000000000000000000000000000000000000b2", TOKEN, 5n * E);
});
afterAll(async () => { await db.end(); });

describe("slots", () => {
  it("debits the bet and credits the win, exactly", async () => {
    await finishBonuses(alice);
    const before = await bal(db, alice, TOKEN);
    const r: any = await playSlots(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin" });
    expect(BigInt(r.amount)).toBe(E);
    expect(await bal(db, alice, TOKEN)).toBe(before - E + BigInt(r.payout));
    expect(BigInt(r.balance)).toBe(before - E + BigInt(r.payout));
    expect(await checkIntegrity(db)).toEqual([]);
  });
  it("replays the same requestId instead of betting twice", async () => {
    const id = rid();
    const a: any = await playSlots(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: id, action: "spin" });
    const after = await bal(db, alice, TOKEN);
    const b: any = await playSlots(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: id, action: "spin" });
    expect(b.id).toBe(a.id); expect(b.replay).toBe(true);
    expect(await bal(db, alice, TOKEN)).toBe(after);
  });
  it("every result can be recomputed from the revealed seed", async () => {
    const played: any[] = [];
    for (let i = 0; i < 5; i++) played.push(await playSlots(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin" }));
    const rev = await tx(db, (c) => rotate(c, alice, cfg.SEED_KEY, "my-lucky-seed"));
    const { sha256 } = await import("../src/fair.js");
    expect(sha256(rev.previous.serverSeed)).toBe(rev.previous.serverSeedHash);
    for (const p of played.filter((x) => x.action === "spin")) {
      expect(p.result.serverSeedHash).toBe(rev.previous.serverSeedHash);
      const again = slotsRound(floats(rev.previous.serverSeed, rev.previous.clientSeed, BigInt(p.nonce)), BigInt(p.bet), false);
      expect(again.stops).toEqual(p.result.stops);
      expect(again.total.toString()).toBe(p.result.rawWin);
    }
    expect(rev.current.clientSeed).toBe("my-lucky-seed");
  });
  it("enforces bet limits and the house's max payout", async () => {
    await finishBonuses(alice);
    await expect(playSlots(db, cfg, { userId: alice, token: TOKEN, bet: "1", requestId: rid(), action: "spin" })).rejects.toMatchObject({ code: "bet_too_small" });
    await expect(playSlots(db, cfg, { userId: alice, token: TOKEN, bet: (2000n * E).toString(), requestId: rid(), action: "spin" })).rejects.toMatchObject({ code: "bet_too_big" });
    const tight = testConfig({}, [{ symbol: "TOK", address: TOKEN, decimals: 18, minBet: "1000", maxBet: (100n * E).toString(), maxPayout: (1000n * E).toString(), minWithdrawal: "1", userDailyWithdrawal: "1" }]);
    await expect(playSlots(db, tight, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin" })).rejects.toMatchObject({ code: "bet_too_big" });
    await expect(playSlots(db, cfg, { userId: alice, token: "0x00000000000000000000000000000000000000ff", bet: E.toString(), requestId: rid(), action: "spin" })).rejects.toMatchObject({ code: "bad_token" });
  });
  it("can't bet more than the balance, even with 30 bets at once", async () => {
    const start = await bal(db, bob, TOKEN);   // 5 tokens
    const res = await Promise.allSettled(Array.from({ length: 30 }, () => playSlots(db, cfg, { userId: bob, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin" })));
    const ok = res.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const spent = ok.reduce((s, r) => s + BigInt(r.value.amount), 0n), won = ok.reduce((s, r) => s + BigInt(r.value.payout), 0n);
    expect(await bal(db, bob, TOKEN)).toBe(start - spent + won);
    expect(await bal(db, bob, TOKEN)).toBeGreaterThanOrEqual(0n);
    for (const r of res) if (r.status === "rejected") expect((r.reason as any).code).toBe("insufficient_funds");
    expect(await checkIntegrity(db)).toEqual([]);
  });
  it("buy bonus: charges 24x, then 10 free spins that cost nothing and end by themselves", async () => {
    await finishBonuses(alice);
    const before = await bal(db, alice, TOKEN);
    const buy: any = await playSlots(db, cfg, { userId: alice, token: ETH === TOKEN ? ETH : TOKEN, bet: E.toString(), requestId: rid(), action: "buy" });
    expect(BigInt(buy.amount)).toBe(E * BigInt(SLOTS_MATH.buyX));
    expect(buy.feature.left).toBe(SLOTS_MATH.freeSpins);
    await expect(playSlots(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "buy" })).rejects.toMatchObject({ code: "feature_running" });
    let wonFree = 0n, n = 0, last: any = buy;
    while (last.feature && n < 500) {
      // the bet sent during free spins is ignored: the bonus bet is used
      last = await playSlots(db, cfg, { userId: alice, token: TOKEN, bet: (7n * E).toString(), requestId: rid(), action: "spin" });
      expect(last.action).toBe("free"); expect(last.amount).toBe("0"); expect(BigInt(last.bet)).toBe(E);
      wonFree += BigInt(last.payout); n++;
    }
    expect(n).toBeGreaterThanOrEqual(SLOTS_MATH.freeSpins);
    expect(wonFree).toBeLessThanOrEqual(E * BigInt(SLOTS_MATH.maxWinX));
    expect(await bal(db, alice, TOKEN)).toBe(before - E * BigInt(SLOTS_MATH.buyX) + wonFree);
    const next: any = await playSlots(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin" });
    expect(["spin"]).toContain(next.action);
  });
});

describe("keno", () => {
  it("plays, pays the paytable and validates picks", async () => {
    await finishBonuses(alice);
    const picks = [5, 12, 33, 47, 80];
    const r: any = await playKeno(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin", picks });
    expect(r.result.drawn).toHaveLength(20);
    const hits = picks.filter((p) => r.result.drawn.includes(p)).length;
    expect(r.result.catch).toBe(hits);
    const x = KENO_MATH.pays[5]![hits] ?? 0;
    expect(BigInt(r.payout)).toBe((E * BigInt(Math.round(1000 * x))) / 1000n);
    await finishBonuses(alice);   // that game may have won the bonus; free games ignore new picks
    for (const bad of [[], [0], [81], [1, 1], Array.from({ length: 11 }, (_, i) => i + 1), [1.5]])
      await expect(playKeno(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin", picks: bad as any })).rejects.toMatchObject({ code: "bad_picks" });
  });
  it("buy bonus: 12 free games on the same picks, no retrigger", async () => {
    await finishBonuses(alice);
    const picks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const buy: any = await playKeno(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "buy", picks });
    expect(BigInt(buy.amount)).toBe(E * BigInt(KENO_MATH.buyX[10]!));
    let n = 0, last: any = buy;
    while (last.feature) {
      last = await playKeno(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin", picks: [70] });
      expect(last.params.picks).toEqual(picks); expect(last.amount).toBe("0"); n++;
    }
    expect(n).toBe(KENO_MATH.freeGames);
    expect(await checkIntegrity(db)).toEqual([]);
  });
  it("a whole bonus never pays more than maxWinX x the bet (keno and slots)", async () => {
    await finishBonuses(alice);
    const capK = E * BigInt(KENO_MATH.maxWinX), capS = E * BigInt(SLOTS_MATH.maxWinX);
    // a bonus that has already won almost the whole cap
    await db.query("INSERT INTO features(user_id,game,token,bet,left_n,total_n,won,params) VALUES ($1,'keno',$2,$3,12,12,$4,$5)",
      [alice, TOKEN, E.toString(), (capK - 1n).toString(), JSON.stringify({ picks: [1, 2, 3, 4, 5, 6, 7] })]);
    await db.query("INSERT INTO features(user_id,game,token,bet,left_n,total_n,won) VALUES ($1,'slots',$2,$3,10,10,$4)",
      [alice, TOKEN, E.toString(), (capS - 1n).toString()]);
    // play only the injected bonuses (stop at the first round that ends each one)
    let paidK = 0n, paidS = 0n, liveK = true, liveS = true;
    for (let i = 0; i < 200 && (liveK || liveS); i++) {
      if (liveK) { const k: any = await playKeno(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin", picks: [9] });
        expect(k.action).toBe("free"); paidK += BigInt(k.payout); liveK = !!k.feature; }
      if (liveS) { const sl: any = await playSlots(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin" });
        expect(sl.action).toBe("free"); paidS += BigInt(sl.payout); liveS = !!sl.feature; }
    }
    expect(liveK || liveS).toBe(false);   // both bonuses ended
    expect(paidK).toBeLessThanOrEqual(1n);
    expect(paidS).toBeLessThanOrEqual(1n);
    expect(await checkIntegrity(db)).toEqual([]);
  });

  it("recomputes from the revealed seed", async () => {
    await finishBonuses(alice);
    const r: any = await playKeno(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin", picks: [9, 19, 29] });
    const rev = await tx(db, (c) => rotate(c, alice, cfg.SEED_KEY));
    const again = kenoRound(floats(rev.previous.serverSeed, rev.previous.clientSeed, BigInt(r.nonce)), [9, 19, 29], E, false);
    expect(again.drawn).toEqual(r.result.drawn);
  });
  it("respects self-exclusion and the betting kill switch", async () => {
    await db.query("UPDATE system_flags SET value=true WHERE name='betting_frozen'");
    await expect(playKeno(db, cfg, { userId: alice, token: TOKEN, bet: E.toString(), requestId: rid(), action: "spin", picks: [1] })).rejects.toMatchObject({ code: "betting_frozen" });
    await db.query("UPDATE system_flags SET value=false WHERE name='betting_frozen'");
    await db.query("UPDATE users SET self_excluded_until = now() + interval '1 day' WHERE id=$1", [bob]);
    await expect(playKeno(db, cfg, { userId: bob, token: TOKEN, bet: "1000", requestId: rid(), action: "spin", picks: [1] })).rejects.toMatchObject({ code: "self_excluded" });
  });
});
