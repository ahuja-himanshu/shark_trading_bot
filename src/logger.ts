import pino, { type Logger } from "pino";
import type { AppConfig } from "./config.js";
import { redact } from "./security/redaction.js";

export function createLogger(
  config: Pick<AppConfig, "logLevel" | "nodeEnv">,
): Logger {
  return pino({
    level: config.logLevel,
    base: {
      service: "shark-telegram-trading-manager",
      environment: config.nodeEnv,
    },
    redact: {
      paths: [
        "apiKey",
        "apiSecret",
        "token",
        "telegramBotToken",
        "sharkApiKey",
        "sharkApiSecret",
        "listenKey",
        "accountId",
        "databaseUrl",
        "headers.api-key",
        "headers.signature",
        "req.headers.authorization",
        "*.apiKey",
        "*.apiSecret",
        "*.token",
        "*.listenKey",
        "*.accountId",
        "*.password",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      error: (error: unknown) =>
        redact(
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
        ),
      err: (error: unknown) =>
        redact(
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
        ),
    },
  });
}
