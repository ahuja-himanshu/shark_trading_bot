import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  NODE_ENV: "test",
  SHARK_API_KEY: "test-key",
  SHARK_API_SECRET: "test-secret",
  TELEGRAM_BOT_TOKEN: "12345678:test-token-value",
  TELEGRAM_ALLOWED_USER_ID: "123",
  TELEGRAM_ALLOWED_CHAT_ID: "123",
  DATABASE_URL: "postgresql://localhost/test",
  AWS_REGION: "ap-south-1",
};

describe("configuration", () => {
  it("starts read-only unless explicitly enabled", () => {
    expect(loadConfig(valid).tradingEnabled).toBe(false);
    expect(loadConfig(valid)).toMatchObject({
      sharkPublicStreamUrl: "https://fawss.sharkexchange.in",
      sharkAccountStreamUrl: "https://fawss-uds.sharkexchange.in/auth-stream",
      marketQuoteMaxAgeMs: 5_000,
      websocketStaleAfterSeconds: 300,
      sharkListenKeyRenewalSeconds: 2_700,
    });
  });

  it("requires exact boolean values", () => {
    expect(() => loadConfig({ ...valid, TRADING_ENABLED: "yes" })).toThrow(
      "exactly true or false",
    );
  });

  it("rejects placeholders in production", () => {
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: "production",
        SHARK_API_SECRET: "changeme",
        DATABASE_URL: "postgresql://localhost/test?sslmode=require",
      }),
    ).toThrow("placeholder");
  });

  it("requires HTTPS for the exchange", () => {
    expect(() =>
      loadConfig({ ...valid, SHARK_API_BASE_URL: "http://example.com" }),
    ).toThrow("HTTPS");
  });

  it("requires TLS for PostgreSQL in production", () => {
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: "production",
        SHARK_API_KEY: "live-key-value",
        SHARK_API_SECRET: "live-secret-value",
        TELEGRAM_BOT_TOKEN: "123456789:live-token-value",
      }),
    ).toThrow("sslmode");
    expect(
      loadConfig({
        ...valid,
        NODE_ENV: "production",
        SHARK_API_KEY: "live-key-value",
        SHARK_API_SECRET: "live-secret-value",
        TELEGRAM_BOT_TOKEN: "123456789:live-token-value",
        DATABASE_URL: "postgresql://localhost/test?sslmode=require",
      }).databaseUrl,
    ).toContain("sslmode=require");
  });

  it.each([
    ["TELEGRAM_ALLOWED_USER_ID", "not-a-number"],
    ["DRAFT_TTL_SECONDS", "0"],
    ["RECONCILIATION_INTERVAL_SECONDS", "one"],
    ["NODE_ENV", "staging"],
    ["MARKET_QUOTE_MAX_AGE_MS", "100"],
    ["SHARK_LISTEN_KEY_RENEWAL_SECONDS", "3600"],
    ["WEBSOCKET_MAX_MESSAGE_BYTES", "9999999"],
    ["WEBSOCKET_STALE_AFTER_SECONDS", "5"],
  ])("rejects invalid %s", (key, value) => {
    expect(() => loadConfig({ ...valid, [key]: value })).toThrow();
  });

  it("requires credential-free HTTPS stream URLs", () => {
    expect(() =>
      loadConfig({
        ...valid,
        SHARK_PUBLIC_STREAM_URL: "http://fawss.example.com",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      loadConfig({
        ...valid,
        SHARK_ACCOUNT_STREAM_URL:
          "https://user:secret@fawss.example.com/auth-stream?key=secret",
      }),
    ).toThrow("must not contain credentials");
  });

  it("accepts explicit trading enablement", () => {
    expect(
      loadConfig({ ...valid, TRADING_ENABLED: "true" }).tradingEnabled,
    ).toBe(true);
  });
});
