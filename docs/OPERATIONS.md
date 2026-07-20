# Operations

## Daily checks

- `/health` shows the intended read-only/trading mode and a recent successful reconciliation without an active failure code.
- Public and authenticated stream states are `HEALTHY`, with recent valid traffic or Socket.IO heartbeat activity. A TCP connection alone is never treated as proof of health.
- REST fallback is available, and reconnect, sequence-gap, invalid-message, and queue-overflow counters are not rising repeatedly.
- Reconciliation runs without repeated failures.
- `/open_positions` and `/open_orders` match Shark.
- P&L has recent fill/funding data and uses Asia/Kolkata boundaries.
- Host time is synchronised.

## Emergency stop

1. Stop the service: `systemctl stop shark-telegram`.
2. Set `TRADING_ENABLED=false` in `/etc/sharkbot/runtime.env`.
3. Inspect and manage positions directly in Shark.
4. If compromise is possible, disable the Shark key and rotate credentials using `SECURITY.md`.

Stopping the service does not close positions or cancel orders.

## Stream degradation

The bot deliberately continues through REST when a Socket.IO stream is unavailable. `DEGRADED`, `STALE`, or `RECONNECTING` does not by itself authorize or block a trade; confirmation still performs authoritative REST checks.

1. Run `/health` and compare public stream, authenticated stream, REST fallback, and reconciliation separately.
2. Confirm DNS and outbound TLS access to `fawss.sharkexchange.in`, `fawss-uds.sharkexchange.in`, and `api.sharkexchange.in` without logging the authenticated URL.
3. Check host time, TLS interception, VPN/proxy idle timeouts, and repeated `PUBLIC_STREAM_STALE`, `ACCOUNT_STREAM_STALE`, or `ACCOUNT_RESYNC_FAILED` codes in redacted logs.
4. A market sequence gap invalidates cached bid/ask and automatically re-subscribes; previews use REST until a valid quote returns.
5. Account reconnect, session expiry, malformed or partial event, queue overflow, balance update, or failed order triggers REST resynchronization. Verify reconciliation becomes recent and successful.
6. If REST is also unavailable, leave trading disabled or stop the service and manage the account directly in Shark.

Never paste a listen key, authenticated stream URL, raw private event, complete account response, or production log into an issue. Listen keys are renewed automatically every 45 minutes by default and deleted on graceful shutdown.

`WEBSOCKET_STALE_AFTER_SECONDS=300` is intentionally longer than Shark's currently advertised 180-second Engine.IO ping interval plus its 60-second ping timeout. Do not lower it below the live heartbeat cadence. `MARKET_QUOTE_MAX_AGE_MS=5000` is a separate, much stricter control for prices.

## Ambiguous execution

`UNKNOWN` means Shark may have accepted a mutating request but the response was lost. The app deliberately does not retry. Check `/open_positions`, `/open_orders`, and the Shark UI before issuing another command. Preserve the draft/execution ID for `/audit`.

## Updates

1. Review changelog, dependency changes, workflow changes, and threat-model impact.
2. Run `npm ci --ignore-scripts`, `npm run check`, `npm run build`, `npm audit --audit-level=high`, and gitleaks.
3. Back up PostgreSQL and test the release in read-only mode.
4. Deploy atomically using a versioned release directory and change `/opt/sharkbot/current` only after validation.
5. Restart and verify reconciliation before enabling trading.
