import type { Config, TokenCfg } from "../config.js";
import { tx, type Db, type Tx } from "../db.js";
import { AppError, bad, denied } from "../errors.js";
import { account, balance, lockUser, post } from "../ledger.js";
import { floats, lockSeed, useNonce } from "../fair.js";
import { SLOTS_MATH, KENO_MATH, slotsRound, slotsMaxWin, slotsBuyCost, kenoRound, kenoMaxWin, kenoBuyCost, validPicks } from "./rounds.js";

type Game = "slots" | "keno";
export interface PlayInput { userId: string; token: string; bet: string; requestId: string; action: "spin" | "buy"; picks?: number[] }

const REQ_RE = /^[A-Za-z0-9_-]{8,64}$/;

function tokenOf(cfg: Config, token: string): TokenCfg {
  const t = cfg.tokens.get(String(token).toLowerCase());
  if (!t) throw bad("bad_token", "That token isn't accepted.");
  return t;
}

function checkBet(t: TokenCfg, bet: bigint, maxWin: bigint) {
  if (bet < BigInt(t.minBet)) throw bad("bet_too_small", `Minimum bet is ${t.minBet}.`);
  if (bet > BigInt(t.maxBet)) throw bad("bet_too_big", `Maximum bet is ${t.maxBet}.`);
  if (maxWin > BigInt(t.maxPayout)) throw bad("bet_too_big", "That bet could win more than the house allows for this token.");
}

async function guard(c: Tx, userId: string) {
  const f = await c.query("SELECT value FROM system_flags WHERE name='betting_frozen'");
  if (f.rows[0]?.value) throw new AppError(503, "betting_frozen", "Betting is paused for maintenance.");
  const u = await c.query("SELECT self_excluded_until FROM users WHERE id=$1", [userId]);
  const until = u.rows[0]?.self_excluded_until;
  if (until && new Date(until) > new Date()) throw denied("self_excluded", "Your account is in a self-exclusion period.");
}

async function existing(c: Tx, userId: string, requestId: string) {
  const r = await c.query("SELECT * FROM bets WHERE user_id=$1 AND request_id=$2", [userId, requestId]);
  return r.rows[0] ? betView(r.rows[0]) : null;
}

function betView(r: any) {
  return { id: r.id, game: r.game, action: r.action, token: r.token, amount: r.amount, bet: r.bet, payout: r.payout,
    nonce: r.nonce, params: r.params, result: r.result, createdAt: r.created_at, replay: true };
}

async function featureRow(c: Tx, userId: string, game: Game, token: string) {
  const r = await c.query("SELECT * FROM features WHERE user_id=$1 AND game=$2 AND token=$3 FOR UPDATE", [userId, game, token]);
  return r.rows[0] ?? null;
}

