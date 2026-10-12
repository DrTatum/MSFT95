-- backend review fixes
-- 1. provably fair: the NEXT server seed is committed (hash shown) before the player picks a new client seed
ALTER TABLE seeds ADD COLUMN next_seed_enc text;
ALTER TABLE seeds ADD COLUMN next_seed_hash text;
-- 2. withdrawals whose nonce was consumed by a voucher we did not issue are parked for a human
ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_status_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check CHECK (status IN ('signed','paid','refunded','review'));
