# Architecture

## Trust boundaries

```text
Authorised private Telegram chat
        |
        | Telegram HTTPS long polling
        v
Identity gate -> command parser -> preview/draft service -> PostgreSQL
                                      |
                                      | one-time confirmation
                                      v
                               execution service
                                      |
                                      | signed HTTPS
                                      v
                              Shark Futures API

Public Socket.IO -> validated depth/mark/ticker cache -> preview service
                         | stale/missing quote
                         v
                    Shark REST fallback

Authenticated Socket.IO -> bounded validated event queue -> idempotent PostgreSQL ledger
             | connect, reconnect, gap, malformed event, balance/order failure
             v
Reconciliation worker -> Shark REST history/positions/orders -> append-only ledger -> P&L reports
```

Telegram, Shark, AWS, the network, and all incoming API responses are external trust boundaries. PostgreSQL and the service host contain sensitive account metadata even though API secrets are kept in AWS Secrets Manager.

## Main components

- `src/telegram`: long polling, identity extraction, callback handling, force-reply editing, output formatting, and message-size control.
- `src/commands`: strict grammar. Bare amounts are rejected when the unit is required.
- `src/services/preview.ts`: symbol resolution, contract constraints, wallet validation, quote/margin conversion, quantity rounding, and preview estimates.
- `src/streams/public-market-stream.ts`: leased/held-symbol subscriptions, validated depth/mark/ticker cache, sequence-gap detection, liveness, and bounded reconnect backoff.
- `src/services/market-data.ts`: fresh WebSocket quote selection and automatic REST fallback.
- `src/streams/authenticated-account-stream.ts`: listen-key lifecycle, account-event validation, bounded ingestion, idempotency, and REST resynchronization.
- `src/services/drafts.ts`: versioned drafts and single-use short-lived confirmation credentials.
- `src/services/execution.ts`: atomic confirmation claim, fresh exchange checks, state changes, reduce-only closes, and ambiguous-outcome handling.
- `src/exchange`: the only module that knows Shark endpoints or HMAC signing.
- `src/repositories`: PostgreSQL implementation and an in-memory test implementation.
- `src/services/reconciliation.ts`: idempotent ingestion of fills, wallet events, positions, and orders.
- `src/services/pnl.ts`: realised P&L, fees, funding, and separate unrealised P&L by currency. Historical ranges are read through from Shark at request time (the local ledger only covers history reconciled since the bot first ran), using the shared paginated readers in `src/services/history.ts`. Realised P&L, fees, and funding are computed from transaction-history account postings (REALIZED_PNL, COMMISSION/GST_ON_COMMISSION, CLEARANCE_FEE/GST_ON_CLEARANCE_FEE, FEE_DISCOUNT, FUNDING_FEE/GST_ON_FUNDING_FEE) — the same source as the exchange UI; per-fill trade-history fields are incomplete.
- `src/services/unrealised-pnl.ts`: per-position unrealised P&L estimated from live mark/mid prices and contract conversion rates when Shark omits it; exchange-supplied values always win.

## Domain distinctions

- `symbol` selects the contract, for example `BTCUSDT`.
- `quoteAsset` is the contract price currency.
- `marginAsset` is collateral reported/supported by Shark. It must never be inferred from the symbol.
- `marginAmount` is committed capital. Estimated notional is margin multiplied by leverage, then converted into quote currency using exchange metadata when required.

## Persistence and idempotency

Telegram `update_id` has a unique database constraint. A duplicate delivery does not run twice. Confirmation rows are locked in a PostgreSQL transaction; claiming one atomically consumes the token, changes the draft to `EXECUTING`, and creates a unique execution attempt. `(draft_id, draft_version)` is unique.

Shark's documented place-order schema does not accept a caller-provided client order ID. Therefore an order request that times out after transmission is marked `UNKNOWN` and is not retried. The operator must inspect open positions/orders before taking another action.

`SUBMITTED` means Shark acknowledged the mutation but its account postcondition has not been verified. `RECONCILED` is used only after the relevant positions/orders were re-read successfully, or when confirmation-time state proves there is nothing left to change. Scheduled reconciliation remains the accounting source of truth.

## Hybrid stream and REST correctness model

Shark's documented feeds use Socket.IO. The public connection subscribes only to leased preview symbols and symbols reported as held by REST reconciliation. Quotes contain bid, ask, mark/ticker price, exchange time, receipt time, and depth update IDs. Preview subscriptions expire automatically; market ticks are not written to PostgreSQL.

WebSocket is never an order transport. REST remains responsible for every mutation, initial snapshot, historical backfill, confirmation-time wallet/contract/position checks, and recovery. A quote older than `MARKET_QUOTE_MAX_AGE_MS`, a missing side, disconnect, or sequence gap causes transparent REST fallback. A confirmed trade or close is recalculated using REST-only data. If entry, quantity, notional, liquidation estimate, free collateral, or target position changes beyond `CONFIRMATION_MATERIAL_CHANGE_BPS`, the consumed draft fails without mutation and a new single-use confirmation is issued for a refreshed draft.

The authenticated stream uses a listen key held only in memory and renewed before one hour. Events are size-limited and parsed into the same strict domain types as REST responses. A bounded queue prevents memory growth. PostgreSQL stores only a deduplication key, entity key, event type, event time, and payload hash for stream idempotency; it never stores the listen key or raw private stream event. Duplicate or out-of-order events are ignored, while reconnects, malformed or partial events, balance changes, failures, and queue pressure trigger REST reconciliation.

The default stream-stale window is 300 seconds because Shark's live public Engine.IO 4 handshake currently advertises a 180-second ping interval and 60-second ping timeout. Quote freshness remains independently limited to five seconds, so this longer connection-liveness window never permits an old trading quote.

## Audit chain

Audit events contain a SHA-256 hash of the canonical event and the previous event hash. This detects later modification or deletion within the chain. Database administrators can still replace the entire database; ship logs/backups to an independently controlled account if stronger non-repudiation is required.
