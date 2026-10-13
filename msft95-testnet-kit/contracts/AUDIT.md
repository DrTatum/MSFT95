# Audit brief: MSFT95Vault (v3)

v3 includes the fixes from both audits of 2026-10-12. See `AUDIT-RESPONSE.md`.

**Scope:** `contracts/MSFT95Vault.sol`. The mocks in `contracts/mocks/` are test-only.

**Compiler and libraries:** Solidity 0.8.24, optimizer 500 runs, EVM target shanghai, OpenZeppelin Contracts 5.1.0.

**Chain:** Robinhood Chain, an Arbitrum Orbit chain with a single sequencer. Testnet is 46630 and mainnet is 4663.

## Trust model

- **Admin** is fully trusted. It is a Safe, plus a timelock on mainnet. It can:
  - list and unlist tokens;
  - change limits;
  - grant SIGNER, COSIGNER, GUARDIAN and BANKROLL;
  - sweep funds, subject to `dailyCap` and blocked while withdrawals are paused.
  - The admin is set in the constructor together with every role and token, so no hot deployer key is ever admin.
- **SIGNER** is trusted to sign only withdrawals the off-chain ledger allows. A compromised SIGNER can take, per token per 24h window, up to `dailyCap`, in pieces no larger than `cosignAbove`. Anything above `cosignAbove` also needs COSIGNER.
- **GUARDIAN** can only pause and void all outstanding vouchers (bump the epoch). It can't unpause or move funds. A stolen guardian key can delay withdrawals until the admin revokes it.
- **BANKROLL** can only add house funds.
- **Players** are untrusted.

## Invariants to check

1. A voucher pays at most once: `nonceUsed[user][nonce]` is set before the external transfer, and a reverted payout leaves it unset.
2. Funds from `withdraw` only ever go to `w.user`, whoever calls it.
3. A voucher is only valid on this chain and this vault, while `block.timestamp < deadline`, with `issuedAt < deadline <= issuedAt + 24h`, `issuedAt <= block.timestamp + 5 minutes`, and `epoch == voucherEpoch`. `issuedAt` is chosen by the signer, so what is enforced is "at most 24h after the issuedAt it claims". A voucher pre-signed with a future `issuedAt` stays valid until the epoch changes; `voidAllVouchers()` and any revocation of a SIGNER or COSIGNER key bump the epoch and kill every outstanding voucher, whatever its `issuedAt`. The epoch only ever increases.
4. `amount > cosignAbove` requires two distinct keys, one with SIGNER and one with COSIGNER. SIGNER, COSIGNER and GUARDIAN are always three different keys (`_grantRole` override). The same signature or key can't be counted twice. `cosignAbove` is either below `maxWithdrawal` or the explicit `NO_COSIGN` opt-out.
5. Per token, within one window, player withdrawals plus `sweep` never exceed `dailyCap`. At most 2× `dailyCap` can leave inside any 24 hours, across a window boundary.
6. `Deposited.amount` equals the real balance increase. This holds for fee-on-transfer tokens; rebasing tokens are not supported.
7. Only an admin can unpause, change config, sweep, edit the allowlist or grant roles. A GUARDIAN can only pause and void vouchers. Only the admin or BANKROLL can call `fundBankroll`; players can only enter funds through `deposit` / `depositETH`, which honour the pause, the token's `depositsEnabled` and the allowlist. `fundBankroll` with ETH requires `amount == msg.value`.
7a. While withdrawals are paused, nothing leaves the vault: not player withdrawals, not house sweeps.
7b. The admin-handover delay is at most 30 days, at deploy and on every later change. Unlisting a token clears its whole config.
8. Plain ETH sent to the vault reverts. Through the contract's own functions, ETH only enters via `depositETH` or `fundBankroll`. ETH forced in with SELFDESTRUCT, or ERC-20s transferred directly, arrive with no event: that is surplus, never a liability.
9. Through the contract's own functions, the balance equals deposits plus bankroll minus withdrawals minus sweeps (randomized tests cover tokens and ETH). Off-chain reconciliation therefore checks `vault balance >= liabilities`, never equality, so a 1-wei donation can't trigger a pause.

## Areas worth extra attention

- `_verify`: signature-ordering edge cases, role revocation between signing and submission, and `ECDSA.recover` with malformed signatures.
- `_spend`: window rollover at exactly `start + WINDOW`, and `uint192` / `uint64` casts.
- Reentrancy through ERC-777-style hooks or ETH receivers. Every external entry point is `nonReentrant`, and `deposit` reads the balance before and after the transfer.
- `AccessControlDefaultAdminRules` interaction with the `_grantRole` override, so admin handover still works.
- Tokens with blocklists (USDC): a blocklisted user's withdrawal reverts. Confirm it fails cleanly and the nonce stays unused.

## Off-chain assumptions (for the step-2 backend review)

- **Deposit indexing.** The indexer credits each `Deposited` event exactly once, keyed by `(chainId, txHash, logIndex)` or `depositId`, after enough confirmations. Reorgs are handled.
- **Ledger before signing.** The ledger debits the player before signing a voucher. If the voucher expires unused, it re-credits only once a confirmed block has `timestamp >= deadline` (the backend waits for `>`, which is stricter) and `nonceUsed` is false at that block.
- **Key rotation.** Revoking a SIGNER or COSIGNER key voids every outstanding voucher automatically; the backend refunds the affected players as soon as a confirmed block shows the new epoch, then re-issues with the new epoch. Use `voidAllVouchers()` if vouchers may have been forged without a key change (e.g. an abused signing API).
- **Voucher epoch.** The backend reads `voucherEpoch` when signing. Vouchers whose epoch is below the epoch at a confirmed block, with the nonce unused, are provably unpayable and are refunded immediately.
- **Unique nonces.** Nonces are unique per user and never reused across voucher re-issues.
- **Key custody.** SIGNER and COSIGNER keys live in separate KMS/HSM accounts. The GUARDIAN bot pauses withdrawals when reconciliation fails, that is, when the sum of ledger liabilities is greater than the vault balance.
