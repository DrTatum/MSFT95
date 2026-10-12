/*
  Deploy the MSFT95 games vault.

    Testnet (Robinhood Chain testnet, chain 46630) — also deploys free test tokens:
      DEPLOYER_KEY=0x... SIGNER=0x... COSIGNER=0x... GUARDIAN=0x... ALLOW=0xYourWallet,0xOther \
      npx hardhat run scripts/deploy.js --network rhTestnet

    Mainnet (chain 4663) — uses the real token addresses below; starts allowlist-only with small caps:
      DEPLOYER_KEY=0x... ADMIN=0xYourSafe SIGNER=... COSIGNER=... GUARDIAN=... ALLOW=... MSFT95=0x(token, when live) \
      npx hardhat run scripts/deploy.js --network rhMainnet

  ADMIN defaults to the deployer (fine for testnet; on mainnet hand admin to a Safe, ideally behind a timelock).
  ADMIN_DELAY is the waiting period for handing over admin (default 2 days mainnet, 0 testnet).
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
  for (const k of ["SIGNER", "COSIGNER", "GUARDIAN"]) if (!env[k] && isMain) throw new Error(k + " is required on mainnet");
  if (env.SIGNER && env.SIGNER === env.COSIGNER) throw new Error("SIGNER and COSIGNER must be different keys");
  console.log(`Network ${network.name} (${network.config.chainId}) · deployer ${deployer.address} · admin ${admin}`);

  const Vault = await ethers.getContractFactory("MSFT95Vault");
  // deploy with the deployer as admin so we can configure, then hand over if ADMIN differs
  const vault = await Vault.deploy(deployer.address, delay);
  await vault.waitForDeployment();
  const va = await vault.getAddress();
  console.log("MSFT95Vault", va);

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

  await (await vault.setToken(ETH, cfg(limits.ETH, 18))).wait();
  for (const [sym, t] of Object.entries(tokens)) await (await vault.setToken(t.address, cfg(limits[sym], t.decimals))).wait();

  if (env.SIGNER) await (await vault.grantRole(await vault.SIGNER_ROLE(), env.SIGNER)).wait();
  if (env.COSIGNER) await (await vault.grantRole(await vault.COSIGNER_ROLE(), env.COSIGNER)).wait();
  if (env.GUARDIAN) await (await vault.grantRole(await vault.GUARDIAN_ROLE(), env.GUARDIAN)).wait();

  await (await vault.setAllowlistOnly(true)).wait();
  if (allow.length) await (await vault.setAllowed(allow, true)).wait();

  if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await vault.beginDefaultAdminTransfer(admin)).wait();
    console.log(`Admin handover to ${admin} started: it must call acceptDefaultAdminTransfer() after ${delay}s.`);
  }

  const out = { network: network.name, chainId: network.config.chainId, vault: va, admin, deployer: deployer.address,
    signer: env.SIGNER || null, cosigner: env.COSIGNER || null, guardian: env.GUARDIAN || null, allowlist: allow,
    tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, v.address])), deployedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
