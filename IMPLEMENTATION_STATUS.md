# Implementation status

## Current verdict

The v1 application is implemented and passes the local automated quality gates. It is intentionally **not yet approved for production trading** because authenticated Shark behaviour, Telegram delivery, PostgreSQL migration/restart behaviour, and the AWS deployment must be validated with the operator's real staged infrastructure.

Keep `TRADING_ENABLED=false` until every live-validation item below is complete.

## Implemented

- Strict Telegram commands for wallets, INR/USDT crypto perpetual markets, positions, orders, editable trade/close/cancel/SL/TP drafts, and P&L.
- Isolated margin by default, with cross margin only by explicit input.
- Explicit committed margin and leverage with notional, quantity, price, fee, liquidation, collateral, and exposure preview fields.
- Exchange tick/precision and quantity-step enforcement, with an explicit increase/reduce/reverse exposure classification and liquidation-estimate assumptions.
- Versioned, expiring, single-use confirmations bound to the authorised Telegram user, private chat, draft version, and payload hash.
- Duplicate Telegram-update protection and atomic confirmation claiming in PostgreSQL.
- Re-fetch of the current position and reduce-only placement for individual closes; re-fetch before the documented close-all call.
- HMAC-signed Shark Futures REST adapter with no withdrawal, deposit, transfer, address, or account-security operation.
- Append-only fill/transaction ingestion, position snapshots, order reconciliation, IST P&L ranges, and exclusion of deposits/transfers from trading P&L.
- Reconciliation-aware `/health` output and truthful `SUBMITTED` versus postcondition-verified `RECONCILED` execution states.
- Shark public Socket.IO depth/mark/ticker subscriptions for active/held symbols, fresh-quote previews, sequence and staleness checks, automatic REST fallback, and bounded reconnect/resubscription.
- Shark authenticated Socket.IO listen-key creation/renewal/deletion, bounded validated event ingestion, duplicate/out-of-order rejection, and REST repair after reconnects, failures, balance changes, or malformed events.
- REST-only confirmation recalculation with a configurable material-change threshold and a new confirmable draft when price, quantity, notional, liquidation estimate, collateral, or target position changes.
- Sanitized stream, last-activity, reconciliation, and REST fallback status in `/health`; no listen key or authenticated URL is persisted or shown.
- Production secrets loaded from AWS Secrets Manager, production PostgreSQL TLS enforcement, structured redaction, and read-only startup by default.
- MIT licence, contribution/security/threat-model documents, pinned dependencies and GitHub Actions, Dependabot, CodeQL, gitleaks, SBOM workflow, and hardened AWS/systemd templates.

The public Shark contract feed and official API examples were checked during implementation. Shark documents Socket.IO client usage, public depth/mark/ticker topics, an authenticated listen-key namespace, account event names, and renewal at least once per hour. The adapter keeps only `PERPETUAL` crypto contracts, excludes `TRADIFI_PERPETUAL`, treats published maker/taker values as percentages, preserves Shark's exchange-provided margin/quote conversion rates, uses the documented order-detail path, sends numeric order fields as JSON numbers, and fails closed on malformed account data.

A live unauthenticated public session confirmed Engine.IO 4, WebSocket upgrade support, and the documented subscription envelope. Real `depthUpdate` and `markPriceUpdate` events contained the expected symbol/time, `U/u/pu`, bid/ask level, and mark-price fields used by the strict parser. The handshake currently advertises a 180-second ping interval, 60-second timeout, and 1,000,000-byte server payload ceiling; the application uses a stricter 262,144-byte message limit and a 300-second liveness window. Authenticated connection and event payload behaviour still requires staged validation with the operator's trade-only key.

## Automated evidence

The following network-independent commands were rerun successfully for this implementation:

```bash
npm run check
npm run test:coverage
npm run build
```

`npm audit --audit-level=high` and gitleaks remain enforced in the public CI/release procedure. They require registry access and the gitleaks binary, so run them in a connected clean clone before release; they are not included in the local evidence above.

The test suite covers command parsing, market resolution, preview arithmetic/rounding, draft editing and replay rejection, close safety, signing/response normalisation, P&L accounting, authorisation/redaction, duplicate Telegram updates, Telegram callback workflows, public subscriptions/quotes/gaps/reconnects, REST fallback, authenticated listen-key lifecycle, bounded event ingestion, account resynchronization, stream failure isolation, confirmation-time material changes, and sanitized health output.

## Required live validation before production

1. Provision a Shark API key that is exchange-side restricted to trading and read access, with withdrawals/transfers/address management disabled. If Shark cannot provide that permission boundary, live trading requires explicit acceptance of that residual risk.
2. Put the real Shark, Telegram, and database values only in AWS Secrets Manager. Never send them in chat, commit them, put them in EC2 user data, or save them in a local repository file.
3. Deploy with `TRADING_ENABLED=false`; apply the PostgreSQL migration against the real TLS connection and prove restart persistence for drafts, confirmations, audit events, orders, and ledger rows.
4. Compare `/wallet`, `/markets`, `/open_positions`, `/open_orders`, `/pnl open`, `/pnl today`, and `/pnl all` with the Shark UI and reconciled account history.
5. Verify Shark production accepts Socket.IO 4.x with WebSocket transport at both documented hosts; verify exact depth, mark, ticker, and every authenticated event payload against the strict normalizers without recording real payloads.
6. Prove listen-key creation, 45-minute renewal, session-expiry recreation, graceful deletion, heartbeat/stale detection, sequence-gap recovery, reconnect/resubscription, REST fallback, and account resynchronization on the real endpoints.
7. Verify unauthorised users, groups, forwarded messages, stale edit replies, duplicate updates, and replayed callbacks are rejected in the real Telegram bot.
8. Enable trading only for staged low-value tests, in this order: smallest valid limit order and cancellation; market entry; individual market and limit close; manual SL/TP; finally `/close all` after a deliberate rehearsal.
9. For each mutation, verify Shark's actual request/response schema, margin-mode behaviour, reduce-only behaviour, fill/fee/funding reconciliation, and the bot's Telegram/audit result.
10. Test an intentionally interrupted response path and confirm it remains `UNKNOWN` without an automatic retry.
11. Run the public GitHub workflows on a clean clone, enable private vulnerability reporting and branch protection, and confirm gitleaks finds no real secret in the complete Git history.
12. Configure CloudWatch alarms, encrypted backup retention, and a successful restore rehearsal before relying on the service.

The staged rollout procedure is in [docs/AWS_DEPLOYMENT.md](docs/AWS_DEPLOYMENT.md), with incident and unknown-outcome handling in [docs/OPERATIONS.md](docs/OPERATIONS.md).
