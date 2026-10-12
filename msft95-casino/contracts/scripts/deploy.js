/*
  Deploy the MSFT95 games vault.

    Testnet (Robinhood Chain testnet, chain 46630) — also deploys free test tokens:
      DEPLOYER_KEY=0x... SIGNER=0x... COSIGNER=0x... GUARDIAN=0x... BANKROLL=0x... ALLOW=0xYourWallet,0xOther \
      npx hardhat run scripts/deploy.js --network rhTestnet

    Mainnet (chain 4663) — uses the real token addresses below; starts allowlist-only with small caps:
      DEPLOYER_KEY=0x... ADMIN=0xYourSafe SIGNER=... COSIGNER=... GUARDIAN=... ALLOW=... MSFT95=0x(token, when live) \
      npx hardhat run scripts/deploy.js --network rhMainnet

  ADMIN is the vault admin from the first block (required on mainnet: your Safe, ideally behind a timelock).
  On testnet it defaults to the deployer. Every role, token and allowlist entry is set in the constructor,
  so there is no window where the hot deployer key is admin.
  ADMIN_DELAY is the waiting period for any later admin handover (default 2 days mainnet, 0 testnet).
  BANKROLL (optional) is a treasury wallet allowed to add house bankroll (the admin always can).
*/
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ETH = ethers.ZeroAddress;
const MAINNET_TOKENS = {
  USDC: { address: "0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8", decimals: 6 },
  NET: { address: "0xca9c78dd337a67f6e0077f65f5e9218719d30edf", decimals: 18 },
  IMD: { address: "0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127", decimals: 18 },
};
// limits in whole tokens: [minDeposit, maxWithdrawal, dailyCap, cosignAbove]
const LIMITS = {
  mainnet: { ETH: ["0.001", "0.4", "2", "0.1"], USDC: ["1", "1000", "5000", "250"], NET: ["0.01", "6", "30", "1.5"],
             IMD: ["0.1", "100", "500", "25"], MSFT95: ["20", "20000", "100000", "5000"] },
  testnet: { ETH: ["0.0001", "5", "50", "1"], USDC: ["1", "100000", "1000000", "10000"], NET: ["0.01", "1000", "10000", "100"],
             IMD: ["0.1", "10000", "100000", "1000"], MSFT95: ["1", "1000000", "10000000", "100000"] },
};

function cfg(lim, decimals) {
  const u = (x) => ethers.parseUnits(x, decimals);
  return { listed: true, depositsEnabled: true, minDeposit: u(lim[0]), maxWithdrawal: u(lim[1]), dailyCap: u(lim[2]), cosignAbove: u(lim[3]) };
}
const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

async function main() {
  const [deployer] = await ethers.getSigners();
  const isMain = network.config.chainId === 4663;
  const env = process.env;
  const admin = env.ADMIN || deployer.address;
  const delay = Number(env.ADMIN_DELAY || (isMain ? 2 * 24 * 3600 : 0));
  const allow = list(env.ALLOW);
  for (const k of ["ADMIN", "SIGNER", "COSIGNER", "GUARDIAN"]) if (!env[k] && isMain) throw new Error(k + " is required on mainnet");
  const keys = ["SIGNER", "COSIGNER", "GUARDIAN"].map((k) => (env[k] || "").toLowerCase()).filter(Boolean);
  if (new Set(keys).size !== keys.length) throw new Error("SIGNER, COSIGNER and GUARDIAN must be three different addresses");
  if (isMain && admin.toLowerCase() === deployer.address.toLowerCase()) throw new Error("On mainnet ADMIN must be your Safe, not the deployer key");
  console.log(`Network ${network.name} (${network.config.chainId}) · deployer ${deployer.address} · admin ${admin}`);

  const tokens = {};
  const limits = isMain ? LIMITS.mainnet : LIMITS.testnet;
  if (isMain) {
    Object.assign(tokens, MAINNET_TOKENS);
    if (env.MSFT95) tokens.MSFT95 = { address: env.MSFT95, decimals: 18 };
  } else {
    const Tok = await ethers.getContractFactory("TestToken");
    for (const [sym, dec] of [["MSFT95", 18], ["USDC", 6], ["NET", 18], ["IMD", 18]]) {
      const t = await Tok.deploy(`Test ${sym}`, `t${sym}`, dec); await t.waitForDeployment();
      tokens[sym] = { address: await t.getAddress(), decimals: dec };
      console.log(`  test token t${sym}`, tokens[sym].address);
      for (const who of [deployer.address, ...allow]) await (await t.mint(who, ethers.parseUnits("1000000", dec))).wait();
    }
  }

  // Everything is set in the constructor: the admin (your Safe on mainnet) is admin from block one and the
  // deployer key never holds any role.
  const setup = {
    admin, adminDelay: delay,
    signer: env.SIGNER || ethers.ZeroAddress, cosigner: env.COSIGNER || ethers.ZeroAddress,
    guardian: env.GUARDIAN || ethers.ZeroAddress, bankroller: env.BANKROLL || ethers.ZeroAddress,
    allowlistOnly: true, allowed: allow,
    tokens: [{ token: ETH, config: cfg(limits.ETH, 18) }, ...Object.entries(tokens).map(([sym, t]) => ({ token: t.address, config: cfg(limits[sym], t.decimals) }))],
  };
  const Vault = await ethers.getContractFactory("MSFT95Vault");
  const vault = await Vault.deploy(setup);
  const receipt = await (await vault.deploymentTransaction()).wait();
  const va = await vault.getAddress();
  console.log("MSFT95Vault", va, "at block", receipt.blockNumber);

  const out = { network: network.name, chainId: network.config.chainId, vault: va, deployBlock: receipt.blockNumber, admin, adminDelay: delay,
    signer: env.SIGNER || null, cosigner: env.COSIGNER || null, guardian: env.GUARDIAN || null, bankroller: env.BANKROLL || null, allowlist: allow,
    tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, v.address])), deployedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
