# AWS deployment

## Target posture

- EC2 in a private subnet with no inbound application or SSH port.
- Administration through AWS Systems Manager Session Manager.
- Encrypted EBS and private PostgreSQL/RDS with TLS and automated backups.
- Runtime secret in AWS Secrets Manager encrypted by a customer-managed KMS key.
- EC2 role limited to `GetSecretValue` for that one secret and `kms:Decrypt` through Secrets Manager for that key.
- Outbound TLS only to Telegram, Shark REST (`api.sharkexchange.in`), Shark public Socket.IO (`fawss.sharkexchange.in`), Shark authenticated Socket.IO (`fawss-uds.sharkexchange.in`), Secrets Manager/KMS/SSM/CloudWatch endpoints, plus DNS and NTP. Use VPC endpoints where practical.
- NAT gateways, firewalls, and proxies must permit long-lived outbound WebSocket upgrades and Socket.IO heartbeat traffic. Do not place listen keys in proxy access logs.

## Runtime secret

Create one JSON SecretString containing:

```json
{
  "SHARK_API_KEY": "set-in-secrets-manager",
  "SHARK_API_SECRET": "set-in-secrets-manager",
  "TELEGRAM_BOT_TOKEN": "set-in-secrets-manager",
  "TELEGRAM_ALLOWED_USER_ID": "set-in-secrets-manager",
  "TELEGRAM_ALLOWED_CHAT_ID": "set-in-secrets-manager",
  "DATABASE_URL": "postgresql://user:password@private-db:5432/shark_trading?sslmode=require"
}
```

Never paste real values into a repository file, launch template, user data, AMI, issue, or CI variable. Attach a policy based on `deploy/ec2-secrets-policy.json` after replacing both resource placeholders. Add the AWS-managed SSM core policy separately for Session Manager.

## Install

On the instance, through SSM:

1. Install Node.js 22 from a trusted signed distribution and PostgreSQL client tools.
2. Create a locked service account: `useradd --system --home /nonexistent --shell /usr/sbin/nologin sharkbot`.
3. Place a reviewed release in `/opt/sharkbot/current`, owned by root and readable by `sharkbot`.
4. Run `npm ci --omit=dev --ignore-scripts` and `npm run build` in a controlled build environment; preferably copy the reviewed build artifact and matching lockfile to EC2 instead of compiling on the host.
5. Create `/etc/sharkbot/runtime.env` from `deploy/runtime.env.example`, replace only the secret identifier, set mode `0600`, owner `root:root`, and leave `TRADING_ENABLED=false`.
6. Install `deploy/shark-telegram.service` at `/etc/systemd/system/shark-telegram.service`.
7. Run `systemctl daemon-reload`, `systemctl enable shark-telegram`, and `systemctl start shark-telegram`.
8. Verify `systemctl status shark-telegram` and redacted logs in `journalctl -u shark-telegram`.

The service automatically applies all numbered idempotent database migrations at startup, including the account-stream event-idempotency table. The database user needs schema privileges during deployment. A later hardening phase should separate migration credentials from runtime DML credentials.

## Staged enablement

1. Keep read-only mode and compare `/wallet`, `/open_positions`, `/open_orders`, and P&L with the Shark UI. Confirm `/health` shows both Socket.IO streams and recent REST reconciliation.
2. Disconnect outbound access to each stream in turn. Verify reconnect/backoff, stale detection, REST quote fallback, authenticated-stream resynchronization, and continued Telegram availability without process failure.
3. Confirm the Shark key cannot withdraw/transfer and rehearse credential rotation.
4. Enable trading only by changing `TRADING_ENABLED=true` in the root-owned runtime environment and restarting the service.
5. Test the smallest valid limit order, cancellation, market entry, individual close, and only then `/close all`. Change market price or account state between preview and confirmation and prove a refreshed draft is required.
6. If an execution result is `UNKNOWN`, do not repeat it. Inspect Shark positions/orders directly.

## Backup and recovery

- Encrypt automated database backups and retain them under a documented policy.
- Test restoring into an isolated database quarterly.
- Database backup contains sensitive trading history and Telegram identifiers; restrict it like production data.
- Preserve `trade_drafts`, `draft_confirmations`, `execution_attempts`, `account_stream_events`, `audit_events`, and ledger tables across service restarts.
