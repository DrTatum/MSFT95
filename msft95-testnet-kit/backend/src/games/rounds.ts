/* Pure game rounds: given the fair random stream, what happened and how much it pays.
   Payouts are exact integers: the site's math is evaluated at a fixed scale and then applied to the bet in base units. */
import { SLOTS_MATH, KENO_MATH, slotsEvaluate, slotsRandomStops, kenoDraw, kenoEvaluate } from "./math.js";

const SLOT_SCALE = 4000;   // 40 lines -> line bet 100: every slots pay is a whole number at this scale
const KENO_SCALE = 1000;   // keno pays have at most one decimal (e.g. 2.9x)

export interface SlotsRound { stops: number[]; total: bigint; trigger: boolean; tumbles: number; lines: number; scatter: number }
export function slotsRound(rand: () => number, bet: bigint, free: boolean): SlotsRound {
  const stops = slotsRandomStops(rand);
  const ev = slotsEvaluate(stops, SLOT_SCALE, free ? SLOTS_MATH.fsMult : 1);
  if (!Number.isSafeInteger(ev.total)) throw new Error("slots total not an integer");
  return { stops, total: (bet * BigInt(ev.total)) / BigInt(SLOT_SCALE), trigger: ev.trigger, tumbles: ev.steps.length, lines: ev.wins.length, scatter: ev.scatter.cells.length };
}
export const slotsMaxWin = (bet: bigint) => bet * BigInt(SLOTS_MATH.maxWinX);
export const slotsBuyCost = (bet: bigint) => bet * BigInt(SLOTS_MATH.buyX);

export interface KenoRound { drawn: number[]; hits: number[]; catch: number; win: bigint; bonus: boolean; catBall: boolean }
export function kenoRound(rand: () => number, picks: number[], bet: bigint, free: boolean): KenoRound {
  const drawn = kenoDraw(rand);
  const ev = kenoEvaluate(picks, drawn, KENO_SCALE, free ? KENO_MATH.fgMult : 1);
  if (!Number.isSafeInteger(ev.win)) throw new Error("keno win not an integer");
  return { drawn, hits: ev.hits, catch: ev.catch, win: (bet * BigInt(ev.win)) / BigInt(KENO_SCALE), bonus: ev.bonus, catBall: ev.catBall };
}
export const kenoMaxWin = (bet: bigint) => bet * BigInt(KENO_MATH.maxWinX);
export function kenoBuyCost(bet: bigint, picks: number): bigint {
  const x = KENO_MATH.buyX[picks]; if (!x) throw new Error("bad picks"); return bet * BigInt(x);
}

export function validPicks(p: unknown): p is number[] {
  return Array.isArray(p) && p.length >= KENO_MATH.minPicks && p.length <= KENO_MATH.maxPicks &&
    p.every((n) => Number.isInteger(n) && n >= 1 && n <= KENO_MATH.numbers) && new Set(p).size === p.length;
}
export { SLOTS_MATH, KENO_MATH };
