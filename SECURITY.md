# Security policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities or exposed credentials. Use GitHub's private vulnerability reporting feature for this repository. Until the public repository enables that feature, contact the repository owner privately through their verified GitHub profile.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not access accounts, place trades, or retain data that is not yours.

## Supported versions

Security fixes are provided for the latest released version. Until version `1.0.0`, use the latest commit from the protected default branch only after reviewing release notes.

## Operator incident response

If a credential may be exposed:

1. Set `TRADING_ENABLED=false` and stop the service.
2. Disable the Shark API key from a trusted device. Verify positions and open orders directly in Shark.
3. Revoke the Telegram bot token through BotFather and issue a new one.
4. Rotate PostgreSQL credentials and affected AWS Secrets Manager values/KMS permissions.
5. Revoke suspicious Telegram sessions and enable Telegram two-step verification.
6. Preserve CloudWatch, database audit, and system logs; do not paste them into public issues.
7. Review Git history and CI artifacts. If a real secret entered Git, rotating it is mandatory; deleting the current file is not sufficient.
8. Rebuild and deploy from a reviewed clean commit.

## Production requirements

- Verify Shark provides a trading-only API key with withdrawals/transfers disabled. If it does not, live enablement requires explicit acceptance of that residual risk.
- Use AWS Secrets Manager and an instance role. Never store long-lived AWS credentials on the VM.
- Protect the default branch and require CI, CodeQL, and secret scanning.
- Keep Telegram user/chat IDs private even though they are not authentication secrets by themselves.
- Do not send real secrets, wallet addresses, or complete account identifiers through Telegram.
- Treat authenticated Socket.IO listen keys and URLs as short-lived credentials. Keep them only in memory; never persist, log, trace, capture, or paste them into an issue.
- Permit only outbound TLS to the documented Shark REST and Socket.IO hosts. Preserve certificate verification and avoid TLS-intercepting proxies for production trading.
