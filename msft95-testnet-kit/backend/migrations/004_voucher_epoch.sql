-- vault v3: vouchers carry the vault's voucherEpoch; a higher epoch on-chain voids them
ALTER TABLE withdrawals ADD COLUMN epoch numeric(78,0) NOT NULL DEFAULT 0;
