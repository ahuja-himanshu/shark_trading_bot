# Telegram Command Reference

All commands run in the single authorised private chat. Type `/` (or tap the **Menu** button) to open the registered command menu — Telegram shows every command with a description, and tapping one inserts it so you can type its parameters.

Conventions: `<VALUE>` required, `[VALUE]` optional, `A|B` one of the choices. Symbols accept a full contract (`BTCUSDT`) or a base asset (`BTC`), which resolves against your default market.

## Read-only commands

### `/help`

Shows the command list and usage.

### `/health`

Service status: read-only vs trading mode, reconciliation freshness, public/authenticated stream health, REST fallback counters, and current time. Safe output — never exposes listen keys or account identifiers.

### `/wallet [INR|all]`

Futures wallet balance, free/withdrawable, locked, maintenance margin, and unrealised P&L. Shark accounts hold **INR balances only** (USDT deposits are not supported), so `/wallet` and `/wallet all` both show the INR wallet.

### `/markets <ASSET>`

Lists perpetual contracts for a base asset, with quote asset, supported margin assets, and max leverage.

```text
/markets BTC
```

### `/default_market <INR|USDT>`

Sets the market used to resolve bare symbols. After `/default_market USDT`, `/position BTC` means `BTCUSDT`.

### `/open_positions`

All open positions: direction, margin mode, leverage, quantity, entry, liquidation price, margin, unrealised P&L, and position ID.

Unrealised P&L is shown as supplied by Shark; when Shark omits it, the bot estimates it from live mark/mid prices (converted to your margin asset) and labels it **`(est.)`**.

### `/position <SYMBOL>`

One position in detail.

```text
/position PUMPUSDT
```

### `/open_orders [SYMBOL]`

Open orders, optionally filtered by symbol.

### `/pnl open|today|all` and `/pnl <YYYY-MM-DD> <YYYY-MM-DD>`

P&L report per currency: realised, fees, funding, net realised, and current unrealised.

```text
/pnl open
/pnl today
/pnl 2026-01-01 2026-07-18
```

- `open` — per-position breakdown plus aggregate unrealised P&L.
- `today` / custom range — realised trading P&L, fees, and funding for the period, with current unrealised shown separately.
- `all` — complete account history.

Figures are read **live from Shark's transaction-history account postings** for the exact requested range (REALIZED_PNL, commissions + GST, clearance fees, fee discounts, funding + GST) — the same source as the Shark UI's P&L report, so they match it. Day boundaries are Asia/Kolkata. Deposits, withdrawals, and transfers are never counted as trading P&L.

### `/audit <DRAFT_OR_EXECUTION_ID>`

Prints the tamper-evident audit trail (timestamp, action, outcome, hash) for a draft or execution. Use it after an `UNKNOWN` result or to verify exactly what was confirmed.

## Confirmed-action commands

Nothing executes when you send one of these. The bot creates an **expiring draft** with a full preview (quantity, price, fees, estimated liquidation, exposure effect, warnings) and inline buttons. The action reaches Shark only after you tap **Confirm** — and if market conditions changed materially since the preview, the confirmation fails safely instead of placing a stale order.

### `/trade` — open a position

```text
/trade <SYMBOL> <long|short> <market|limit PRICE> margin <AMOUNT> <INR|USDT> leverage <N> [isolated|cross]
```

```text
/trade BTCUSDT long market margin 10000 INR leverage 10
/trade PUMPUSDT short limit 0.001700 margin 5000 INR leverage 5 isolated
```

`margin` is committed capital; notional ≈ margin × leverage. Margin mode defaults to `isolated`; `cross` must be chosen explicitly.

### `/close` — close a position

```text
/close <SYMBOL> market
/close <SYMBOL> limit <PRICE>
/close all
```

Individual closes are re-fetched and submitted reduce-only. `/close all` re-verifies positions at confirmation time.

### `/cancel_orders [SYMBOL]`

Cancels open orders — for one symbol, or all of them. Linked stop-loss/take-profit orders may be included.

### `/sl <SYMBOL> <PRICE>` and `/tp <SYMBOL> <PRICE>`

Set a stop-loss / take-profit on the full open position. The price must be on the correct side of entry (validated in the preview).

### `/edit` — change a draft before confirming

```text
/edit <DRAFT_ID> <margin|leverage|market|order|price|mode> <VALUE>
```

```text
/edit T-1A2B3C4D5E6F leverage 5
/edit T-1A2B3C4D5E6F order limit 0.001650
```

Editing recalculates the preview, bumps the draft version, and invalidates the previous confirm button. Usually you'll use the **Change …** buttons under the draft instead — they ask for the value and apply this command for you.

### `/cancel <DRAFT_OR_ORDER_ID>`

- `/cancel T-…` — discards a draft (same as its **Cancel** button).
- `/cancel <ORDER_ID>` — creates a confirmed draft to cancel that exchange order.

## Drafts, confirmations, and safety states

- Drafts expire after `DRAFT_TTL_SECONDS` (default 120s) and can be edited only while live.
- Each confirmation is single-use, bound to you, your chat, the draft version, and the payload hash. Duplicate taps and replayed callbacks are rejected.
- Execution states: `SUBMITTED` (Shark acknowledged) → `RECONCILED` (postcondition verified). `UNKNOWN` means the response was lost after the request may have reached Shark — **do not retry**; check `/open_positions`, `/open_orders`, and `/audit` first.
- With `TRADING_ENABLED=false`, confirmations are rejected and nothing can execute.
