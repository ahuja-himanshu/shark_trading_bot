# Threat model

## Assets

- Shark API key and secret
- Telegram bot token and authorised numeric IDs
- Trading authority and open-position control
- Account balances, orders, P&L, audit records, and strategy-sensitive activity
- PostgreSQL credentials and AWS runtime identity
- Authenticated stream listen keys and private account-event metadata

## Adversaries

- Internet attacker discovering the bot
- Telegram account/session thief
- Malicious group/channel participant or forwarded-message sender
- Dependency or CI supply-chain attacker
- Contributor attempting to exfiltrate secrets through logs, tests, or workflow changes
- Attacker with limited EC2 access
- Exchange/API impersonator or compromised network path
- Accidental operator input, duplicate Telegram delivery, stale callback, or retry after timeout

## Required mitigations

| Threat                         | Mitigation                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unknown Telegram user          | Constant-time comparison of configured user/chat IDs; private chat only; groups/channels/forwarded messages rejected before parsing.                   |
| Stolen callback/replay         | Random token stored only as SHA-256; user/chat/draft-version/payload binding; short expiry; atomic one-time consumption.                               |
| Accidental wrong size          | Explicit margin currency and leverage grammar; editable preview; notional, quantity, market, margin asset, fee, and liquidation estimate displayed.    |
| Stale edited preview           | Editing increments the draft version and expires every previous confirmation.                                                                          |
| Duplicate trade                | Unique Telegram update ID and execution constraint; confirmation claim transaction.                                                                    |
| Timeout after order submission | Mark `UNKNOWN`, alert operator, never automatically retry.                                                                                             |
| Stale or spoofed market feed   | TLS-only Socket.IO; strict message validation and size limits; quote-age and sequence checks; REST fallback; REST-only confirmation recalculation.     |
| Stream gap or disconnect       | Bounded jittered reconnect; heartbeat/stale detection; re-subscription; authenticated reconnect triggers REST resynchronization.                       |
| Stream replay/out-of-order     | Payload hash and event key persisted without raw payload; per-entity event-time ordering; idempotent ledger writes and scheduled REST repair.          |
| Stream memory exhaustion       | Fixed maximum private-event queue, message-size cap, subscription cap/leases, drop-and-resynchronize behavior.                                         |
| Listen-key disclosure          | Memory only; never in database, logs, Telegram, health output, test fixtures, or captured production payloads; renew before expiry and delete on stop. |
| Close reverses exposure        | Re-fetch position; submit opposite side with live quantity, `POSITION` placement, and `reduceOnly=true`; verify response when supplied.                |
| Secret committed to Git        | Comprehensive ignore rules, fake-only sample config, pre-commit gitleaks, CI gitleaks, protected branch, rotation procedure.                           |
| Secret in logs/errors          | Pino path redaction, text-pattern redaction, no request headers/bodies logged, sanitised Telegram/network errors.                                      |
| CI fork steals credentials     | No production secrets in GitHub; read-only workflow permissions; no deploy credentials exposed to pull-request jobs.                                   |
| Dependency compromise          | Exact dependency lockfile, immutable action SHAs, Dependabot, npm audit, CodeQL, release SBOM.                                                         |
| Host compromise                | SSM rather than SSH, unprivileged systemd user, hardened unit, encrypted volumes, least-privileged IAM, private PostgreSQL.                            |
| Fund theft                     | No withdrawal/transfer/address code paths; require exchange-side trade-only key with fund movement disabled.                                           |

## Residual risks

- Telegram bot chats are not end-to-end encrypted. A Telegram/platform compromise or stolen authorised session can expose reports and issue commands.
- A trade-capable API key can lose funds through leveraged trades even when withdrawal is disabled.
- Shark API documentation/examples may differ from production behaviour. Low-value staged validation is mandatory.
- Socket.IO event payloads can be partial or change without notice. Strict parsing may reject an event; periodic REST reconciliation remains the correctness source.
- The preview liquidation value is an estimate unless Shark supplies a pre-trade calculation; exchange liquidation rules prevail.
- `/close all` uses the exchange endpoint and depends on its live semantics. Rehearse it before enabling production trading.
- Manual risk control means the application does not enforce leverage, order-size, exposure, or daily-loss limits.

## Security invariants

1. No mutating Shark request before an authorised, current, unexpired draft is atomically confirmed.
2. No automatic retry of an ambiguous mutating request.
3. No fund-movement endpoints in the exchange port/client.
4. No production secret in source, tests, fixtures, logs, Telegram output, release artifacts, or database fields.
5. Read-only mode is the default for every clean deployment.
6. No WebSocket event can directly place, edit, cancel, or close an order or position.
7. A WebSocket quote never replaces REST confirmation-time wallet, contract, and position validation.
