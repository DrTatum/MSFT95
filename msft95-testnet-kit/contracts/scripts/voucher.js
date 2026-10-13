// The one definition of the vault's EIP-712 withdrawal voucher. Tests, scripts and the backend must all match it.
const TYPES = { Withdrawal: [
  { name: "user", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "epoch", type: "uint256" }, { name: "issuedAt", type: "uint256" },
  { name: "deadline", type: "uint256" } ] };

const domain = (vault, chainId) => ({ name: "MSFT95Vault", version: "1", chainId, verifyingContract: vault });

/** wallet: an ethers signer; v: { user, token, amount, nonce, epoch, issuedAt, deadline } */
function signVoucher(wallet, vault, chainId, v) {
  return wallet.signTypedData(domain(vault, chainId), TYPES, v);
}

module.exports = { TYPES, domain, signVoucher };
