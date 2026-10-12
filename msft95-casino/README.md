# MSFT95 Casino

| Folder | Step | What |
|---|---|---|
| `contracts/` | 1 | `MSFT95Vault` v2: on-chain custody on Robinhood Chain (deposits, signed withdrawals, caps, pause). See `contracts/README.md`, `contracts/AUDIT.md` and `contracts/AUDIT-RESPONSE.md`. |
| `backend/` | 2 | API, ledger, provably fair Slots and Keno, deposit indexer, withdrawal signer, reconciler. See `backend/README.md` and `backend/SECURITY.md`. |

**Next:** step 3 switches the website's live mode from the old on-chain-spin design to this API: wallet sign-in, deposit, play and withdraw, plus a "verify this bet" page.
