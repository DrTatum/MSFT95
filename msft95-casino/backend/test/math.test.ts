import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { MATH_SOURCE_SHA256, slotsEvaluate, SLOTS_MATH, kenoEvaluate, KENO_MATH } from "../src/games/math.js";
import { slotsRound, kenoRound } from "../src/games/rounds.js";
import { floats } from "../src/fair.js";

const SITE = process.env.SITE_HTML || "/mnt/user-data/outputs/msft95-site/index.html";

describe("game math", () => {
  it.skipIf(!fs.existsSync(SITE))("is the same code the website runs", async () => {
    const src = fs.readFileSync(SITE, "utf8");
    const a = src.indexOf("var SLOTS_MATH={"), b = src.indexOf("// unbiased 0..1 from the browser", a);
    const c = src.indexOf("var KENO_MATH={"), d = src.indexOf("/* ================= Kimmy Keno — the app", c);
    const crypto = await import("node:crypto");
    expect(crypto.createHash("sha256").update(src.slice(a, b) + "\n" + src.slice(c, d)).digest("hex")).toBe(MATH_SOURCE_SHA256);
  });
  it("slots pays exact whole numbers at the server scale", () => {
    for (let i = 0; i < 20000; i++) {
      const r = floats("s", "c", i);
      const stops = SLOTS_MATH.strips.map((st) => Math.floor(r() * st.length));
      for (const m of [1, SLOTS_MATH.fsMult]) expect(Number.isSafeInteger(slotsEvaluate(stops, 4000, m).total)).toBe(true);
    }
  });
  it("keno pays exact whole numbers at the server scale", () => {
    for (let n = 1; n <= 10; n++) for (const [hits, x] of Object.entries(KENO_MATH.pays[n]!)) {
      const picks = Array.from({ length: n }, (_, i) => i + 1), drawn = [...picks.slice(0, Number(hits)), ...Array.from({ length: 20 - Number(hits) }, (_, i) => 61 + i)];
      const ev = kenoEvaluate(picks, drawn, 1000, 2);
      expect(Number.isSafeInteger(ev.win)).toBe(true);
      expect(ev.win).toBe(Math.min(Math.round(1000 * x * 2), 1000 * KENO_MATH.maxWinX));
    }
  });
  it("slots return to player is close to the published figure (400k spins incl. free spins)", () => {
    // simulate with the server's own round function: base spins, plus the free spins they trigger
    const bet = 1_000_000n; let wagered = 0n, won = 0n;
    for (let i = 0; i < 400000; i++) {
      const r = floats("rtp-server", "rtp-client", i);
      wagered += bet;
      const base = slotsRound(r, bet, false); let w = base.total > bet * 5000n ? bet * 5000n : base.total;
      if (base.trigger) {
        let left = SLOTS_MATH.freeSpins, fw = 0n, j = 0;
        while (left > 0 && fw < bet * 5000n) { left--; const f = slotsRound(floats("rtp-server", "fs" + i, j++), bet, true); fw += f.total; if (f.trigger) left += SLOTS_MATH.freeSpins; }
        w += fw > bet * 5000n ? bet * 5000n : fw;
      }
      won += w;
    }
    const rtp = Number(won * 10000n / wagered) / 10000;
    expect(rtp).toBeGreaterThan(0.85); expect(rtp).toBeLessThan(1.07);   // high-variance game: wide band for 400k spins
  });
  it("keno draws 20 different numbers from 1-80", () => {
    for (let i = 0; i < 2000; i++) {
      const k = kenoRound(floats("k", "c", i), [1, 2, 3], 1000n, false);
      expect(new Set(k.drawn).size).toBe(20);
      expect(k.drawn.every((n) => n >= 1 && n <= 80)).toBe(true);
    }
  });
});
