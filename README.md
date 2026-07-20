# Shark Telegram Trading Manager

A security-first, self-hosted Telegram bot for monitoring and manually trading Shark Exchange perpetual futures — from one authorised private chat.

> [!WARNING]
> This bot can place real leveraged trades with real money. It is not investment advice. Start in read-only mode (`TRADING_ENABLED=false`), validate every report against the Shark UI, use a trade-only API key with withdrawals disabled and an IP allowlist, and enable trading only after completing the [staged rollout](docs/AWS_DEPLOYMENT.md#staged-enablement).

## Overview

The bot turns a private Telegram chat into a control plane for a Shark futures account:

- **Monitor** wallet balances, open positions (with unrealised P&L), open orders, available markets, and full historical P&L that matches the Shark UI.
- **Trade deliberately**: every state-changing command produces an editable, expiring **draft preview** (quantity, price, fees, liquidation estimate, exposure effect) and reaches the exchange only after an explicit one-time confirmation.
- **Stay informed**: a tamper-evident audit chain, health checks, and live stream/reconciliation status are built in.

It supports INR and USDT quote markets, keeps quote currency strictly separate from the margin asset, and defaults new trades to isolated margin.

## Features

- **Preview-before-execute trading** — editable, versioned drafts with single-use confirmations; material price/size changes between preview and confirmation abort the execution instead of placing a stale order.
- **Exchange-truth reporting** — P&L is computed from Shark's transaction-history account postings (the same source as the Shark UI), read live for any date range with Asia/Kolkata day boundaries.
- **Telegram command menu** — commands are registered with Telegram, so clients show a scrollable menu (type `/`) and insert the selected command for parameter entry.
- **Live market data** — Shark Socket.IO streams for quotes and account events, with automatic REST fallback and scheduled reconciliation; per-position unrealised P&L is estimated from live mark/mid prices and clearly labelled when Shark omits it.
- **Defense in depth** — single authorised user/chat, duplicate-update protection, HMAC-signed requests, no withdrawal/transfer endpoints anywhere in the codebase, structured log redaction, PostgreSQL idempotency, and a hash-chained audit log.
- **Read-only by default** — trading must be explicitly enabled via root-owned configuration.

## How it works

```text
Authorised private Telegram chat
        |
        v
Identity gate -> command parser -> preview/draft -> one-time confirmation -> execution
                                       |                                  |
                                 PostgreSQL <-------- Shark Futures API (signed REST)

Public Socket.IO stream -> quote cache (REST fallback)     Authenticated Socket.IO stream -> ledger + reconciliation
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for trust boundaries, components, and the correctness model.

## Getting started

**Prerequisites:** Node.js 22+, PostgreSQL 15+, a Shark API key/secret, a Telegram bot token from [@BotFather](https://t.me/BotFather), and your numeric Telegram user/chat IDs.

```bash
git clone <repo-url> && cd sharkexchange_trading
npm ci
export SHARK_API_KEY=... SHARK_API_SECRET=... TELEGRAM_BOT_TOKEN=... \
       TELEGRAM_ALLOWED_USER_ID=... TELEGRAM_ALLOWED_CHAT_ID=... \
       DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/shark_trading \
       AWS_REGION=ap-south-1
npm run dev
```

Then message your bot `/health` and `/wallet` in Telegram. The full walkthrough — including BotFather setup, database creation, every environment variable, and troubleshooting — is in **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**.

## Documentation

| Document                                          | Contents                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| [Getting Started](docs/GETTING_STARTED.md)        | Beginner A–Z: clone → configure → run → first commands → troubleshooting |
| [Command Reference](docs/COMMANDS.md)             | Every Telegram command with syntax, examples, and the draft/confirm flow |
| [Architecture](ARCHITECTURE.md)                   | Trust boundaries, components, idempotency, stream/REST correctness model |
| [AWS Deployment](docs/AWS_DEPLOYMENT.md)          | Production hardening, staged enablement, backups                         |
| [Operations Runbook](docs/OPERATIONS.md)          | Daily checks, emergency stop, stream degradation, ambiguous executions   |
| [Threat Model](THREAT_MODEL.md)                   | Assets, adversaries, and mitigations                                     |
| [Security Policy](SECURITY.md)                    | Vulnerability reporting and credential-rotation procedure                |
| [Implementation Status](IMPLEMENTATION_STATUS.md) | Live-validation checklist before production trading                      |
| [Changelog](CHANGELOG.md)                         | Notable changes per release                                              |
| [Contributing](CONTRIBUTING.md)                   | Development setup and quality gates                                      |

## Requirements

- Node.js 22+
- PostgreSQL 15+
- A Shark API key and secret (trade-only, withdrawals disabled, IP-allowlisted)
- A Telegram bot token from BotFather, and your numeric user/private-chat IDs
- Outbound TLS access to `api.sharkexchange.in`, `fawss.sharkexchange.in`, and `fawss-uds.sharkexchange.in`
- For production: AWS (Secrets Manager, EC2) per the [deployment guide](docs/AWS_DEPLOYMENT.md)

## Security

Security is the primary design goal of this project: see the [threat model](THREAT_MODEL.md), [security policy](SECURITY.md), and the safety properties enforced throughout the codebase. Report vulnerabilities privately per [SECURITY.md](SECURITY.md) — never open a public issue containing secrets, account identifiers, or logs.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). All changes must pass `npm run check` (format, lint, typecheck, tests).

## License and disclaimer

MIT — see [LICENSE](LICENSE). Operators are responsible for exchange terms, API permissions, legal/regulatory compliance, taxes, infrastructure costs, and all trading decisions. Software defects, network failures, exchange behaviour, liquidation, and credential compromise can cause financial loss. There is no warranty.
