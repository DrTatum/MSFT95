# Responses to the audits of 2026-10-12

## Audit 1 (job d4fc488d) → v2

The audited commit was `984db98`, with 2 low and 7 info findings. Every finding is addressed in v2 of `contracts/MSFT95Vault.sol`. Each fix has a regression test in `test/vault.test.js` under "audit fixes and regression tests". Tests went from 29 to 43, line coverage is 100% and branch coverage went from 90% to 93%.

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | Low | `fundBankroll` was permissionless and skipped the deposit pause, `depositsEnabled` and the allowlist | `fundBankroll` is restricted to the admin or the new `BANKROLL_ROLE` (treasury). Players can only enter funds through `deposit` / `depositETH`, which keep every gate. | F1 (the auditor's Foundry proof, ported) |
| 2 | Low | Voucher lifetime was bounded from submission time, not signing time (sleeper vouchers) | Added `issuedAt` to the signed `Withdrawal`. A voucher needs `issuedAt < deadline <= issuedAt + 24h`, and `issuedAt <= block.timestamp + 5 min` (clock-skew allowance). Added `voidVouchersIssuedBefore(t)` (guardian or admin, forward-only, never in the future) as an emergency kill switch, so re-granting a key can't revive old vouchers. | F2 (sleeper, future-dated, void, re-grant) |
| 3 | Info | `fundBankroll` ignored `amount` for ETH | Reverts `AmountMismatch` unless `amount == msg.value` | F3 |
| 4 | Info | The deadline second was still valid | The check is now `block.timestamp >= deadline` → expired. The backend refunds only when a confirmed block is strictly past the deadline. | F4 |
| 5 | Info | `sweep` ignored the withdrawal pause | `sweep` reverts `WithdrawalsClosed` while paused | F5 |
| 6 | Info | `cosignAbove == maxWithdrawal` made the cosigner unreachable | `setToken` requires `cosignAbove < maxWithdrawal`, or the explicit sentinel `NO_COSIGN` (2^128 − 1) to opt out on purpose | "rejects inconsistent token limits", F9 |
| 7 | Info | Invariants 8 and 9 aren't strict (SELFDESTRUCT, direct transfers) | Invariants reworded in `AUDIT.md`. The backend reconciler already checks `balance >= liabilities` and treats surplus as harmless. | F7 (forced ETH) |
| 8 | Info | Brief's edge cases not covered by the suite | Added the window rollover at exactly `start + 24h`; empty, 64-byte, zeroed and high-s signatures (nonce stays unused); two SIGNER keys; signer + outsider; cosigner only; `amount == cosignAbove`; cosigner revoke and re-grant; ERC-777-style hook re-entering `deposit`; USDC-style blocklisted recipient (nonce and window untouched); ETH randomized invariant | F8a–F8f, "holds for ETH too" |
| 9 | Info | Deploy left the deployer EOA as admin until the Safe accepted, and only checked SIGNER ≠ COSIGNER | The constructor takes a `Setup` struct: admin, delay, every role, every token config and the allowlist. The Safe is admin from block one and the deployer never holds a role. SIGNER, COSIGNER and GUARDIAN must be three different keys, enforced on-chain (`_grantRole`) and in `deploy.js`. On mainnet, `deploy.js` refuses an ADMIN equal to the deployer. | F9, "refuses to give one key two roles" |

## Interface changes the backend picked up

- The EIP-712 type is now `Withdrawal(address user,address token,uint256 amount,uint256 nonce,uint256 issuedAt,uint256 deadline)`.
- The constructor is now `constructor(Setup)`.
- New: `BANKROLL_ROLE`, `NO_COSIGN`, `MAX_CLOCK_SKEW`, `minIssuedAt`, `voidVouchersIssuedBefore`, and the `VouchersVoided` event.
- New errors: `Unauthorized`, `AmountMismatch`, `VoucherNotYetValid`, `VoucherVoided`.

## Audit 2 (job 91ed3906, commit `427291e`) → v3

One medium, three low and one info finding. All are addressed, and each has a regression test (the "A2-…" tests, plus the reworked F2 tests). There are now 49 tests, with 100% line coverage and 94% branch coverage.

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | Medium | `issuedAt` is chosen by the signer, so future-dated "sleeper" vouchers outlived 24h, survived `voidVouchersIssuedBefore`, and were revived when a key was re-granted. The void also had a 5-minute blind spot. | Added `uint256 public voucherEpoch`. It is part of the signed `Withdrawal` and must equal the current epoch. `voidAllVouchers()` (guardian or admin) replaces `voidVouchersIssuedBefore` and bumps the epoch, killing every outstanding voucher whatever its `issuedAt`. Revoking or renouncing a SIGNER or COSIGNER key bumps the epoch automatically, so a re-grant can never revive old vouchers. Invariant 3 is reworded to say what is enforced. | A2-1 (all three of the auditor's Foundry scenarios, ported), F2 |
| 2 | Low | `adminDelay` was unbounded, so a unit mistake could lock admin rotation for years or forever. | Capped at `MAX_ADMIN_DELAY` (30 days) in the constructor and on every later `changeDefaultAdminDelay`. `deploy.js` checks it too and explains that the value is in seconds. | A2-2 |
| 3 | Low | An all-zero config couldn't unlist a token, and unlisting could leave a stale `NO_COSIGN` behind. | `listed: false` (for example, all zeros) now deletes the token's whole config. It still can't have `depositsEnabled`. The consistency checks apply to listed tokens only. | A2-3 |
| 4 | Low | `scripts/sign-withdrawal.js` signed the old voucher type. | The voucher type lives in one shared module, `scripts/voucher.js`, which the tests and the script both use (the backend mirrors it). The script reads the vault's epoch and caps the TTL at 24h. | A2-4 |
| 5 | Info | A stolen guardian key could void honest vouchers, and players waited until each deadline for their refund. | Documented as a trust assumption. The backend now refunds a voided voucher as soon as a confirmed block shows a higher epoch with the nonce unused (it is provably unpayable), without waiting for the deadline. | backend `chain.test.ts` |

### Interface changes in v3

- The EIP-712 type is now `Withdrawal(address user,address token,uint256 amount,uint256 nonce,uint256 epoch,uint256 issuedAt,uint256 deadline)`.
- New: `voucherEpoch`, `voidAllVouchers()`, `MAX_ADMIN_DELAY`.
- `VouchersVoided(uint256 newEpoch, address by)` changed shape.
- Removed: `minIssuedAt` and `voidVouchersIssuedBefore`.
