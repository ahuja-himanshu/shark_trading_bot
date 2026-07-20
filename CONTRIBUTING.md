# Contributing

## Development workflow

1. Open an issue describing the behaviour and security impact.
2. Branch from the latest default branch.
3. Install exact dependencies with `npm ci`.
4. Add or update tests, including failure and authorisation paths.
5. Run `npm run check` and `npm run build`.
6. Run `gitleaks git --config .gitleaks.toml --redact` before committing.
7. Open a pull request. Do not include real exchange responses, IDs, logs, balances, screenshots, credentials, or production infrastructure values.
8. Do not commit captured public/private stream payloads. Build synthetic fixtures containing no real account identifiers, listen keys, orders, balances, or timestamps tied to an operator.

## Design rules

- Keep fund movement out of scope.
- All state-changing commands require a draft and confirmation.
- Preserve fail-closed behaviour and idempotency.
- Treat all API data as untrusted and all monetary values as decimal strings.
- Add exchange endpoints only to the narrow exchange port/client.
- Keep Socket.IO protocol details inside `src/streams`; Telegram and trading services must depend only on narrow interfaces.
- Keep WebSocket event handlers observational. They may update the ledger or request REST reconciliation but must never execute a trade.
- Update the threat model when a change creates a new trust boundary or authority.

By contributing, you agree that your contribution is licensed under the MIT License.
