# MSFT95 Casino

| Folder | Step | What |
|---|---|---|
| `msft95-vault/` | 1 | `MSFT95Vault` v2: on-chain custody on Robinhood Chain (deposits, signed withdrawals, caps, pause). See `msft95-vault/README.md`, `msft95-vault/AUDIT.md` and `msft95-vault/AUDIT-RESPONSE.md`. |
| `msft95-backend/` | 2 | API, ledger, provably fair Slots and Keno, deposit indexer, withdrawal signer, reconciler. See `msft95-backend/README.md` and `msft95-backend/SECURITY.md`. |

**Next:** step 3 switches the website's live mode from the old on-chain-spin design to this API: wallet sign-in, deposit, play and withdraw, plus a "verify this bet" page.
