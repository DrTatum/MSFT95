const { ethers } = require("hardhat");

const ETH = ethers.ZeroAddress;
const DAY = 24 * 60 * 60;

async function signWithdrawal(vault, signer, w) {
  const net = await ethers.provider.getNetwork();
  const domain = { name: "MSFT95Vault", version: "1", chainId: net.chainId, verifyingContract: await vault.getAddress() };
  const types = { Withdrawal: [
    { name: "user", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ] };
  return signer.signTypedData(domain, types, w);
}

async function now() { return (await ethers.provider.getBlock("latest")).timestamp; }

function cfg(o = {}) {
  return Object.assign({ listed: true, depositsEnabled: true, minDeposit: 1n, maxWithdrawal: ethers.parseEther("1000"),
    dailyCap: ethers.parseEther("5000"), cosignAbove: ethers.parseEther("100") }, o);
}

async function deploy() {
  const [admin, signer, cosigner, guardian, alice, bob, relayer, outsider] = await ethers.getSigners();
  const Vault = await ethers.getContractFactory("MSFT95Vault");
  const vault = await Vault.deploy(admin.address, 2 * DAY);
  const Tok = await ethers.getContractFactory("TestToken");
  const tok = await Tok.deploy("Test MSFT95", "tMSFT95", 18);
  const usdc = await Tok.deploy("Test USDC", "tUSDC", 6);
  await vault.grantRole(await vault.SIGNER_ROLE(), signer.address);
  await vault.grantRole(await vault.COSIGNER_ROLE(), cosigner.address);
  await vault.grantRole(await vault.GUARDIAN_ROLE(), guardian.address);
  await vault.setToken(await tok.getAddress(), cfg());
  await vault.setToken(ETH, cfg());
  await vault.setToken(await usdc.getAddress(), cfg({ minDeposit: 1_000_000n, maxWithdrawal: 10_000_000_000n, dailyCap: 50_000_000_000n, cosignAbove: 1_000_000_000n }));
  for (const u of [alice, bob, outsider]) {
    await tok.mint(u.address, ethers.parseEther("100000"));
    await usdc.mint(u.address, 100_000_000_000n);
    await tok.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
  }
  return { vault, tok, usdc, admin, signer, cosigner, guardian, alice, bob, relayer, outsider };
}

module.exports = { ETH, DAY, signWithdrawal, now, cfg, deploy };
