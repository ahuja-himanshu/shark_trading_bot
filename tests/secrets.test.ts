import { describe, expect, it } from "vitest";
import { mergeRuntimeSecret } from "../src/secrets.js";

const completeSecret = {
  SHARK_API_KEY: "secret-manager-key",
  SHARK_API_SECRET: "secret-manager-secret",
  TELEGRAM_BOT_TOKEN: "123456789:secret-manager-token",
  TELEGRAM_ALLOWED_USER_ID: "123",
  TELEGRAM_ALLOWED_CHAT_ID: "123",
  DATABASE_URL: "postgresql://db/app?sslmode=require",
};

describe("Secrets Manager environment boundary", () => {
  it("uses Secrets Manager as the exclusive source of sensitive fields", () => {
    const result = mergeRuntimeSecret(
      {
        NODE_ENV: "production",
        TRADING_ENABLED: "false",
        SHARK_API_KEY: "unsafe-process-value",
        DATABASE_URL: "postgresql://unsafe/process",
      },
      { ...completeSecret, UNRECOGNISED_VALUE: "ignored" },
    );

    expect(result.SHARK_API_KEY).toBe("secret-manager-key");
    expect(result.DATABASE_URL).toBe(completeSecret.DATABASE_URL);
    expect(result.TRADING_ENABLED).toBe("false");
    expect(result.UNRECOGNISED_VALUE).toBeUndefined();
  });

  it.each(["SHARK_API_KEY", "TELEGRAM_ALLOWED_CHAT_ID", "DATABASE_URL"])(
    "fails closed when %s is missing or blank",
    (key) => {
      const secret: Record<string, string | undefined> = {
        ...completeSecret,
      };
      secret[key] = "";
      expect(() => mergeRuntimeSecret({}, secret)).toThrow(
        `Secrets Manager field ${key}`,
      );
    },
  );

  it("rejects a non-object secret value", () => {
    expect(() => mergeRuntimeSecret({}, [])).toThrow("JSON object");
  });
});
