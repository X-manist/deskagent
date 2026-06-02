-- DeskAgent backend schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL DEFAULT 'user',
  free_turns_used INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);

-- Local anti-abuse only; the verification code itself is held/verified by Aliyun.
CREATE TABLE IF NOT EXISTS sms_throttle (
  phone        TEXT PRIMARY KEY,
  last_sent_at TEXT,
  send_count   INTEGER NOT NULL DEFAULT 0,
  window_start TEXT,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  lockout_until TEXT
);

-- Purchasable plans. Admin sets model + total_tokens (allowance).
CREATE TABLE IF NOT EXISTS packages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  model         TEXT NOT NULL,
  total_tokens  INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Orders carry a snapshot of package terms at purchase time (do not trust the
-- live packages row, which may change later). State machine:
--   created -> pending_payment -> paid -> granted   (or -> expired/cancelled)
CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  out_trade_no   TEXT NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  package_id     INTEGER REFERENCES packages(id),
  pkg_name       TEXT NOT NULL,
  pkg_model      TEXT NOT NULL,
  pkg_tokens     INTEGER NOT NULL,
  pkg_days       INTEGER NOT NULL,
  amount_cents   INTEGER NOT NULL,
  provider       TEXT NOT NULL,            -- manual | alipay | wechat
  status         TEXT NOT NULL DEFAULT 'pending_payment',
  provider_txn   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at        TEXT,
  granted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

-- One row per granted purchase. Balances stack; the gateway picks a valid
-- entitlement (not expired, has remaining tokens) matching the requested model.
CREATE TABLE IF NOT EXISTS entitlements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  order_id        INTEGER REFERENCES orders(id),
  model           TEXT NOT NULL,
  token_allowance INTEGER NOT NULL,
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  starts_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(user_id);

-- Reserve-then-reconcile metering. One row per gateway request.
CREATE TABLE IF NOT EXISTS usage_sessions (
  id               TEXT PRIMARY KEY,        -- request id (uuid)
  user_id          INTEGER NOT NULL REFERENCES users(id),
  source           TEXT NOT NULL,           -- 'free' | 'entitlement'
  entitlement_id   INTEGER REFERENCES entitlements(id),
  model            TEXT,
  reserved_tokens  INTEGER NOT NULL DEFAULT 0,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'reserved', -- reserved|completed|failed|usage_unknown
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_sessions(user_id);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Remote connection support. A desktop assistant registers one machine row,
-- the mobile app scans a short-lived pairing code, then sends commands through
-- the backend. Machine tokens authenticate only machine-poll/result endpoints.
CREATE TABLE IF NOT EXISTS remote_machines (
  id                 TEXT PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  label              TEXT NOT NULL,
  hostname           TEXT NOT NULL,
  platform           TEXT NOT NULL,
  app_version        TEXT,
  machine_token_hash TEXT NOT NULL,
  public_key         TEXT,
  metadata_json      TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at       TEXT,
  revoked_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_remote_machines_user ON remote_machines(user_id);

CREATE TABLE IF NOT EXISTS remote_pairings (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  machine_id   TEXT NOT NULL REFERENCES remote_machines(id),
  payload_json TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_remote_pairings_user ON remote_pairings(user_id);
CREATE INDEX IF NOT EXISTS idx_remote_pairings_machine ON remote_pairings(machine_id);

CREATE TABLE IF NOT EXISTS remote_commands (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  machine_id   TEXT NOT NULL REFERENCES remote_machines(id),
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  result_json  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_remote_commands_machine_status ON remote_commands(machine_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_remote_commands_user ON remote_commands(user_id, created_at);
