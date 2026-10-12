import { ethers } from "ethers";
import type { Config } from "./config.js";

export const VAULT_ABI = [
  "event Deposited(address indexed user, address indexed token, uint256 amount, uint256 indexed depositId)",
  "event BankrollFunded(address indexed from, address indexed token, uint256 amount)",
  "event Withdrawn(address indexed user, address indexed token, uint256 amount, uint256 indexed nonce, address relayer)",
  "event HouseWithdrawal(address indexed token, address indexed to, uint256 amount)",
  "function tokenConfig(address) view returns (bool listed, bool depositsEnabled, uint128 minDeposit, uint128 maxWithdrawal, uint128 dailyCap, uint128 cosignAbove)",
  "function nonceUsed(address, uint256) view returns (bool)",
  "function balanceOf(address token) view returns (uint256)",
  "function withdrawalsPaused() view returns (bool)",
  "function pauseWithdrawals()",
  "function minIssuedAt() view returns (uint256)",
  "function domainSeparator() view returns (bytes32)",
];

export interface Chain {
  provider: ethers.JsonRpcProvider;
  vault: ethers.Contract;
  iface: ethers.Interface;
  domain: ethers.TypedDataDomain;
}

export function connect(cfg: Config): Chain {
  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, { staticNetwork: true });
  const vault = new ethers.Contract(cfg.VAULT_ADDRESS, VAULT_ABI, provider);
  return { provider, vault, iface: vault.interface, domain: { name: "MSFT95Vault", version: "1", chainId: cfg.CHAIN_ID, verifyingContract: cfg.VAULT_ADDRESS } };
}

export const WITHDRAWAL_TYPES = { Withdrawal: [
  { name: "user", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "issuedAt", type: "uint256" }, { name: "deadline", type: "uint256" } ] };

/** vault v2 voucher: valid while block.timestamp < deadline, and deadline - issuedAt <= 24h */
export interface Voucher { user: string; token: string; amount: bigint; nonce: bigint; issuedAt: bigint; deadline: bigint }

/** Something that can sign a withdrawal voucher. Production: a KMS/HSM-backed implementation of this interface. */
export interface VoucherSigner { address(): Promise<string>; sign(domain: ethers.TypedDataDomain, v: Voucher): Promise<string> }

export class LocalKeySigner implements VoucherSigner {
  private w: ethers.Wallet;
  constructor(key: string) { this.w = new ethers.Wallet(key); }
  async address() { return this.w.address; }
  async sign(domain: ethers.TypedDataDomain, v: Voucher) { return this.w.signTypedData(domain, WITHDRAWAL_TYPES, v); }
}

export interface VaultTokenLimits { listed: boolean; maxWithdrawal: bigint; cosignAbove: bigint; dailyCap: bigint }
export async function vaultLimits(ch: Chain, token: string): Promise<VaultTokenLimits> {
  const r = await ch.vault.getFunction("tokenConfig")(token);
  return { listed: r[0], maxWithdrawal: r[3], dailyCap: r[4], cosignAbove: r[5] };
}
