# Getting Started

A complete, beginner-friendly walkthrough: from an empty machine to a running bot answering `/health` in Telegram. Read-only mode the whole way — enabling real trading is a deliberate later step, covered at the end.

Estimated time: 30–45 minutes.

## What you need

| Thing                      | Why                                                | Where to get it                                     |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Node.js 22+                | Runs the bot                                       | <https://nodejs.org>                                |
| PostgreSQL 15+             | Stores drafts, audit events, and the P&L ledger    | `brew install postgresql@15` / your package manager |
| A Telegram account         | You will talk to your bot from it                  | <https://telegram.org>                              |
| A Shark Exchange account   | The account the bot monitors (and later trades)    | <https://sharkexchange.in>                          |
| A machine with a stable IP | Shark API keys can be IP-allowlisted (recommended) | A VPS, or your home connection (see note below)     |

> [!NOTE]
> Shark lets you restrict an API key to specific IP addresses — do it. If your ISP gives you a dynamic IP (most home connections), your IP will change periodically and signed requests will start failing with `HTTP_403`. For anything beyond local testing, run the bot on a small VPS with a fixed IP and allowlist that once. See the [troubleshooting](#troubleshooting) section.

## Step 1 — Clone and install

```bash
git clone <repo-url>
cd sharkexchange_trading
npm ci
```

## Step 2 — Create the Telegram bot and find your IDs

1. In Telegram, open a chat with **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot`, pick a name and a username (must end in `bot`, e.g. `my_shark_manager_bot`).
3. BotFather replies with your **bot token** (`123456789:AAE...`). Keep it secret — anyone with it controls the bot.
4. To get your **user ID**, message **[@userinfobot](https://t.me/userinfobot)** — it replies with your numeric ID.
5. Start a chat with your new bot and send it anything (e.g. `hi`). Your **chat ID** for a private chat is the same number as your user ID.

The bot accepts commands from exactly this one user ID in this one chat and rejects everyone else, including groups and forwarded messages.

## Step 3 — Create the Shark API key

1. In the Shark Exchange web UI, open **API Management** and create a key.
2. Grant **read** and **trade** permissions only. Do **not** enable withdrawals or transfers — the bot never uses them, and a leaked key then cannot move your funds.
3. Restrict the key to your current public IP address (check it with `curl ifconfig.me`).
4. Save the **API key** and **API secret** somewhere safe; the secret is shown once.

## Step 4 — Create the database

```bash
# macOS (Homebrew) — start the server first if needed
brew services start postgresql@15

createdb shark_trading
```

Any PostgreSQL 15+ works, local or hosted. Note the connection URL for the next step.

## Step 5 — Configure the environment

The bot **deliberately does not load `.env` files** — credentials belong in your shell environment (development) or AWS Secrets Manager (production), never in the repository.

Export these variables (add them to `~/.zshrc` or a local secret manager so they survive reboots):

```bash
# Required — secrets
export SHARK_API_KEY="your-shark-api-key"
export SHARK_API_SECRET="your-shark-api-secret"
export TELEGRAM_BOT_TOKEN="123456789:AAE-your-bot-token"
export TELEGRAM_ALLOWED_USER_ID="your-numeric-telegram-user-id"
export TELEGRAM_ALLOWED_CHAT_ID="your-numeric-telegram-chat-id"
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/shark_trading"

# Required but non-secret
export AWS_REGION="ap-south-1"          # needed even in development

# Optional — sane defaults exist; see .env.example for the full list
export NODE_ENV=development
export LOG_LEVEL=info
export TRADING_ENABLED=false            # keep false for now
```

All tunables (stream timeouts, draft TTL, reconciliation interval, …) are documented in [.env.example](../.env.example); the defaults are production-reasonable.

## Step 6 — Run it

```bash
npm run check   # one-time sanity: format, lint, types, tests
npm run dev     # starts the bot with auto-reload (development)
```

Database migrations apply automatically at startup. You should see logs like:

```json
{"level":30,"stream":"public_market","msg":"WebSocket connected"}
{"level":30,"tradingEnabled":false,"msg":"Shark Telegram Trading Manager started"}
```

For a long-lived install use `npm run build && npm start`, and for production follow [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md).

## Step 7 — Verify in Telegram

Open the private chat with your bot and send:

1. `/health` — expect `Service running`, `Mode: READ ONLY`, stream states `HEALTHY`, and a recent reconciliation.
2. `/wallet` — your INR futures balance (Shark accounts hold INR only; USDT deposits are not supported).
3. `/open_positions` — your positions with unrealised P&L (labelled `(est.)` when the bot computes it from live prices because Shark doesn't supply it).
4. `/pnl today` — today's realised P&L, fees, and funding, matching the Shark UI.

Type `/` in the message box — Telegram shows the bot's registered command menu with descriptions; tapping a command inserts it so you can fill in parameters.

The full command list with examples is in [COMMANDS.md](COMMANDS.md).

## Step 8 — Enable trading (only when you're ready)

Trading stays off until you deliberately turn it on. Before doing so:

1. Run in read-only mode for a few days; compare `/wallet`, `/open_positions`, and `/pnl` against the Shark UI.
2. Complete the live-validation checklist in [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md).
3. Rehearse the staged enablement in [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md#staged-enablement) — smallest possible limit order first, then cancels, market entry, individual close, and only then `/close all`.
4. Set `TRADING_ENABLED=true` and restart. Every trade still requires a draft preview and an explicit one-time confirmation — the bot never fires an order directly from a command.

## Troubleshooting

| Symptom                                                         | Likely cause and fix                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERROR HTTP_403` on every command, streams connect fine         | Your public IP changed or isn't allowlisted on the Shark key. Check `curl ifconfig.me`, update the key's IP allowlist, restart the bot.                                               |
| `Account reconciliation failed` with `HTTP_400` once at startup | Transient at process start; later runs succeed. If it repeats, the log now includes Shark's error message — check host clock sync first.                                              |
| `ERROR HTTP_400` from `/wallet USDT`                            | Shark doesn't support USDT balances. Use `/wallet` (INR only).                                                                                                                        |
| Bot is silent in Telegram                                       | Wrong `TELEGRAM_ALLOWED_USER_ID`/`CHAT_ID` (bot rejects everyone else silently), or the process isn't running. Check logs for "Rejected Telegram update".                             |
| `/open_positions` P&L differs from Shark UI                     | The bot shows a mark/mid-price **estimate** (labelled `(est.)`); the UI uses its own mark. Small differences are normal.                                                              |
| `/pnl` differs from Shark UI                                    | Should not happen — the bot reads the same account postings as the UI. Verify the date range (bot uses Asia/Kolkata day boundaries) and that reconciliation is healthy via `/health`. |
| WebSocket never connects                                        | Firewall/VPN/proxy blocking long-lived Socket.IO connections to `fawss.sharkexchange.in` / `fawss-uds.sharkexchange.in`. The bot still works via REST fallback.                       |
| `Missing required configuration: ...` at startup                | An env var from Step 5 isn't exported in the shell you launched from. `echo $NAME` to check.                                                                                          |

## Where next

- [COMMANDS.md](COMMANDS.md) — full command reference
- [ARCHITECTURE.md](../ARCHITECTURE.md) — how the bot works inside
- [OPERATIONS.md](OPERATIONS.md) — run it like a service: daily checks, emergency stop
- [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md) — production deployment with Secrets Manager and a fixed IP
