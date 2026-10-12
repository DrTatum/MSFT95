# Security brief: MSFT95 casino backend

Audit scope: everything in `src/`. Read with `contracts/AUDIT.md`, which covers the vault this server signs for.

## Assets and threats

| Asset | Threat | Defence (where) |
|---|---|---|
| Player balances | Double-spend through concurrent bets or withdrawals | Each money transaction locks the player's `users` row first, then books balanced entries. A CHECK constraint stops balances going negative. (`ledger.ts`, `games/service.ts`, `withdrawals.ts`) |
| Player balances | Replayed or duplicated requests | `bets(user_id, request_id)` is unique, so a repeat returns the stored result. `journal(kind, ref)` is unique, so one event is booked once. |
| Vault funds | Stolen SIGNER key | Vault caps (per payout, per day, cosign above a threshold). The indexer freezes withdrawals on any `Withdrawn` it didn't issue. The reconciler pauses the vault through the guardian. |
| Vault funds | Refunded voucher later executed (double pay) | A refund only happens once a **confirmed** block's timestamp is strictly past the deadline (the vault already treats `timestamp >= deadline` as expired) **and** `nonceUsed` is false at that block. Timestamps only increase, so the voucher can't run later. (`expireWithdrawals`) |
| Vault funds | Long-lived or forged vouchers after a key leak | Vault v2 vouchers carry `issuedAt` and can't pay more than 24h after signing. The guardian can void every voucher signed before a time (`voidVouchersIssuedBefore`); voided vouchers are refunded the same way as expired ones. `WITHDRAWAL_TTL_SEC` is capped below 24h. |
| Vault funds | Ledger and chain drift (missed or extra events) | The reconciler checks vault balance == players + pending + house at the indexed block. It freezes on a shortfall or negative drift. |
| Deposits | Reorgs, double crediting | Only blocks `CONFIRMATIONS` deep are indexed. `chain_events` is keyed by (chain, tx, logIndex). |
| Game fairness | Server picks outcomes after seeing the bet | The server seed hash is committed before any bet, the client seed is player-chosen, and the nonce increments every round. Results are recomputable after rotation. (`fair.ts`) |
| Game fairness | Database leak reveals future results | Server seeds are AES-256-GCM encrypted with `SEED_KEY`, which lives outside the database. |
| Game math | Server and website disagree | `src/games/math.js` is copied verbatim from the site. A test checks its sha256 against the site. Payouts are exact integers at a fixed scale. |
| Sessions | Replayed or forged sign-in | SIWE checks domain, URI origin, chain id, age ≤10 min and the signature. Nonces are one-time and expire. Only the sha256 of the session token is stored. |
| Sessions | CSRF | The cookie is SameSite=Strict, and POSTs from unknown Origins are rejected. CORS is restricted to `CORS_ORIGINS`. |
| House bankroll | One bet that could win more than the house can pay | A bet is refused unless `bet × maxWinX ≤ maxPayout` for its token. Per-token min and max bets apply too. |
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
