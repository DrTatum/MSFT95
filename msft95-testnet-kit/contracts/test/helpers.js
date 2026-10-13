const { ethers } = require("hardhat");

const ETH = ethers.ZeroAddress;
const DAY = 24 * 60 * 60;
const NO_COSIGN = (1n << 128n) - 1n;

const { TYPES } = require("../scripts/voucher");

async function signWithdrawal(vault, signer, w, chainId) {
  const net = await ethers.provider.getNetwork();
  const domain = { name: "MSFT95Vault", version: "1", chainId: chainId ?? net.chainId, verifyingContract: await vault.getAddress() };
  return signer.signTypedData(domain, TYPES, w);
}

async function now() { return (await ethers.provider.getBlock("latest")).timestamp; }

function cfg(o = {}) {
  return Object.assign({ listed: true, depositsEnabled: true, minDeposit: 1n, maxWithdrawal: ethers.parseEther("1000"),
    dailyCap: ethers.parseEther("5000"), cosignAbove: ethers.parseEther("100") }, o);
}

function setup(o = {}) {
  return Object.assign({ admin: ethers.ZeroAddress, adminDelay: 0, signer: ethers.ZeroAddress, cosigner: ethers.ZeroAddress,
    guardian: ethers.ZeroAddress, bankroller: ethers.ZeroAddress, allowlistOnly: false, allowed: [], tokens: [] }, o);
}

async function deploy() {
  const [admin, signer, cosigner, guardian, alice, bob, relayer, outsider, treasury] = await ethers.getSigners();
  const Tok = await ethers.getContractFactory("TestToken");
  const tok = await Tok.deploy("Test MSFT95", "tMSFT95", 18);
  const usdc = await Tok.deploy("Test USDC", "tUSDC", 6);
  const Vault = await ethers.getContractFactory("MSFT95Vault");
  const vault = await Vault.deploy(setup({
    admin: admin.address, adminDelay: 2 * DAY, signer: signer.address, cosigner: cosigner.address, guardian: guardian.address, bankroller: treasury.address,
    tokens: [
      { token: await tok.getAddress(), config: cfg() },
      { token: ETH, config: cfg() },
      { token: await usdc.getAddress(), config: cfg({ minDeposit: 1_000_000n, maxWithdrawal: 10_000_000_000n, dailyCap: 50_000_000_000n, cosignAbove: 1_000_000_000n }) },
    ] }));
  for (const u of [alice, bob, outsider, treasury, admin]) {
    await tok.mint(u.address, ethers.parseEther("100000"));
    await usdc.mint(u.address, 100_000_000_000n);
    await tok.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
  }
  return { vault, tok, usdc, admin, signer, cosigner, guardian, alice, bob, relayer, outsider, treasury, Vault };
}

module.exports = { ETH, DAY, NO_COSIGN, TYPES, signWithdrawal, now, cfg, setup, deploy };
