import { describe, expect, it } from "vitest";
import { authorizeTelegramIdentity } from "../src/security/authorization.js";
import { redact, redactText } from "../src/security/redaction.js";
import {
  hmacSha256,
  safeEqual,
  sha256,
  stableJson,
} from "../src/security/crypto.js";

describe("Telegram authorization", () => {
  const config = { allowedUserId: "123", allowedChatId: "123" };

  it("allows only the configured private user/chat", () => {
    expect(
      authorizeTelegramIdentity(
        {
          userId: "123",
          chatId: "123",
          chatType: "private",
          isForwarded: false,
        },
        config,
      ),
    ).toEqual({ allowed: true });
  });

  it.each([
    [
      { userId: "999", chatId: "123", chatType: "private", isForwarded: false },
      "UNAUTHORISED_USER",
    ],
    [
      { userId: "123", chatId: "123", chatType: "group", isForwarded: false },
      "NON_PRIVATE_CHAT",
    ],
    [
      { userId: "123", chatId: "123", chatType: "private", isForwarded: true },
      "FORWARDED_MESSAGE",
    ],
  ] as const)("rejects invalid identity", (identity, reason) => {
    expect(authorizeTelegramIdentity(identity, config)).toEqual({
      allowed: false,
      reason,
    });
  });
});

describe("redaction", () => {
  it("redacts sensitive object keys recursively", () => {
    expect(
      redact({
        nested: { apiKey: "real-key", value: "safe" },
        signature: "sig",
      }),
    ).toEqual({
      nested: { apiKey: "[REDACTED]", value: "safe" },
      signature: "[REDACTED]",
    });
  });

  it("redacts Telegram tokens and database URLs in text", () => {
    const text =
      "token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi db postgresql://u:p@host/db";
    expect(redactText(text)).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(redactText(text)).not.toContain("u:p@host");
  });

  it("redacts listen keys, account identifiers, and authenticated stream paths", () => {
    const listenKey = "abcDEF_12345678901234567890";
    expect(
      redact({ listenKey, nested: { accountId: "private-account" } }),
    ).toEqual({
      listenKey: "[REDACTED]",
      nested: { accountId: "[REDACTED]" },
    });
    expect(
      redactText(
        `connection https://fawss-uds.sharkexchange.in/auth-stream/${listenKey}`,
      ),
    ).not.toContain(listenKey);
  });
});

describe("security crypto helpers", () => {
  it("creates deterministic hashes and canonical JSON", () => {
    expect(stableJson({ z: 1, a: [2, { b: true, a: null }] })).toBe(
      '{"a":[2,{"a":null,"b":true}],"z":1}',
    );
    expect(sha256("value")).toHaveLength(64);
    expect(hmacSha256("secret", "value")).toHaveLength(64);
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("short", "longer")).toBe(false);
  });
});
