/*
  How the backend signs a withdrawal voucher (EIP-712). In production the key lives in a KMS/HSM,
  never in an env var; this script is for testnet testing only.

    SIGNER_KEY=0x... VAULT=0x... USER=0x... TOKEN=0x...(0x000…0 for ETH) AMOUNT=1.5 DECIMALS=18 NONCE=1 \
    npx hardhat run scripts/sign-withdrawal.js --network rhTestnet
*/
const { ethers, network } = require("hardhat");

const TYPES = { Withdrawal: [
  { name: "user", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ] };

async function signVoucher(wallet, vault, chainId, w) {
  return wallet.signTypedData({ name: "MSFT95Vault", version: "1", chainId, verifyingContract: vault }, TYPES, w);
}

async function main() {
  const e = process.env;
  const wallet = new ethers.Wallet(e.SIGNER_KEY);
  const w = { user: e.USER, token: e.TOKEN, amount: ethers.parseUnits(e.AMOUNT, Number(e.DECIMALS || 18)),
    nonce: BigInt(e.NONCE), deadline: BigInt(Math.floor(Date.now() / 1000) + Number(e.TTL || 3600)) };
  const sig = await signVoucher(wallet, e.VAULT, network.config.chainId, w);
  console.log(JSON.stringify({ voucher: { ...w, amount: w.amount.toString(), nonce: w.nonce.toString(), deadline: w.deadline.toString() }, signatures: [sig] }, null, 2));
}

module.exports = { signVoucher, TYPES };
if (require.main === module) main().catch((x) => { console.error(x); process.exit(1); });
