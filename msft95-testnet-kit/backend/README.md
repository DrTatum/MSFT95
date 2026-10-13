# MSFT95 Casino Backend (step 2)

The Stake-style server behind the MSFT95 games:

- Players sign in with their wallet.
- Their balance lives in a double-entry ledger.
- Slots and Keno are settled on the server with provably fair randomness.
- Deposits are read from the vault contract (step 1), and withdrawals are paid by vault-verified vouchers that this server signs.

**Stack:** Node 22, TypeScript, Fastify, PostgreSQL, ethers v6.

**Tests:** 53 tests across 6 files. The end-to-end test runs the real step-1 vault on a local chain.

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
| POST | `/auth/login` | Takes `{message, signature}`. Sets an httpOnly session cookie. Scripts can send the header `x-session-token: body` to get the token back for Bearer use. |
| POST | `/auth/logout` | Ends the session |
| GET | `/me` | Address, balances, current seed hash, the committed next seed hash, client seed, nonce, and running bonuses |
| POST | `/games/slots` | Takes `{token, bet, requestId, action: "spin" \| "buy"}`. While free spins are running, `spin` plays the next free one. |
| POST | `/games/keno` | Takes `{token, bet, requestId, picks:[1..80], action}` |
| GET | `/bets` | Bet history, with the stops or draw, nonce, seed hash, client seed and (once rotated) the revealed server seed |
| POST | `/fair/rotate` | Takes `{clientSeed?}`. Reveals the old server seed and starts a new pair. |
| GET | `/fair/history` | Revealed seed pairs (`?before=`, `?hash=`) |
| GET | `/deposits` | Your indexed deposits |
| POST | `/withdrawals` | Takes `{token, amount}`. Returns `{voucher, signatures}` for the wallet to submit to `vault.withdraw()`. The voucher is `{user, token, amount, nonce, epoch, issuedAt, deadline}` (vault v3). |
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

## Connect the website (step 3)

The site's "Real tokens" mode talks to this API. In `index.html`, set:

```js
var CASINO={ api:'https://api.msft95.com', vault:'0x…your vault…', rpcUrls:['https://rpc.testnet.chain.robinhood.com'], chainName:'Robinhood Chain Testnet', explorer:'…' };
```

The site refuses to connect if `/info` reports a different vault from `CASINO.vault`. On the backend, `SIWE_DOMAIN` must be the site's host (e.g. `msft95.com`), and `SIWE_ORIGIN` and `CORS_ORIGINS` must be its origin (`https://msft95.com`).

To try a testnet backend before changing the site, open the site, open the browser console, and run `localStorage.setItem('msft95.casinoApi','https://your-testnet-api')`, then reload. That only changes your own browser.

What the site does in live mode:

- **Sign in.** It connects the wallet, switches to the backend's chain, and signs a Sign-In With Ethereum message (no gas).
- **Deposit.** It calls `vault.deposit` (with an approve first if needed) or `depositETH`, then polls `/me` until the indexer credits it.
- **Play.** Bernard Slots and Kimmy Keno send each spin or draw to `/games/*` with a fresh `requestId`, including Buy Bonus and free spins. The reels animate the server's stops and draws, and the page's own maths must give the same payout. If the page was closed mid-bonus, the next Spin resumes it.
- **Withdraw.** It calls `POST /withdrawals`, then sends `vault.withdraw(voucher, sigs)` from the wallet. Vouchers that weren't sent show under "Withdrawals waiting" with a Claim button.
- **Fair play.** The cashier shows the server seed hash, client seed and nonce. "New pair" reveals the old server seed so players can check it.

Mines, Hi-Lo and Crash stay practice-only until they're added here.

### Full local run (chain + backend + site)

```bash
# terminal 1: a local chain
cd ../contracts && npx hardhat node --port 8547
# terminal 2: deploy the vault and test tokens, then start the API
mkdir -p /tmp/e2e && node e2e-setup.mjs /tmp/e2e
source /tmp/e2e/env.sh && npm start          # API on :8788, SIWE domain localhost:8090
# keep blocks coming so deposits confirm (hardhat only mines on transactions):
node -e 'setInterval(()=>fetch("http://127.0.0.1:8547",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"evm_mine",params:[]})}),1000)'
# terminal 3: serve the site on http://localhost:8090, set msft95.casinoApi to http://localhost:8788
```

`e2e-setup.mjs` funds a player wallet (key `0xa1a1…a1`) with test USDC, test MSFT95 and ETH. Import that key into a throwaway wallet profile to play.

## Before mainnet

See `SECURITY.md`. The short version:

- Replace the env-key signers with a KMS-backed `VoucherSigner`, and run the cosigner as its own service. Mainnet refuses env keys.
- Get a professional audit, and run your agent swarm on `SECURITY.md`.
- Sort out the licence, KYC and geo-blocking.
