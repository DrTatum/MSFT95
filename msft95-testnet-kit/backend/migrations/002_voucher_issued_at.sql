-- vault v2: vouchers carry the time they were signed (deadline is at most 24h after it)
ALTER TABLE withdrawals ADD COLUMN issued_at bigint NOT NULL DEFAULT 0;
