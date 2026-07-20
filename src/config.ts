import { URL } from "node:url";

export type NodeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  logLevel: string;
  sharkApiBaseUrl: string;
  sharkPublicStreamUrl: string;
  sharkAccountStreamUrl: string;
  sharkApiKey: string;
  sharkApiSecret: string;
  telegramBotToken: string;
  telegramAllowedUserId: string;
  telegramAllowedChatId: string;
  databaseUrl: string;
  awsRegion: string;
  tradingEnabled: boolean;
  draftTtlSeconds: number;
  reconciliationIntervalSeconds: number;
  marketQuoteMaxAgeMs: number;
  marketSubscriptionLeaseSeconds: number;
  websocketStaleAfterSeconds: number;
  websocketMaxMessageBytes: number;
  sharkListenKeyRenewalSeconds: number;
  confirmationMaterialChangeBps: number;
}

const PLACEHOLDER_PATTERNS = [
  /^your[-_]/i,
  /^change[-_]?me$/i,
  /^placeholder$/i,
  /^example$/i,
  /^xxx+$/i,
];

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required configuration: ${key}`);
  }
  return value;
}

function parsePositiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${key} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function parseIntegerRange(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = parsePositiveInteger(env, key, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("TRADING_ENABLED must be exactly true or false");
}

function assertHttpsUrl(raw: string, key: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`${key} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${key} must not contain credentials, query parameters, or fragments`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function assertDatabaseUrl(raw: string, production: boolean): string {
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use postgresql:// or postgres://");
  }
  if (
    production &&
    !["require", "verify-ca", "verify-full"].includes(
      url.searchParams.get("sslmode") ?? "",
    )
  ) {
    throw new Error(
      "Production DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full",
    );
  }
  return raw;
}

function assertTelegramId(value: string, key: string): string {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${key} must be a numeric Telegram ID`);
  }
  return value;
}

function assertNotPlaceholder(value: string, key: string): void {
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${key} contains a placeholder value`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnvRaw = env.NODE_ENV?.trim() || "development";
  if (!["development", "test", "production"].includes(nodeEnvRaw)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  const nodeEnv = nodeEnvRaw as NodeEnvironment;

  const config: AppConfig = {
    nodeEnv,
    logLevel: env.LOG_LEVEL?.trim() || "info",
    sharkApiBaseUrl: assertHttpsUrl(
      env.SHARK_API_BASE_URL?.trim() || "https://api.sharkexchange.in",
      "SHARK_API_BASE_URL",
    ),
    sharkPublicStreamUrl: assertHttpsUrl(
      env.SHARK_PUBLIC_STREAM_URL?.trim() || "https://fawss.sharkexchange.in",
      "SHARK_PUBLIC_STREAM_URL",
    ),
    sharkAccountStreamUrl: assertHttpsUrl(
      env.SHARK_ACCOUNT_STREAM_URL?.trim() ||
        "https://fawss-uds.sharkexchange.in/auth-stream",
      "SHARK_ACCOUNT_STREAM_URL",
    ),
    sharkApiKey: requireString(env, "SHARK_API_KEY"),
    sharkApiSecret: requireString(env, "SHARK_API_SECRET"),
    telegramBotToken: requireString(env, "TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserId: assertTelegramId(
      requireString(env, "TELEGRAM_ALLOWED_USER_ID"),
      "TELEGRAM_ALLOWED_USER_ID",
    ),
    telegramAllowedChatId: assertTelegramId(
      requireString(env, "TELEGRAM_ALLOWED_CHAT_ID"),
      "TELEGRAM_ALLOWED_CHAT_ID",
    ),
    databaseUrl: assertDatabaseUrl(
      requireString(env, "DATABASE_URL"),
      nodeEnv === "production",
    ),
    awsRegion: requireString(env, "AWS_REGION"),
    tradingEnabled: parseBoolean(env.TRADING_ENABLED, false),
    draftTtlSeconds: parsePositiveInteger(env, "DRAFT_TTL_SECONDS", 120),
    reconciliationIntervalSeconds: parsePositiveInteger(
      env,
      "RECONCILIATION_INTERVAL_SECONDS",
      60,
    ),
    marketQuoteMaxAgeMs: parseIntegerRange(
      env,
      "MARKET_QUOTE_MAX_AGE_MS",
      5_000,
      250,
      60_000,
    ),
    marketSubscriptionLeaseSeconds: parseIntegerRange(
      env,
      "MARKET_SUBSCRIPTION_LEASE_SECONDS",
      900,
      30,
      86_400,
    ),
    websocketStaleAfterSeconds: parseIntegerRange(
      env,
      "WEBSOCKET_STALE_AFTER_SECONDS",
      300,
      30,
      600,
    ),
    websocketMaxMessageBytes: parseIntegerRange(
      env,
      "WEBSOCKET_MAX_MESSAGE_BYTES",
      262_144,
      1_024,
      1_048_576,
    ),
    sharkListenKeyRenewalSeconds: parseIntegerRange(
      env,
      "SHARK_LISTEN_KEY_RENEWAL_SECONDS",
      2_700,
      300,
      3_540,
    ),
    confirmationMaterialChangeBps: parseIntegerRange(
      env,
      "CONFIRMATION_MATERIAL_CHANGE_BPS",
      25,
      1,
      1_000,
    ),
  };

  if (nodeEnv === "production") {
    for (const [key, value] of [
      ["SHARK_API_KEY", config.sharkApiKey],
      ["SHARK_API_SECRET", config.sharkApiSecret],
      ["TELEGRAM_BOT_TOKEN", config.telegramBotToken],
    ] as const) {
      assertNotPlaceholder(value, key);
    }
  }

  return Object.freeze(config);
}
