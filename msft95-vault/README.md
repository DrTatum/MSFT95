# MSFT95 Games Vault

Step 1 of the Stake-style casino: the on-chain custody contract on Robinhood Chain.

Players **deposit** tokens into the vault, **play off-chain** against a balance kept by the MSFT95 backend (step 2), and **withdraw** with a voucher the backend signs. The vault never knows player balances. It only:

- records deposits as events;
- pays out signed withdrawal vouchers;
- limits how fast money can leave if a key is stolen.

| | |
|---|---|
| Contract | `contracts/MSFT95Vault.sol` (Solidity 0.8.24, OpenZeppelin 5.1) |
| Tests | `test/vault.test.js`, 29 tests, 100% line coverage, 90% branch coverage |
| Deploy | `scripts/deploy.js` (testnet also deploys free test tokens) |
| Voucher signing example | `scripts/sign-withdrawal.js` |
| Audit brief for reviewers | `AUDIT.md` |

## How it works

**Deposit.**
- `deposit(token, amount)` takes ERC-20 tokens and `depositETH()` takes native ETH.
- The vault emits `Deposited(user, token, amountReceived, depositId)`.
- The amount is what actually arrived, so fee-on-transfer tokens are credited net of the fee.
- The backend credits the player after enough confirmations.

**Withdraw.**
- The backend signs an EIP-712 `Withdrawal{user, token, amount, nonce, deadline}`.
- Anyone can submit it, so a gas relayer works too, but funds always go to `user`.
- Every voucher:
  - can be used only once (per-user nonce);
  - expires within 24 hours at most;
  - only works on this chain and this vault.

**Limits per token.**
- `minDeposit`
- `maxWithdrawal`: the largest single payout.
- `dailyCap`: players and house sweeps combined, per 24h window.
- `cosignAbove`: payouts above this amount need a second signature from the COSIGNER key.

**Roles.**

| Role | Who | Can |
|---|---|---|
| Admin | Safe multisig (behind a timelock on mainnet) | Configure tokens and limits, grant roles, unpause, sweep house funds, edit the allowlist. Handing over admin takes `ADMIN_DELAY` and must be accepted by the new admin. |
| SIGNER | Backend hot signer, held in a KMS | Signs withdrawals |
| COSIGNER | A second key on separate infrastructure | Co-signs large withdrawals. It can never be the same key as SIGNER. |
| GUARDIAN | Monitoring bot or on-call person | Pause deposits and/or withdrawals instantly. Cannot unpause. |

**Allowlist mode** is on at deploy, so only listed wallets can deposit. Keep it on until the licence and KYC are in place.

## Testnet quick start (Robinhood Chain testnet, chain 46630)

1. Make 4 wallets: **deployer**, **signer**, **cosigner** and **guardian**. Get testnet ETH for the deployer from the Robinhood Chain faucet.
2. Install and run the tests:
   ```bash
   npm install --legacy-peer-deps
   npx hardhat test
   ```
3. Deploy:
   ```bash
   DEPLOYER_KEY=0x... SIGNER=0x... COSIGNER=0x... GUARDIAN=0x... ALLOW=0xYourPlayWallet \
   npx hardhat run scripts/deploy.js --network rhTestnet
   ```
   - This deploys the vault plus tMSFT95, tUSDC, tNET and tIMD test tokens.
   - It mints 1,000,000 of each test token to the deployer and every `ALLOW` wallet.
   - It configures limits and turns the allowlist on.
   - Addresses are saved to `deployments/rhTestnet.json`.
4. Try a withdrawal by hand. The backend does this automatically in step 2:
   ```bash
   SIGNER_KEY=0x... VAULT=0x... USER=0x... TOKEN=0x... AMOUNT=10 NONCE=1 \
   npx hardhat run scripts/sign-withdrawal.js --network rhTestnet
   ```
   Then call `withdraw(voucher, signatures)` from the explorer or a script.

## Mainnet (chain 4663)

Only do this after the audits:

```bash
DEPLOYER_KEY=0x... ADMIN=0xYourSafe SIGNER=... COSIGNER=... GUARDIAN=... ALLOW=0xYourWallets \
npx hardhat run scripts/deploy.js --network rhMainnet
```

- The script uses the real USDC, NET and IMD addresses. Add `MSFT95=0x…` once the token is live.
- It starts with small limits. ETH, for example:
  - 0.4 ETH maximum per withdrawal;
  - 2 ETH per day;
  - a cosigner is needed above 0.1 ETH.
- The admin handover to your Safe needs `acceptDefaultAdminTransfer()` from the Safe after the delay.

## What this contract does not do (by design)

- **Player balances.** It doesn't track them; the backend ledger does (step 2).
- **Exit without the operator.** Players can't withdraw if the backend stops signing. This is the standard custodial-casino trust model. The limits, the pause switch and the timelocked admin reduce operator-key risk; they don't remove trust in the operator.
- **Rebasing tokens.** They aren't supported. Only list fixed-balance ERC-20s.
