// Builds config/tokens.<net>.json from the vault deploy output (../contracts/deployments/<net>.json).
//   node scripts/tokens-from-deployment.mjs rhTestnet
// Limits are starting points in whole tokens; edit the JSON afterwards.
import fs from "node:fs";
const net = process.argv[2] || "rhTestnet";
const dep = JSON.parse(fs.readFileSync(new URL(`../../contracts/deployments/${net}.json`, import.meta.url)));
const main = dep.chainId === 4663;
const units = (x, d) => { const [i, f = ""] = String(x).split("."); return (BigInt(i) * 10n ** BigInt(d) + BigInt((f + "0".repeat(d)).slice(0, d) || "0")).toString(); };
// [minBet, maxBet, maxPayout, minWithdrawal, userDailyWithdrawal]
const L = main
  ? { ETH: ["0.00003", "0.004", "20", "0.001", "2"], USDC: ["0.1", "10", "50000", "1", "5000"], NET: ["0.0006", "0.06", "300", "0.01", "30"], IMD: ["0.01", "1", "5000", "0.1", "500"], MSFT95: ["2", "200", "1000000", "20", "100000"] }
  : { ETH: ["0.00001", "0.01", "100", "0.0001", "50"], USDC: ["0.1", "100", "1000000", "1", "1000000"], NET: ["0.001", "1", "10000", "0.01", "10000"], IMD: ["0.01", "10", "100000", "0.1", "100000"], MSFT95: ["1", "1000", "10000000", "1", "10000000"] };
// A bet is only accepted if its biggest possible win (slots 5,000x, keno 10,000x) fits under maxPayout,
// so maxBet here is sized for slots; keno's effective max is half of it.
const dec = { ETH: 18, USDC: 6, NET: 18, IMD: 18, MSFT95: 18 };
const list = [["ETH", "0x0000000000000000000000000000000000000000"], ...Object.entries(dep.tokens)].map(([sym, address]) => {
  const l = L[sym]; if (!l) throw new Error("no limits for " + sym);
  return { symbol: sym, address, decimals: dec[sym], minBet: units(l[0], dec[sym]), maxBet: units(l[1], dec[sym]), maxPayout: units(l[2], dec[sym]),
    minWithdrawal: units(l[3], dec[sym]), userDailyWithdrawal: units(l[4], dec[sym]) };
});
const out = new URL(`../config/tokens.${main ? "mainnet" : "testnet"}.json`, import.meta.url);
fs.writeFileSync(out, JSON.stringify(list, null, 2) + "\n");
console.log("wrote", out.pathname);
