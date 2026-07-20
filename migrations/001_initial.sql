BEGIN;

CREATE TABLE IF NOT EXISTS telegram_principals (
  user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL UNIQUE,
  default_market TEXT NOT NULL DEFAULT 'INR' CHECK (default_market IN ('INR', 'USDT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS command_events (
  id UUID PRIMARY KEY,
  telegram_update_id BIGINT UNIQUE,
  actor_user_id TEXT,
  actor_chat_id TEXT,
  command_name TEXT NOT NULL,
  parsed_intent JSONB,
  outcome TEXT NOT NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_drafts (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  intent JSONB NOT NULL,
  preview JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS trade_drafts_owner_idx
  ON trade_drafts (user_id, chat_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS draft_confirmations (
  token_hash TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES trade_drafts(id),
  draft_version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  id UUID PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES trade_drafts(id),
  draft_version INTEGER NOT NULL,
  client_order_id TEXT,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  exchange_order_id TEXT,
  result JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (draft_id, draft_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_client_order_idx
  ON execution_attempts (client_order_id) WHERE client_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS exchange_orders (
  client_order_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  order_type TEXT NOT NULL,
  side TEXT NOT NULL,
  price NUMERIC NOT NULL,
  order_amount NUMERIC NOT NULL,
  filled_amount NUMERIC NOT NULL,
  reduce_only BOOLEAN,
  status TEXT,
  margin_asset TEXT,
  position_id TEXT,
  raw JSONB,
  exchange_created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS position_snapshots (
  id BIGSERIAL PRIMARY KEY,
  position_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  UNIQUE (position_id, captured_at)
);

CREATE INDEX IF NOT EXISTS position_snapshots_latest_idx
  ON position_snapshots (position_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS exchange_fills (
  exchange_fill_id TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price NUMERIC NOT NULL,
  quantity NUMERIC NOT NULL,
  fee NUMERIC NOT NULL,
  realised_profit NUMERIC NOT NULL,
  margin_asset TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exchange_fills_time_idx ON exchange_fills (occurred_at);

CREATE TABLE IF NOT EXISTS wallet_events (
  exchange_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  asset TEXT NOT NULL,
  symbol TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_events_time_idx ON wallet_events (occurred_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  actor_user_id TEXT,
  actor_chat_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  outcome TEXT NOT NULL,
  metadata JSONB NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_entity_idx
  ON audit_events (entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_state (
  stream TEXT PRIMARY KEY,
  cursor_time TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
