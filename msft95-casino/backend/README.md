# MSFT95 Casino Backend (step 2)

The Stake-style server behind the MSFT95 games:

- Players sign in with their wallet.
- Their balance lives in a double-entry ledger.
- Slots and Keno are settled on the server with provably fair randomness.
- Deposits are read from the vault contract (step 1), and withdrawals are paid by vault-verified vouchers that this server signs.

**Stack:** Node 22, TypeScript, Fastify, PostgreSQL, ethers v6.

**Tests:** 42 tests across 6 files. The end-to-end test runs the real step-1 vault on a local chain.

## How money moves

```
wallet ──deposit()──▶ vault ──Deposited event──▶ indexer ──▶ ledger: player balance
player ──POST /games/slots──▶ ledger: stake → house, win → player (one DB transaction)
player ──POST /withdrawals──▶ ledger: player → pending, server signs voucher
wallet ──withdraw(voucher)──▶ vault pays ──Withdrawn event──▶ indexer: pending → paid
voucher never used ──▶ after its deadline is past in a confirmed block ──▶ refunded
every minute: reconciler checks vault balance == players + pending + house
```

## Folders

| Path | What |
|---|---|
| `src/ledger.ts` | Double-entry ledger. Every entry sums to zero, and the same event can't be booked twice. Player balances can't go negative. |
| `src/fair.ts` | Provably fair randomness: HMAC-SHA256(serverSeed, `clientSeed:nonce:i`). Seeds are encrypted at rest. Players rotate seeds to reveal them. |
| `src/games/math.js` | The **exact** Slots and Keno code from the website, copied by `scripts/extract-math.mjs`. |
| `src/games/service.ts` | Bets, free spins and free games, Buy Bonus, max-win caps, idempotent request ids. |
| `src/auth.ts` | Sign-In With Ethereum: one-time nonces, domain, chain and age checks, hashed session tokens. |
| `src/indexer.ts` | Books vault events once they are `CONFIRMATIONS` deep. It freezes withdrawals on any payout it didn't issue. |
| `src/withdrawals.ts` | Withdrawal limits and voucher signing. Large ones get a cosigner signature. Expired vouchers are refunded safely. |
| `src/reconcile.ts` | Checks that the vault holds what the ledger says. On a shortfall it freezes withdrawals and can pause the vault on-chain. |
| `src/server.ts` | The HTTP API (below). |

## API

All POST endpoints take and return JSON. Amounts are strings of whole base units (wei for ETH; 6 decimals for USDC).

| Method | Path | |
|---|---|---|
| GET | `/info` | Chain, vault, tokens and their limits, game versions, and the sha256 of the math |
| GET | `/auth/nonce` | Returns `{nonce, domain, uri, chainId}` for the wallet's sign-in message |
| POST | `/auth/login` | Takes `{message, signature}`. Sets an httpOnly session cookie (and also returns the token). |
| POST | `/auth/logout` | Ends the session |
| GET | `/me` | Address, balances, current seed hash, client seed, nonce, and running bonuses |
| POST | `/games/slots` | Takes `{token, bet, requestId, action: "spin" \| "buy"}`. While free spins are running, `spin` plays the next free one. |
| POST | `/games/keno` | Takes `{token, bet, requestId, picks:[1..80], action}` |
| GET | `/bets` | Bet history, with the stops or draw, nonce and seed hash for each bet |
| POST | `/fair/rotate` | Takes `{clientSeed?}`. Reveals the old server seed and starts a new pair. |
| GET | `/fair/history` | Revealed seed pairs |
| GET | `/deposits` | Your indexed deposits |
| POST | `/withdrawals` | Takes `{token, amount}`. Returns `{voucher, signatures}` for the wallet to submit to `vault.withdraw()`. The voucher is `{user, token, amount, nonce, issuedAt, deadline}` (vault v2). |
| GET | `/withdrawals` | Your withdrawals and their status |
| POST | `/self-exclude` | Takes `{days}`. Blocks betting for that long and can't be shortened. |

`requestId` is the client's idempotency key. Sending the same one twice returns the first result and never charges twice.

## Run it locally

```bash
# Postgres 16 running locally, or: docker compose up db
npm install
cp .env.example .env              # fill in VAULT_ADDRESS, SEED_KEY (openssl rand -hex 32), SIGNER_KEY, COSIGNER_KEY
node scripts/tokens-from-deployment.mjs rhTestnet   # writes config/tokens.testnet.json from the step-1 deploy
npm run migrate
npm start                          # API on :8787, plus indexer, expiry and reconciler loops
```

To run the tests, you need Postgres with a `casino_test` database (`TEST_DATABASE_URL` overrides the default) and `../contracts` installed and compiled:

```bash
npm test
```

## Before mainnet

See `SECURITY.md`. The short version:

- Replace the env-key signers with a KMS-backed `VoucherSigner`, and run the cosigner as its own service. Mainnet refuses env keys.
- Get a professional audit, and run your agent swarm on `SECURITY.md`.
- Sort out the licence, KYC and geo-blocking.
