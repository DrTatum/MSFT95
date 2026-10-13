# Security brief: MSFT95 casino backend

Revised after an internal four-reviewer security review (2026-10-12): see "Review findings and fixes" at the end.

Audit scope: everything in `src/`. Read with `contracts/AUDIT.md`, which covers the vault this server signs for.

## Assets and threats

| Asset | Threat | Defence (where) |
|---|---|---|
| Player balances | Double-spend through concurrent bets or withdrawals | Each money transaction locks the player's `users` row first, then books balanced entries. A CHECK constraint stops balances going negative. (`ledger.ts`, `games/service.ts`, `withdrawals.ts`) |
| Player balances | Replayed or duplicated requests | `bets(user_id, request_id)` is unique, so a repeat returns the stored result. `journal(kind, ref)` is unique, so one event is booked once. |
| Vault funds | Stolen SIGNER key | Vault caps (per payout, per day, cosign above a threshold). The indexer freezes withdrawals on any `Withdrawn` it didn't issue. The reconciler pauses the vault through the guardian. |
| Vault funds | Refunded voucher later executed (double pay) | A refund only happens once a **confirmed** block's timestamp is strictly past the deadline (the vault already treats `timestamp >= deadline` as expired) **and** `nonceUsed` is false at that block. Timestamps only increase, so the voucher can't run later. (`expireWithdrawals`) |
| Vault funds | Long-lived or forged vouchers after a key leak | Vault v3 vouchers carry the vault's `voucherEpoch` and an `issuedAt`, and live at most 24h after it. `voidAllVouchers()` and any revocation of a signing key bump the epoch, killing every outstanding voucher (including future-dated ones). The backend reads the epoch when signing, and refunds voided vouchers as soon as a confirmed block shows the higher epoch, without waiting for the deadline. `WITHDRAWAL_TTL_SEC` is capped below 24h. |
| Vault funds | Ledger and chain drift (missed or extra events) | The reconciler checks vault balance == players + pending + house at the indexed block. It freezes on a shortfall or negative drift. |
| Deposits | Reorgs, double crediting | Only blocks `CONFIRMATIONS` deep are indexed. `chain_events` is keyed by (chain, tx, logIndex). |
| Game fairness | Server picks outcomes after seeing the bet, or picks its seed after seeing the player's client seed | The active server seed hash **and the next server seed hash** are shown before the player chooses a client seed; rotating activates the pre-committed seed. The nonce increments every round. Every bet returns its seed hash, client seed and nonce, and the revealed server seed once rotated. (`fair.ts`) |
| Game fairness | Database leak reveals future results | Server seeds are AES-256-GCM encrypted with `SEED_KEY`, which lives outside the database. |
| Game math | Server and website disagree | `src/games/math.js` is copied verbatim from the site. A test checks its sha256 against the site. Payouts are exact integers at a fixed scale. |
| Sessions | Replayed or forged sign-in | SIWE checks domain, URI origin, chain id, age ≤10 min and the signature. Nonces are one-time and expire. Only the sha256 of the session token is stored. |
| Sessions | CSRF | The cookie is SameSite=Strict, and POSTs from unknown Origins are rejected. CORS is restricted to `CORS_ORIGINS`. |
| House bankroll | One bet that could win more than the house can pay | A bet is refused unless `bet × maxWinX ≤ maxPayout` for its token, and a bet's whole bonus (the triggering round plus every free round, or a bought bonus) is capped at `maxWinX × bet`, in Slots and Keno. |
| Price manipulation (thin tokens) | Pump a token's price, then cash out "in dollars" | Bets and wins are in the **same token**, so dollar prices never enter settlement. |

## Invariants (good targets for the swarm)

1. For every journal entry, the postings sum to zero. Each account's `balance` equals the sum of its postings (`checkIntegrity`).
2. `user` and `pending` balances are never negative.
3. A `bets.request_id` charges a player at most once.
4. Every non-free round uses a fresh (seed, nonce). No (seed_id, nonce) pair is ever used twice.
5. A withdrawal moves from `signed` to `paid` or `refunded` exactly once, and never to both.
6. At the indexed block: vault balance ≥ players + pending. It equals players + pending + house unless value was forced in (SELFDESTRUCT or a plain token transfer), which is surplus and never triggers a freeze.
7. The free-spin and free-game state can't be created without a qualifying round or a Buy Bonus charge, and runs on the bonus bet, not the request's bet.

## Known gaps (do before mainnet)