async function insertBet(c: Tx, b: { userId: string; requestId: string; game: Game; action: string; token: string; amount: bigint; bet: bigint; payout: bigint; seedId?: string; nonce?: bigint; params: object; result: object }) {
  const r = await c.query(
    `INSERT INTO bets(user_id, request_id, game, action, token, amount, bet, payout, seed_id, nonce, params, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [b.userId, b.requestId, b.game, b.action, b.token, b.amount.toString(), b.bet.toString(), b.payout.toString(),
     b.seedId ?? null, b.nonce?.toString() ?? null, JSON.stringify(b.params), JSON.stringify(b.result)]);
  return r.rows[0];
}

/** debit stake / credit win against the house account for this token */
async function settle(c: Tx, userId: string, token: string, betId: string, amount: bigint, payout: bigint) {
  const user = await account(c, "user", token, userId), house = await account(c, "house", token);
  if (amount > 0n) await post(c, "bet", betId, [{ account: user, amount: -amount }, { account: house, amount }]);
  if (payout > 0n) await post(c, "win", betId, [{ account: house, amount: -payout }, { account: user, amount: payout }]);
  return balance(c, user);
}

function featureView(f: any) {
  return f ? { bet: f.bet, left: f.left_n, total: f.total_n, won: f.won, bought: f.bought, params: f.params } : null;
}

export async function playSlots(db: Db, cfg: Config, inp: PlayInput) {
  if (!REQ_RE.test(inp.requestId)) throw bad("bad_request_id", "requestId must be 8-64 letters, digits, - or _.");
  const t = tokenOf(cfg, inp.token);
  const reqBet = BigInt(inp.bet);
  return tx(db, async (c) => {
    await lockUser(c, inp.userId);
    const dup = await existing(c, inp.userId, inp.requestId); if (dup) return dup;
    await guard(c, inp.userId);
    const f = await featureRow(c, inp.userId, "slots", t.key);

    if (inp.action === "buy") {
      if (f) throw bad("feature_running", "Finish your free spins first.");
      checkBet(t, reqBet, slotsMaxWin(reqBet));
      const cost = slotsBuyCost(reqBet);
      const row = await insertBet(c, { userId: inp.userId, requestId: inp.requestId, game: "slots", action: "buy", token: t.key, amount: cost, bet: reqBet, payout: 0n, params: {}, result: { freeSpins: SLOTS_MATH.freeSpins } });
      const bal = await settle(c, inp.userId, t.key, row.id, cost, 0n);
      await c.query("INSERT INTO features(user_id,game,token,bet,left_n,total_n,bought) VALUES ($1,'slots',$2,$3,$4,$4,true)", [inp.userId, t.key, reqBet.toString(), SLOTS_MATH.freeSpins]);
      return { ...betView(row), replay: false, balance: bal.toString(), feature: featureView(await featureRow(c, inp.userId, "slots", t.key)) };
    }

    const free = !!f;
    const bet = free ? BigInt(f.bet) : reqBet;
    if (!free) checkBet(t, bet, slotsMaxWin(bet));
    const seed = await lockSeed(c, inp.userId, cfg.SEED_KEY);
    const nonce = await useNonce(c, seed);
    const round = slotsRound(floats(seed.serverSeed, seed.clientSeed, nonce), bet, free);
    const cap = slotsMaxWin(bet);
    let pay = round.total;
    if (free) { const room = cap - BigInt(f.won); pay = pay < room ? pay : (room > 0n ? room : 0n); }
    else if (pay > cap) pay = cap;

    // the feature: free spins left after this round
    let fs: { left: number; total: number; won: bigint } | null = null;
    if (free) {
      fs = { left: f.left_n - 1, total: f.total_n, won: BigInt(f.won) + pay };
      if (round.trigger) { fs.left += SLOTS_MATH.freeSpins; fs.total += SLOTS_MATH.freeSpins; }
      if (fs.won >= cap || fs.left <= 0) fs = null;
    } else if (round.trigger) {
      fs = { left: SLOTS_MATH.freeSpins, total: SLOTS_MATH.freeSpins, won: 0n };
    }

    const row = await insertBet(c, { userId: inp.userId, requestId: inp.requestId, game: "slots", action: free ? "free" : "spin", token: t.key,
      amount: free ? 0n : bet, bet, payout: pay, seedId: seed.id, nonce, params: {},
      result: { stops: round.stops, rawWin: round.total.toString(), trigger: round.trigger, tumbles: round.tumbles, lines: round.lines, scatter: round.scatter,
        fsLeft: fs ? fs.left : 0, fsTotal: fs ? fs.total : 0, fsWon: fs ? fs.won.toString() : (free ? (BigInt(f.won) + pay).toString() : "0"),
        serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, version: SLOTS_MATH.version } });
    const bal = await settle(c, inp.userId, t.key, row.id, free ? 0n : bet, pay);
    if (fs && f) await c.query("UPDATE features SET left_n=$4, total_n=$5, won=$6 WHERE user_id=$1 AND game='slots' AND token=$2 AND bet=$3", [inp.userId, t.key, bet.toString(), fs.left, fs.total, fs.won.toString()]);
    else if (fs) await c.query("INSERT INTO features(user_id,game,token,bet,left_n,total_n,won) VALUES ($1,'slots',$2,$3,$4,$5,$6)", [inp.userId, t.key, bet.toString(), fs.left, fs.total, fs.won.toString()]);
    else if (f) await c.query("DELETE FROM features WHERE user_id=$1 AND game='slots' AND token=$2", [inp.userId, t.key]);
    return { ...betView(row), replay: false, balance: bal.toString(), feature: fs ? { bet: bet.toString(), left: fs.left, total: fs.total, won: fs.won.toString() } : null };
  });
}

export async function playKeno(db: Db, cfg: Config, inp: PlayInput) {
  if (!REQ_RE.test(inp.requestId)) throw bad("bad_request_id", "requestId must be 8-64 letters, digits, - or _.");
  const t = tokenOf(cfg, inp.token);
  const reqBet = BigInt(inp.bet);
  return tx(db, async (c) => {
    await lockUser(c, inp.userId);
    const dup = await existing(c, inp.userId, inp.requestId); if (dup) return dup;
    await guard(c, inp.userId);
    const f = await featureRow(c, inp.userId, "keno", t.key);

    if (inp.action === "buy") {
      if (f) throw bad("feature_running", "Finish your free games first.");
      if (!validPicks(inp.picks)) throw bad("bad_picks", "Pick 1 to 10 different numbers from 1 to 80.");
      checkBet(t, reqBet, kenoMaxWin(reqBet));
      const cost = kenoBuyCost(reqBet, inp.picks.length);
      const row = await insertBet(c, { userId: inp.userId, requestId: inp.requestId, game: "keno", action: "buy", token: t.key, amount: cost, bet: reqBet, payout: 0n, params: { picks: inp.picks }, result: { freeGames: KENO_MATH.freeGames } });
      const bal = await settle(c, inp.userId, t.key, row.id, cost, 0n);
      await c.query("INSERT INTO features(user_id,game,token,bet,left_n,total_n,bought,params) VALUES ($1,'keno',$2,$3,$4,$4,true,$5)", [inp.userId, t.key, reqBet.toString(), KENO_MATH.freeGames, JSON.stringify({ picks: inp.picks })]);
      return { ...betView(row), replay: false, balance: bal.toString(), feature: featureView(await featureRow(c, inp.userId, "keno", t.key)) };
    }

    const free = !!f;
    const bet = free ? BigInt(f.bet) : reqBet;
    const picks: number[] = free ? f.params.picks : (inp.picks as number[]);
    if (!free) { if (!validPicks(picks)) throw bad("bad_picks", "Pick 1 to 10 different numbers from 1 to 80."); checkBet(t, bet, kenoMaxWin(bet)); }
    const seed = await lockSeed(c, inp.userId, cfg.SEED_KEY);
    const nonce = await useNonce(c, seed);
    const round = kenoRound(floats(seed.serverSeed, seed.clientSeed, nonce), picks, bet, free);
    const pay = round.win;   // kenoEvaluate already caps a game at maxWinX

    let fg: { left: number; total: number; won: bigint } | null = null;
    if (free) { fg = { left: f.left_n - 1, total: f.total_n, won: BigInt(f.won) + pay }; if (fg.left <= 0) fg = null; }   // one bonus at a time: no retrigger
    else if (round.bonus) fg = { left: KENO_MATH.freeGames, total: KENO_MATH.freeGames, won: 0n };

    const row = await insertBet(c, { userId: inp.userId, requestId: inp.requestId, game: "keno", action: free ? "free" : "play", token: t.key,
      amount: free ? 0n : bet, bet, payout: pay, seedId: seed.id, nonce, params: { picks },
      result: { drawn: round.drawn, hits: round.hits, catch: round.catch, bonus: round.bonus && !free, fgLeft: fg ? fg.left : 0,
        serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, version: KENO_MATH.version } });
    const bal = await settle(c, inp.userId, t.key, row.id, free ? 0n : bet, pay);
    if (fg && f) await c.query("UPDATE features SET left_n=$3, won=$4 WHERE user_id=$1 AND game='keno' AND token=$2", [inp.userId, t.key, fg.left, fg.won.toString()]);
    else if (fg) await c.query("INSERT INTO features(user_id,game,token,bet,left_n,total_n,params) VALUES ($1,'keno',$2,$3,$4,$4,$5)", [inp.userId, t.key, bet.toString(), fg.left, JSON.stringify({ picks })]);
    else if (f) await c.query("DELETE FROM features WHERE user_id=$1 AND game='keno' AND token=$2", [inp.userId, t.key]);
    return { ...betView(row), replay: false, balance: bal.toString(), feature: fg ? { bet: bet.toString(), left: fg.left, total: fg.total, won: fg.won.toString(), params: { picks } } : null };
  });
}

export async function features(db: Db, userId: string) {
  const r = await db.query("SELECT * FROM features WHERE user_id=$1", [userId]);
  return r.rows.map((f) => ({ game: f.game, token: f.token, ...featureView(f) }));
}
