# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses semantic versioning.

## [Unreleased]

### Added

- Security-first Telegram command gateway for one authorised private user/chat.
- Shark Futures REST client with HMAC signing and response normalisation.
- INR/USDT market discovery with separate quote and margin-asset handling.
- Editable, versioned, expiring trade/close/cancel/protection drafts.
- Atomic one-time confirmation and duplicate-update protection.
- Reduce-only individual closes and confirmed close-all workflow.
- PostgreSQL audit, execution, reconciliation, and P&L ledger.
- AWS Secrets Manager loading, hardened systemd deployment, tests, CI security checks, and open-source documentation.
- Contract tick/step validation, exposure-effect previews, strict Shark response validation, and reconciliation-aware health reporting.
- Verified execution-state semantics for close-all and cancellation postconditions.
- Hybrid Shark Socket.IO and REST operation: live public quotes, authenticated account events, bounded reconnect/event handling, PostgreSQL event idempotency, REST fallback/resynchronization, stream health, and material-change re-confirmation.
- Telegram command menu registration (setMyCommands) on startup, with the command catalog as the single source for both the menu and /help output.
- Documentation restructure: README is now a landing page with a documentation hub; new beginner guide (docs/GETTING_STARTED.md) and full Telegram command reference (docs/COMMANDS.md). Open-source publication prep: `.gitignore` now also excludes `.envrc` (direnv secrets), AI-agent state directories, and the internal planning document SHARK_TELEGRAM_TRADING_BOT_PLAN.md.

### Changed

- `/wallet` (and `/wallet all`) now shows the INR wallet only, since Shark accounts hold INR balances (USDT deposits are unsupported and the endpoint returns HTTP 400). Explicit `/wallet USDT` is still passed through to the exchange.

### Fixed

- `/open_positions`, `/position`, and `/pnl open` now show per-position unrealised P&L estimated from live mark/mid prices (converted into the margin asset via Shark contract rates) when the exchange omits it, clearly labelled "(est.)"; exchange-supplied values are always preferred.
- REST order-book fallback trusted depth row position and picked the worst bid (Shark returns bids ascending by price), corrupting estimated entries/exits in trade and close previews, the seeded stream book, and the unrealised P&L estimate. Best bid/ask are now selected by price regardless of row ordering.
- `/pnl` historical ranges (custom dates, today, all) were computed only from the local ledger, which contains just the history reconciled since the bot first ran, so older realised P&L, fees, and funding were silently missing. `/pnl` now reads the requested range directly from Shark with explicit timestamps and full pagination (shared `src/services/history.ts` readers, also used by reconciliation).
- `/pnl` realised P&L and fees were computed from per-fill trade-history fields, which are incomplete (realised was understated by ~11x against the exchange UI). They are now computed from Shark's transaction-history account postings: REALIZED_PNL for realised, COMMISSION/GST_ON_COMMISSION/CLEARANCE_FEE/GST_ON_CLEARANCE_FEE/FEE_DISCOUNT for fees, FUNDING_FEE/GST_ON_FUNDING_FEE for funding — matching the exchange UI's P&L report. `/pnl` also logs the source-data range, counts, and posting types used for each summary.