- **Signer.** `LocalKeySigner` reads keys from env and is for testnet only. Mainnet refuses it. Implement a `VoucherSigner` backed by AWS KMS, GCP KMS, Turnkey or similar.
- **Cosigner.** Run the cosigner as a **separate service** on separate infrastructure. Before signing, it should independently re-check the player's ledger and limits, ideally from a read replica.
- **Alerts.** Alerts are only log lines (`ALERT …`). Wire them to PagerDuty, Telegram or similar.
- **Admin tooling.** There's no admin tooling yet. Unfreezing a flag is a manual SQL update, on purpose.
- **Rate limits.** They are per IP, at 120 requests per minute (stricter on login and withdrawals). Add per-account limits and bot detection.
- **Compliance.** There's no KYC, geo-blocking or age verification yet. They're required before real players.
- **Database.** Use managed Postgres with point-in-time recovery. The database user should not be a superuser.

## Review findings and fixes (2026-10-12)

Four independent reviewers each covered one area: the ledger and games, chain and withdrawals, sign-in and the API, and fairness. Every finding below was reproduced, then fixed, and now has a regression test.

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1 | High | A stolen signer key drains the vault: the indexer froze the backend, but the books still balanced, so the vault was never paused. | An unexpected `Withdrawn` event now makes the indexer loop pause the vault through the guardian right away, and the reconciler pauses whenever withdrawals are frozen for an unexpected payout. (`guardian.ts`, `index.ts`, `reconcile.ts`) |
| 2 | Med | The reconciler read the chain and the ledger at different moments, so a normal deposit could cause a false shortfall and an on-chain pause. | It now reads the cursor and the ledger in one REPEATABLE READ snapshot and the chain at that same block. Negative drift is also treated as a shortfall. |
| 3 | Med | Fairness: the server generated its new seed after seeing the player's client seed, so it could grind seeds. | The next server seed is committed before the client seed is chosen (`nextServerSeedHash` in `/me` and in rotate). |
| 4 | Med | A Keno bonus (and a Slots trigger spin plus its bonus) could pay more than `maxWinX × bet`. | A running cap covers the whole bonus, triggering round included. |
| 5 | Med | `trustProxy: true` let clients fake their IP and bypass every rate limit. | `TRUST_PROXY` is now a hop count, and docker-compose binds the API to localhost. |
| 6 | Low | Rate limits were per session, and sessions cost nothing to make. | Limits are per IP, plus a second per-account limit. |
| 7 | Low | The session cookie wasn't `Secure` unless `NODE_ENV=production`. | The cookie is `Secure` everywhere except tests, and the Dockerfile sets `NODE_ENV=production`. |
| 8 | Low | A voucher whose nonce was used by a voucher we didn't issue stayed `signed` forever. | Such a voucher becomes `review` and freezes withdrawals. Nonces are now random 128-bit, so nobody can burn future ones. |
| 9 | Low | A requestId was shared across games, and a replay didn't include the balance or bonus state. | A requestId reused on another game or token now returns 409. Replays include the current balance and bonus. |
| 10 | Low | Concurrent first `/me` calls, or rotate during a bet, could return 500 or deadlock. | `/me` and rotate lock the user first, and seed creation is conflict-safe. |
| 11 | Low | Some bad inputs returned 500: `before=1e19`, a 413 body, an unparseable SIWE uri, a fractional session TTL. | These now return 4xx, and the config is validated. |
| 12 | Low | Bets older than the 50 most recent revealed seeds couldn't be verified through the API. | `/bets` returns the seed hash, client seed and revealed seed. `/fair/history` is paginated and accepts `?hash=`. |
| 13 | Low | A cookie POST with no Origin header was accepted. | Cookie sessions now need an Origin on POST. The session token is only returned in the body when the request asks for it. |
| 14 | Info | Deposits in unconfigured tokens weren't reconciled. | Every token with balances is reconciled, and these deposits raise an alert. |
| 15 | Info | A guardian pause transaction that never got mined hung the reconciler. | The pause has a timeout, and every worker run is abandoned after 5 minutes. |
| 16 | Info | Expired sessions and nonces were never cleaned up, and the mainnet key guard only covered chain 4663. | Expired rows are now cleaned up, and env keys are only allowed on hardhat or Robinhood Chain testnet. |

## Operations runbook (from the review's unverified notes)

- **After restoring the database from a backup:** call `voidAllVouchers()` on the vault before restarting. Vouchers signed after the backup point would otherwise still be payable while their debits have rolled back.
- **RPC:** use one provider (not a load-balanced pool) with archive access. The reconciler reads balances at past blocks. A lagging node can return empty logs and the cursor would move past missed events.
- **Reorgs:** set `CONFIRMATIONS` above the chain's realistic reorg depth. Block hashes aren't stored, so a deeper reorg isn't detected (the reconciler would flag the resulting shortfall).
- **Players:** the website should have each player set their own client seed before their first bet.
- **SEED_KEY:** back it up. Losing it makes active seeds unrecoverable. There's no key versioning yet.
- **Website copy:** some RTP and Buy Bonus figures in the website text are out of date (Keno "93.7–95.3%", the Slots buy "about 97%/98%"). They will be updated in step 3.
