/*
  How the backend signs a withdrawal voucher (EIP-712). In production the key lives in a KMS/HSM,
  never in an env var; this script is for testnet testing only.

    SIGNER_KEY=0x... VAULT=0x... USER=0x... TOKEN=0x...(0x000…0 for ETH) AMOUNT=1.5 DECIMALS=18 NONCE=1 \
    npx hardhat run scripts/sign-withdrawal.js --network rhTestnet

  The voucher is valid for TTL seconds (default 3600, at most 86400) and for the vault's current voucherEpoch.
*/
const { ethers, network } = require("hardhat");
const { signVoucher } = require("./voucher");

async function main() {
  const e = process.env;
  const wallet = new ethers.Wallet(e.SIGNER_KEY);
  const vault = await ethers.getContractAt("MSFT95Vault", e.VAULT);
  const ttl = Number(e.TTL || 3600);
  if (!(ttl > 0 && ttl <= 86400)) throw new Error("TTL must be 1..86400 seconds");
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const w = { user: e.USER, token: e.TOKEN, amount: ethers.parseUnits(e.AMOUNT, Number(e.DECIMALS || 18)),
    nonce: BigInt(e.NONCE), epoch: await vault.voucherEpoch(), issuedAt, deadline: issuedAt + BigInt(ttl) };
  const sig = await signVoucher(wallet, e.VAULT, network.config.chainId, w);
  const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  console.log(JSON.stringify({ voucher: str(w), signatures: [sig] }, null, 2));
}

if (require.main === module) main().catch((x) => { console.error(x); process.exit(1); });
