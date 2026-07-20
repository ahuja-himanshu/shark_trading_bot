import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { DraftService } from "../src/services/drafts.js";
import { ExecutionService } from "../src/services/execution.js";
import { PnlService } from "../src/services/pnl.js";
import { PreviewService } from "../src/services/preview.js";
import { UnrealisedPnlEstimator } from "../src/services/unrealised-pnl.js";
import { TelegramApi } from "../src/telegram/api.js";
import { TelegramController } from "../src/telegram/controller.js";
import type { TelegramUpdate } from "../src/telegram/types.js";
import type { RuntimeHealthProvider } from "../src/streams/health.js";
import {
  FakeExchange,
  openPosition,
  openPositionWithoutUnrealisedPnl,
} from "./helpers/fake-exchange.js";

function createHarness(
  tradingEnabled = true,
  runtimeHealth?: RuntimeHealthProvider,
  withPnlEstimator = false,
) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    );
    const method = url.pathname.split("/").at(-1) ?? "";
    if (typeof init?.body !== "string")
      throw new Error("Expected JSON request body");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body });
    const result =
      method === "sendMessage"
        ? {
            message_id: calls.length,
            chat: { id: 123, type: "private" },
            text: body.text,
          }
        : true;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result }), { status: 200 }),
    );
  });
  const telegram = new TelegramApi("12345678:test-token-value", fetchFn);
  const store = new MemoryStore();
  const exchange = new FakeExchange();
  const preview = new PreviewService(exchange);
  const drafts = new DraftService(store, preview, 120);
  const execution = new ExecutionService(store, exchange, tradingEnabled);
  const pnl = new PnlService(exchange);
  const controller = new TelegramController(
    telegram,
    exchange,
    store,
    drafts,
    execution,
    pnl,
    pino({ level: "silent" }),
    {
      allowedUserId: "123",
      allowedChatId: "123",
      tradingEnabled,
    },
    runtimeHealth,
    withPnlEstimator
      ? new UnrealisedPnlEstimator(exchange, exchange)
      : undefined,
  );
  return { calls, controller, exchange, store };
}

function messageUpdate(
  updateId: number,
  text: string,
  userId = 123,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false },
      chat: { id: 123, type: "private" },
      text,
    },
  };
}

