import { describe, expect, it, vi } from "vitest";
import {
  BOT_COMMANDS,
  helpText,
  TELEGRAM_COMMAND_MENU,
} from "../src/commands/catalog.js";
import { TelegramApi } from "../src/telegram/api.js";

describe("command catalog", () => {
  it("covers every command the parser accepts and nothing else", () => {
    const parserCommands = [
      "help",
      "health",
      "wallet",
      "markets",
      "default_market",
      "open_positions",
      "position",
      "open_orders",
      "pnl",
      "audit",
      "trade",
      "close",
      "cancel_orders",
      "sl",
      "tp",
      "edit",
      "cancel",
    ];
    expect(BOT_COMMANDS.map((entry) => entry.command).sort()).toEqual(
      parserCommands.sort(),
    );
  });

  it("satisfies Telegram Bot API command menu constraints", () => {
    expect(TELEGRAM_COMMAND_MENU.length).toBeLessThanOrEqual(100);
    const names = new Set<string>();
    for (const { command, description } of TELEGRAM_COMMAND_MENU) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThanOrEqual(1);
      expect(description.length).toBeLessThanOrEqual(256);
      expect(names.has(command)).toBe(false);
      names.add(command);
    }
  });

  it("builds help text from the same catalog as the menu", () => {
    const help = helpText();
    for (const entry of BOT_COMMANDS) {
      expect(help).toContain(entry.usage);
      expect(entry.usage.split(/\s+/)[0]).toBe(`/${entry.command}`);
    }
  });
});

describe("TelegramApi.setMyCommands", () => {
  it("posts the command menu to Telegram", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      );
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request body");
      calls.push({
        method: url.pathname.split("/").at(-1) ?? "",
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        }),
      );
    });
    const telegram = new TelegramApi("12345678:test-token-value", fetchFn);
    await expect(telegram.setMyCommands(TELEGRAM_COMMAND_MENU)).resolves.toBe(
      true,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("setMyCommands");
    expect(calls[0]?.body).toEqual({ commands: TELEGRAM_COMMAND_MENU });
  });
});
