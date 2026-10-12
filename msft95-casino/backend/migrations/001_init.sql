-- MSFT95 casino ledger. Amounts are integers in each token's base units (numeric(78,0) fits uint256).

CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  address       text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-f]{40}$'),   -- lowercase
  created_at    timestamptz NOT NULL DEFAULT now(),
  self_excluded_until timestamptz,
  withdraw_nonce numeric(78,0) NOT NULL DEFAULT 0      -- last voucher nonce issued to this user
);

-- one-time sign-in challenges
CREATE TABLE auth_nonces (
  nonce       text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,                         -- sha256 of the bearer token; the token itself is never stored
  user_id     bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id);

-- double-entry ledger -------------------------------------------------------------------------
-- kinds: user (a player's balance, never negative), pending (withdrawals signed but not yet paid),
--        house (bankroll / house profit), and the outside world: deposits_in, bankroll_in, paid_out, swept_out
CREATE TABLE accounts (
  id       bigserial PRIMARY KEY,
  kind     text NOT NULL CHECK (kind IN ('user','pending','house','deposits_in','bankroll_in','paid_out','swept_out')),
  user_id  bigint REFERENCES users(id),
  token    text NOT NULL,                                -- token address, lowercase; 0x000…0 = ETH
  balance  numeric(78,0) NOT NULL DEFAULT 0,
  CHECK ((kind = 'user') = (user_id IS NOT NULL)),
  CHECK (kind NOT IN ('user','pending') OR balance >= 0)
);
CREATE UNIQUE INDEX accounts_user_token ON accounts(user_id, token) WHERE kind = 'user';
CREATE UNIQUE INDEX accounts_system_token ON accounts(kind, token) WHERE kind <> 'user';

CREATE TABLE journal (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,          -- deposit | bet | win | withdrawal | withdrawal_paid | withdrawal_refund | bankroll | sweep
  ref        text NOT NULL,          -- what caused it (deposit key, bet id, withdrawal id…)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref)                 -- the same event can never be booked twice
);

CREATE TABLE postings (
  journal_id bigint NOT NULL REFERENCES journal(id),
  account_id bigint NOT NULL REFERENCES accounts(id),
  amount     numeric(78,0) NOT NULL CHECK (amount <> 0)
);
CREATE INDEX postings_account ON postings(account_id);
CREATE INDEX postings_journal ON postings(journal_id);

-- provably fair seeds -----------------------------------------------------------------------------
CREATE TABLE seeds (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES users(id),
  server_seed_enc  text NOT NULL,           -- AES-256-GCM encrypted with SEED_KEY
  server_seed_hash text NOT NULL,           -- sha256(server seed), shown to the player before any bet
  client_seed      text NOT NULL,
  nonce            bigint NOT NULL DEFAULT 0,   -- bets made with this pair
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revealed_at      timestamptz,
  server_seed      text                      -- filled in only when the pair is retired
);
CREATE UNIQUE INDEX seeds_one_active ON seeds(user_id) WHERE active;

-- games -------------------------------------------------------------------------------------------
CREATE TABLE bets (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  request_id  text NOT NULL,                -- client idempotency key
  game        text NOT NULL,                -- slots | keno
  action      text NOT NULL,                -- spin | free | buy | play
  token       text NOT NULL,
  amount      numeric(78,0) NOT NULL,       -- debited from the player (0 for free rounds)
  bet         numeric(78,0) NOT NULL,       -- stake the round is paid on
  payout      numeric(78,0) NOT NULL,
  seed_id     bigint REFERENCES seeds(id),
  nonce       bigint,
  params      jsonb NOT NULL DEFAULT '{}',
  result      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id)
);
CREATE INDEX bets_user ON bets(user_id, id DESC);

-- a running bonus (slots free spins / keno free games), one per user + game + token
CREATE TABLE features (
  user_id   bigint NOT NULL REFERENCES users(id),
  game      text NOT NULL,
  token     text NOT NULL,
  bet       numeric(78,0) NOT NULL,
  left_n    int NOT NULL,
  total_n   int NOT NULL,
  won       numeric(78,0) NOT NULL DEFAULT 0,
  params    jsonb NOT NULL DEFAULT '{}',
  bought    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, game, token)
);

-- chain ---------------------------------------------------------------------------------------------
CREATE TABLE chain_cursor (
  name        text PRIMARY KEY,
  last_block  bigint NOT NULL
);

CREATE TABLE chain_events (
  chain_id    bigint NOT NULL,
  tx_hash     text NOT NULL,
  log_index   int NOT NULL,
  block_number bigint NOT NULL,
  event       text NOT NULL,
  data        jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE TABLE withdrawals (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  token       text NOT NULL,
  amount      numeric(78,0) NOT NULL CHECK (amount > 0),
  nonce       numeric(78,0) NOT NULL,
  deadline    bigint NOT NULL,              -- unix seconds
  status      text NOT NULL CHECK (status IN ('signed','paid','refunded')),
  signatures  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz,
  tx_hash     text,
  UNIQUE (user_id, nonce)
);
CREATE INDEX withdrawals_open ON withdrawals(status, deadline) WHERE status = 'signed';

-- kill switches the reconciler (or an operator) can flip
CREATE TABLE system_flags (
  name       text PRIMARY KEY,
  value      boolean NOT NULL,
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_flags(name, value) VALUES ('withdrawals_frozen', false), ('betting_frozen', false);