describe("Telegram controller", () => {
  it("rejects an unknown user before parsing or reading exchange data", async () => {
    const harness = createHarness();
    await harness.controller.handle(messageUpdate(1, "/open_positions", 999));
    expect(harness.calls).toHaveLength(0);
    expect(harness.exchange.placed).toHaveLength(0);
  });

  it("deduplicates Telegram updates and creates an editable unexecuted trade draft", async () => {
    const harness = createHarness();
    const update = messageUpdate(
      2,
      "/trade BTCUSDT long market margin 100 USDT leverage 10",
    );
    await harness.controller.handle(update);
    await harness.controller.handle(update);
    const sends = harness.calls.filter((call) => call.method === "sendMessage");
    expect(sends).toHaveLength(2);
    expect(String(sends[0]?.body.text)).toContain("NOT EXECUTED");
    expect(harness.exchange.placed).toHaveLength(0);
  });

  it("executes exactly once through the confirmation callback", async () => {
    const harness = createHarness();
    await harness.controller.handle(
      messageUpdate(
        3,
        "/trade BTCUSDT long market margin 100 USDT leverage 10",
      ),
    );
    const markup = harness.calls[0]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const confirmationData = markup.inline_keyboard[0]?.[0]?.callback_data;
    expect(confirmationData).toMatch(/^c:/);
    if (!confirmationData)
      throw new Error("Confirmation callback was not generated");
    const callback: TelegramUpdate = {
      update_id: 4,
      callback_query: {
        id: "callback-1",
        from: { id: 123, is_bot: false },
        message: {
          message_id: 1,
          chat: { id: 123, type: "private" },
        },
        data: confirmationData,
      },
    };
    await harness.controller.handle(callback);
    await harness.controller.handle(callback);
    expect(harness.exchange.placed).toHaveLength(1);
    expect(
      harness.calls.some((call) =>
        String(call.body.text).includes("SUBMITTED"),
      ),
    ).toBe(true);
  });

  it.each([
    "/help",
    "/health",
    "/wallet USDT",
    "/markets BTC",
    "/open_positions",
    "/open_orders",
  ])("handles read-only command %s", async (command) => {
    const harness = createHarness(false);
    harness.exchange.positions = [openPosition()];
    await harness.controller.handle(messageUpdate(10, command));
    expect(harness.calls.some((call) => call.method === "sendMessage")).toBe(
      true,
    );
    expect(harness.exchange.placed).toHaveLength(0);
  });

  it("estimates per-position unrealised P&L when Shark does not supply it", async () => {
    const harness = createHarness(false, undefined, true);
    harness.exchange.positions = [openPositionWithoutUnrealisedPnl()];
    await harness.controller.handle(messageUpdate(14, "/open_positions"));
    const text = String(
      harness.calls.find((call) => call.method === "sendMessage")?.body.text,
    );
    expect(text).toContain("Unrealised P&L (est.): 99.50 USDT");
  });

  it("shows exchange-supplied unrealised P&L without the estimate label", async () => {
    const harness = createHarness(false, undefined, true);
    harness.exchange.positions = [openPosition()];
    await harness.controller.handle(messageUpdate(15, "/open_positions"));
    const text = String(
      harness.calls.find((call) => call.method === "sendMessage")?.body.text,
    );
    expect(text).toContain("Unrealised P&L: 25 USDT");
    expect(text).not.toContain("(est.)");
  });

  it("shows only the INR wallet for /wallet when USDT is unsupported", async () => {
    const harness = createHarness(false);
    harness.exchange.failingWallets.add("USDT");
    await harness.controller.handle(messageUpdate(16, "/wallet"));
    const text = String(
      harness.calls.find((call) => call.method === "sendMessage")?.body.text,
    );
    expect(text).toContain("INR Futures wallet");
    expect(text).not.toContain("USDT");
    expect(text).not.toContain("unavailable");
  });

  it("returns a safe parse error without executing", async () => {
    const harness = createHarness();
    await harness.controller.handle(
      messageUpdate(11, "/trade BTC long market margin 100 leverage 10"),
    );
    const response = harness.calls.find(
      (call) => call.method === "sendMessage",
    );
    expect(String(response?.body.text)).toContain("INVALID_CURRENCY");
    expect(harness.exchange.placed).toHaveLength(0);
  });

  it("reports reconciliation failure state through health without leaking details", async () => {
    const harness = createHarness(false);
    await harness.store.markReconciliation(
      "ACCOUNT_LEDGER",
      null,
      false,
      "HTTP_503",
    );
    await harness.controller.handle(messageUpdate(12, "/health"));
    const response = harness.calls.find(
      (call) => call.method === "sendMessage",
    );
    expect(String(response?.body.text)).toContain(
      "Reconciliation: FAILED (HTTP_503)",
    );
    expect(String(response?.body.text)).toContain("Mode: READ ONLY");
  });

  it("reports sanitized WebSocket degradation and REST fallback health", async () => {
    const activity = new Date("2026-07-17T08:00:00Z");
    const harness = createHarness(false, {
      getHealth: () => ({
        publicMarket: {
          state: "HEALTHY",
          connected: true,
          lastValidEventAt: activity,
          lastHeartbeatAt: activity,
          reconnects: 1,
          invalidMessages: 0,
          staleDetections: 0,
          lastErrorCode: null,
          subscriptions: 2,
          sequenceGaps: 1,
        },
        authenticatedAccount: {
          state: "DEGRADED",
          connected: false,
          lastValidEventAt: null,
          lastHeartbeatAt: activity,
          reconnects: 3,
          invalidMessages: 1,
          staleDetections: 1,
          lastErrorCode: "PRIVATE_LISTEN_KEY_SHOULD_NOT_BE_PRINTED",
          accountResyncs: 4,
          duplicateEvents: 1,
          outOfOrderEvents: 1,
          queueOverflows: 0,
        },
        restFallback: {
          state: "AVAILABLE",
          fallbacks: 5,
          lastSuccessAt: activity,
          lastFailureAt: null,
        },
      }),
    });
    await harness.controller.handle(messageUpdate(13, "/health"));
    const text = String(
      harness.calls.find((call) => call.method === "sendMessage")?.body.text,
    );
    expect(text).toContain("Public market stream: HEALTHY");
    expect(text).toContain("Authenticated account stream: DEGRADED");
    expect(text).toContain("REST fallback: AVAILABLE | used 5 times");
    expect(text).not.toContain("PRIVATE_LISTEN_KEY");
  });
});
