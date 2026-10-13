/* Testnet: let more wallets deposit (the vault starts allowlist-only).
     ADDRS=0xabc...,0xdef... npx hardhat run scripts/allow.js --network rhTestnet
   OPEN=1 instead turns the allowlist off so any wallet can play. */
const fs = require("fs"), path = require("path");
const { ethers, network } = require("hardhat");
async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", network.name + ".json")));
  const vault = await ethers.getContractAt("MSFT95Vault", dep.vault);
  if (process.env.OPEN === "1") { await (await vault.setAllowlistOnly(false)).wait(); console.log("allowlist off: any wallet can deposit"); return; }
  const list = (process.env.ADDRS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!list.length) throw new Error("set ADDRS=0x...,0x...");
  for (const a of list) if (!ethers.isAddress(a)) throw new Error("not an address: " + a);
  await (await vault.setAllowed(list, true)).wait();
  console.log("allowed:", list.join(", "));
}
main().catch((e) => { console.error(e); process.exit(1); });
