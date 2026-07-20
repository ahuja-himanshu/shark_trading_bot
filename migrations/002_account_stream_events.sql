BEGIN;

CREATE TABLE IF NOT EXISTS account_stream_events (
  event_key TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  payload_hash TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_stream_entity_time_idx
  ON account_stream_events (entity_key, event_time DESC);

COMMIT;
