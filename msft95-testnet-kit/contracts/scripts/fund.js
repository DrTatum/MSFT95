/* Testnet: put house bankroll into the vault (half the test tokens the deploy minted to the deployer, plus a
   little ETH), and give the guardian key a little ETH for gas.
     BANK_ETH=0.02 GUARDIAN_GAS=0.003 npx hardhat run scripts/fund.js --network rhTestnet */
const fs = require("fs"), path = require("path");
const { ethers, network } = require("hardhat");
async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", network.name + ".json")));
  const [me] = await ethers.getSigners();
  const vault = await ethers.getContractAt("MSFT95Vault", dep.vault);
  const erc = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)"];
  for (const [sym, addr] of Object.entries(dep.tokens)) {
    const t = new ethers.Contract(addr, erc, me), bal = await t.balanceOf(me.address), amt = bal / 2n;
    if (amt === 0n) { console.log(sym, ": deployer has none to fund with"); continue; }
    await (await t.approve(dep.vault, amt)).wait();
    await (await vault.fundBankroll(addr, amt)).wait();
    console.log("bankroll +", ethers.formatUnits(amt, await t.decimals()), "t" + sym);
  }
  const eth = ethers.parseEther(process.env.BANK_ETH || "0.02");
  if (eth > 0n) { await (await vault.fundBankroll(ethers.ZeroAddress, eth, { value: eth })).wait(); console.log("bankroll +", ethers.formatEther(eth), "ETH"); }
  const gas = ethers.parseEther(process.env.GUARDIAN_GAS || "0.003");
  if (dep.guardian && gas > 0n) { await (await me.sendTransaction({ to: dep.guardian, value: gas })).wait(); console.log("guardian gas +", ethers.formatEther(gas), "ETH"); }
}
main().catch((e) => { console.error(e); process.exit(1); });
