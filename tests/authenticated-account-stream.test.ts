import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharkApiError } from "../src/exchange/shark-client.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { AuthenticatedAccountStream } from "../src/streams/authenticated-account-stream.js";
import { FakeExchange } from "./helpers/fake-exchange.js";
import { flushPromises, socketFactoryHarness } from "./helpers/fake-socket.js";

const logger = pino({ level: "silent" });

afterEach(() => vi.useRealTimers());

function rawPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: "position-1",
    contractPair: "BTCUSDT",
    positionStatus: "OPEN",
    positionType: "LONG",
    marginType: "ISOLATED",
    marginAsset: "USDT",
    quoteAsset: "USDT",
    baseAsset: "BTC",
    entryPrice: "90000",
    liquidationPrice: "81000",
    margin: "100",
    marginInMarginAsset: "100",
    quantity: "0.01",
    positionSize: "900",
    leverage: 10,
    createdAt: "2026-07-17T07:00:00Z",
    updatedAt: "2026-07-17T08:00:00Z",
    ...overrides,
  };
}

function rawOrder(overrides: Record<string, unknown> = {}) {
  return {
    clientOrderId: "order-1",
    symbol: "BTCUSDT",
    type: "LIMIT",
    side: "BUY",
    price: "90000",
    orderAmount: "0.01",
    filledAmount: "0",
    status: "OPEN",
    createdAt: "2026-07-17T07:00:00Z",
    updatedAt: "2026-07-17T08:00:00Z",
    ...overrides,
  };
}

function rawTrade(overrides: Record<string, unknown> = {}) {
  return {
    id: "fill-1",
    clientOrderId: "order-1",
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    price: "100000",
    quantity: "0.01",
    fee: "0.5",
    realizedProfit: "0",
    marginAsset: "USDT",
    time: "2026-07-17T08:00:01Z",
    ...overrides,
  };
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const sockets = socketFactoryHarness();
  const exchange = new FakeExchange();
  const store = new MemoryStore();
  const resync = vi.fn().mockResolvedValue(undefined);
  const stream = new AuthenticatedAccountStream(
    {
      url: "https://fawss-uds.sharkexchange.in/auth-stream",
      renewalMs: 45 * 60 * 1_000,
      staleAfterMs: 45_000,
      maxMessageBytes: 8_192,
      socketFactory: sockets.factory,
      random: () => 1,
      ...overrides,
    },
    exchange,
    store,
    resync,
    logger,
  );
  return { stream, sockets, exchange, store, resync };
}

describe("authenticated Shark account stream", () => {
  it("creates a listen key and idempotently persists account events", async () => {
    const harness = createHarness();
    harness.stream.start();
    await flushPromises();
    const socket = harness.sockets.sockets[0];
    expect(harness.exchange.listenKeyCreates).toBe(1);
    expect(harness.sockets.urls[0]).toMatch(/\/auth-stream\/[A-Za-z0-9_-]+$/);
    socket?.serverEmit("connect");
    socket?.serverEmit("newPosition", rawPosition());
    socket?.serverEmit("newOrder", rawOrder());
    socket?.serverEmit("newTrade", rawTrade());
    await flushPromises(30);

    expect(harness.store.snapshots).toHaveLength(1);
    expect(harness.store.orders.get("order-1")?.status).toBe("OPEN");
    expect(harness.store.fills.has("fill-1")).toBe(true);
    expect(harness.resync).toHaveBeenCalledOnce();

    socket?.serverEmit("newTrade", rawTrade());
    socket?.serverEmit(
      "updateOrder",
      rawOrder({
        filledAmount: "0.005",
        updatedAt: "2026-07-17T07:59:00Z",
      }),
    );
    await flushPromises(20);
    expect(harness.stream.getHealth()).toMatchObject({
      duplicateEvents: 1,
      outOfOrderEvents: 1,
    });
    expect(harness.resync).toHaveBeenCalledTimes(2);
    expect(harness.store.orders.get("order-1")?.filledAmount).toBe("0");
    await harness.stream.stop();
  });

  it("renews the listen key before expiry and recreates an expired session", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ renewalMs: 1_000 });
    harness.stream.start();
    await flushPromises();
    const first = harness.sockets.sockets[0];
    first?.serverEmit("connect");
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(harness.exchange.listenKeyRenewals).toBe(1);

    first?.serverEmit("sessionExpired", { reason: "expired" });
    await flushPromises(20);
    expect(harness.exchange.listenKeyDeletes).toBe(1);
    expect(harness.exchange.listenKeyCreates).toBe(2);
    expect(harness.sockets.sockets).toHaveLength(2);
    await harness.stream.stop();
  });

  it("reconnects, performs REST resynchronization, and stops cleanly", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    harness.stream.start();
    await flushPromises();
    const socket = harness.sockets.sockets[0];
    socket?.serverEmit("connect");
    await flushPromises();
    socket?.serverEmit("disconnect");
    vi.advanceTimersByTime(10);
    await flushPromises();
    expect(socket?.connectCalls).toBe(2);
    socket?.serverEmit("connect");
    await flushPromises();
    expect(harness.resync).toHaveBeenCalledTimes(2);

    await harness.stream.stop();
    expect(harness.exchange.listenKeyDeletes).toBe(1);
    const calls = socket?.connectCalls;
    vi.advanceTimersByTime(60_000);
    expect(socket?.connectCalls).toBe(calls);
    expect(harness.stream.getHealth().state).toBe("STOPPED");
  });

  it("rejects malformed messages and bounds its ingestion queue", async () => {
    let release: ((value: "CLAIMED") => void) | undefined;
    const harness = createHarness({ maxMessageBytes: 2_048, maxQueueSize: 1 });
    vi.spyOn(harness.store, "claimAccountStreamEvent")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue("CLAIMED");
    harness.stream.start();
    await flushPromises();
    const socket = harness.sockets.sockets[0];
    socket?.serverEmit("connect");
    socket?.serverEmit("newPosition", { invalid: true });
    socket?.serverEmit("newPosition", rawPosition());
    await flushPromises();
    socket?.serverEmit(
      "updatePosition",
      rawPosition({ positionId: "position-2" }),
    );
    socket?.serverEmit(
      "updatePosition",
      rawPosition({ positionId: "position-3" }),
    );
    expect(harness.stream.getHealth().queueOverflows).toBeGreaterThan(0);
    release?.("CLAIMED");
    await flushPromises(20);
    expect(harness.stream.getHealth().invalidMessages).toBeGreaterThan(0);
    await harness.stream.stop();
  });

  it("isolates startup failures without crashing the bot process", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    vi.spyOn(harness.exchange, "createListenKey").mockRejectedValue(
      new SharkApiError("private failure", 503, "HTTP_503", true),
    );
    harness.stream.start();
    await flushPromises();
    expect(harness.stream.getHealth()).toMatchObject({
      connected: false,
      state: "RECONNECTING",
      lastErrorCode: "HTTP_503",
    });
    await harness.stream.stop();
  });
});
