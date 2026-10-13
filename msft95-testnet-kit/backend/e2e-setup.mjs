// local end-to-end setup: deploys the vault and test tokens to a hardhat node and writes the backend's env + token file
import { ethers } from "ethers"; import fs from "node:fs";
const OUT = process.argv[2], RPC = "http://127.0.0.1:8547", E = 10n ** 18n, ETH = ethers.ZeroAddress;
const p = new ethers.JsonRpcProvider(RPC); const admin = await p.getSigner(0);
const art = (n, sub) => JSON.parse(fs.readFileSync(`../contracts/artifacts/contracts/${sub ? sub + "/" : ""}${sub ? "Mocks" : n}.sol/${n}.json`, "utf8"));
const signer = ethers.Wallet.createRandom(), cosigner = ethers.Wallet.createRandom(), guardian = ethers.Wallet.createRandom();
const player = new ethers.Wallet("0x" + "a1".repeat(32));
const T = art("TestToken", "mocks"), V = art("MSFT95Vault");
const dep = async (name, sym, dec) => { const c = await (await new ethers.ContractFactory(T.abi, T.bytecode, admin).deploy(name, sym, dec)).waitForDeployment(); return c; };
const usdc = await dep("Test USDC", "USDC", 6), msft = await dep("Test MSFT95", "MSFT95", 18);
const ua = (await usdc.getAddress()).toLowerCase(), ma = (await msft.getAddress()).toLowerCase();
const lim = (maxW, cos) => ({ listed: true, depositsEnabled: true, minDeposit: 1n, maxWithdrawal: maxW, dailyCap: maxW * 10n, cosignAbove: cos });
const vault = await (await new ethers.ContractFactory(V.abi, V.bytecode, admin).deploy({
  admin: await admin.getAddress(), adminDelay: 0, signer: signer.address, cosigner: cosigner.address, guardian: guardian.address,
  bankroller: ethers.ZeroAddress, allowlistOnly: false, allowed: [],
  tokens: [{ token: ua, config: lim(5000n * 10n ** 6n, 500n * 10n ** 6n) }, { token: ma, config: lim(5000n * E, 500n * E) }, { token: ETH, config: lim(5n * E, 1n * E) }] })).waitForDeployment();
const va = (await vault.getAddress()).toLowerCase();
for (const [t, amt] of [[usdc, 1_000_000n * 10n ** 6n], [msft, 1_000_000n * E]]) { await (await t.mint(await admin.getAddress(), amt)).wait(); await (await t.approve(va, ethers.MaxUint256)).wait(); await (await vault.fundBankroll(await t.getAddress(), amt / 2n)).wait(); }
await (await vault.fundBankroll(ETH, 20n * E, { value: 20n * E })).wait();
await (await usdc.mint(player.address, 1000n * 10n ** 6n)).wait(); await (await msft.mint(player.address, 1000n * E)).wait();
await p.send("hardhat_setBalance", [player.address, "0x56BC75E2D63100000"]);
const tokens = [
  { symbol: "USDC", address: ua, decimals: 6, minBet: "10000", maxBet: "100000000", maxPayout: "100000000000", minWithdrawal: "1000000", userDailyWithdrawal: "100000000000" },
  { symbol: "MSFT95", address: ma, decimals: 18, minBet: (E / 100n).toString(), maxBet: (100n * E).toString(), maxPayout: (100000n * E).toString(), minWithdrawal: E.toString(), userDailyWithdrawal: (100000n * E).toString() },
  { symbol: "ETH", address: ETH, decimals: 18, minBet: "1000000000000", maxBet: (E / 10n).toString(), maxPayout: (100n * E).toString(), minWithdrawal: "1000000000000000", userDailyWithdrawal: (10n * E).toString() }];
fs.writeFileSync(OUT + "/tokens.json", JSON.stringify(tokens, null, 1));
fs.writeFileSync(OUT + "/env.sh", [`export DATABASE_URL=postgres://casino:casino@localhost:5432/casino_e2e`, `export CHAIN_ID=31337`, `export RPC_URL=${RPC}`, `export VAULT_ADDRESS=${va}`,
  `export CONFIRMATIONS=2`, `export SIWE_DOMAIN=localhost:8090`, `export SIWE_ORIGIN=http://localhost:8090`, `export CORS_ORIGINS=http://localhost:8090`, `export NODE_ENV=development`, `export PORT=8788`,
  `export SEED_KEY=${ethers.hexlify(ethers.randomBytes(32)).slice(2)}`, `export SIGNER_KEY=${signer.privateKey.slice(2)}`, `export COSIGNER_KEY=${cosigner.privateKey.slice(2)}`,
  `export WITHDRAWAL_TTL_SEC=1800`, `export TOKENS_FILE=${OUT}/tokens.json`, `export RATE_LIMIT_MULTIPLIER=50`].join("\n") + "\n");
fs.writeFileSync(OUT + "/player.json", JSON.stringify({ key: player.privateKey, address: player.address.toLowerCase(), vault: va, usdc: ua, msft: ma }));
console.log("vault", va, "usdc", ua, "msft", ma, "player", player.address);
