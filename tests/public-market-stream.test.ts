import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HybridMarketData } from "../src/services/market-data.js";
import { PublicMarketStream } from "../src/streams/public-market-stream.js";
import { FakeExchange } from "./helpers/fake-exchange.js";
import { socketFactoryHarness } from "./helpers/fake-socket.js";

const logger = pino({ level: "silent" });

afterEach(() => vi.useRealTimers());

function createHarness(overrides: Record<string, unknown> = {}) {
  const sockets = socketFactoryHarness();
  let now = new Date("2026-07-17T08:00:00Z");
  const stream = new PublicMarketStream(
    {
      url: "https://fawss.sharkexchange.in",
      maxQuoteAgeMs: 5_000,
      staleAfterMs: 45_000,
      subscriptionLeaseMs: 900_000,
      maxMessageBytes: 4_096,
      socketFactory: sockets.factory,
      now: () => now,
      random: () => 1,
      ...overrides,
    },
    logger,
  );
  return {
    stream,
    sockets,
    setNow(value: Date) {
      now = value;
    },
  };
}

describe("public Shark market stream", () => {
  it("connects, subscribes only watched symbols, and maintains live quote fields", () => {
    const harness = createHarness();
    harness.stream.watch("BTCUSDT", "0.5");
    harness.stream.start();
    const socket = harness.sockets.sockets[0];
    expect(socket?.connectCalls).toBe(1);

    socket?.serverEmit("connect");
    expect(socket?.emitted).toContainEqual({
      event: "subscribe",
      args: [
        {
          params: ["btcusdt@depth_0.5", "btcusdt@markPrice", "btcusdt@ticker"],
        },
      ],
    });
    socket?.serverEmit("depthUpdate", {
      s: "BTCUSDT",
      E: 1_768_000_000_000,
      U: "100",
      u: "101",
      b: [["99900", "1"]],
      a: [["100000", "2"]],
    });
    socket?.serverEmit("markPriceUpdate", {
      s: "BTCUSDT",
      E: 1_768_000_000_010,
      p: "99950",
    });
    socket?.serverEmit("24hrTicker", {
      s: "BTCUSDT",
      E: 1_768_000_000_020,
      c: "99975",
    });

    expect(harness.stream.getFreshQuote("BTCUSDT")).toMatchObject({
      symbol: "BTCUSDT",
      bestBid: "99900",
      bestAsk: "100000",
      markPrice: "99950",
      tickerPrice: "99975",
      firstUpdateId: "100",
      lastUpdateId: "101",
    });
    expect(harness.stream.getHealth().state).toBe("HEALTHY");
    harness.stream.unwatch("BTCUSDT");
    expect(harness.stream.getFreshQuote("BTCUSDT")).toBeNull();
    expect(
      socket?.emitted.some((message) => message.event === "unsubscribe"),
    ).toBe(true);
    harness.stream.stop();
  });

  it("uses fresh WebSocket quotes and falls back to REST when stale", async () => {
    const harness = createHarness();
    const exchange = new FakeExchange();
    const rest = vi.spyOn(exchange, "getBestBidAsk");
    const marketData = new HybridMarketData(
      harness.stream,
      exchange,
      () => new Date("2026-07-17T08:00:06Z"),
    );
    harness.stream.watch("BTCUSDT");
    harness.stream.start();
    const socket = harness.sockets.sockets[0];
    socket?.serverEmit("connect");
    socket?.serverEmit("depthUpdate", {
      s: "BTCUSDT",
      U: 1,
      u: 2,
      b: [["99000", "1"]],
      a: [["99100", "1"]],
    });
    socket?.serverEmit("markPriceUpdate", {
      s: "BTCUSDT",
      p: "99050",
    });

    expect(await marketData.getBestBidAsk("BTCUSDT")).toEqual({
      bestBid: "99000",
      bestAsk: "99100",
      markPrice: "99050",
    });
    expect(rest).not.toHaveBeenCalled();

    harness.setNow(new Date("2026-07-17T08:00:06Z"));
    socket?.serverEmit("markPriceUpdate", {
      s: "BTCUSDT",
      p: "99060",
    });
    expect(await marketData.getBestBidAsk("BTCUSDT")).toEqual({
      bestBid: "99900",
      bestAsk: "100000",
    });
    expect(rest).toHaveBeenCalledOnce();
    expect(marketData.getHealth()).toMatchObject({
      state: "AVAILABLE",
      fallbacks: 1,
    });

    socket?.serverEmit("disconnect");
    harness.setNow(new Date("2026-07-17T08:00:07Z"));
    await marketData.getBestBidAsk("BTCUSDT");
    expect(rest).toHaveBeenCalledTimes(2);
    harness.stream.stop();
  });

  it("rejects malformed or oversized messages and detects sequence gaps", () => {
    const harness = createHarness({ maxMessageBytes: 128 });
    harness.stream.watch("BTCUSDT");
    harness.stream.start();
    const socket = harness.sockets.sockets[0];
    socket?.serverEmit("connect");
    socket?.serverEmit("depthUpdate", {});
    socket?.serverEmit("markPriceUpdate", { value: "x".repeat(256) });
    socket?.serverEmit("depthUpdate", {
      s: "BTCUSDT",
      U: 1,
      u: 2,
      b: [["99900", "1"]],
      a: [["100000", "1"]],
    });
    socket?.serverEmit("depthUpdate", {
      s: "BTCUSDT",
      U: 4,
      u: 5,
      pu: 3,
      b: [["99800", "1"]],
      a: [["99900", "1"]],
    });

    expect(harness.stream.getHealth()).toMatchObject({
      invalidMessages: 2,
      sequenceGaps: 1,
      lastErrorCode: "MARKET_SEQUENCE_GAP",
    });
    expect(harness.stream.getFreshQuote("BTCUSDT")).toBeNull();
    expect(
      socket?.emitted.filter((message) => message.event === "subscribe"),
    ).toHaveLength(2);

    socket?.serverEmit("depthUpdate", {
      s: "BTCUSDT",
      U: 10,
      u: 11,
      b: [["99700", "1"]],
      a: [["99800", "1"]],
    });
    expect(harness.stream.getFreshQuote("BTCUSDT")).toMatchObject({
      bestBid: "99700",
      bestAsk: "99800",
      lastUpdateId: "11",
    });
    harness.stream.stop();
  });

  it("does not refresh an executable book from incomplete or crossed quotes", () => {
    const harness = createHarness();
    harness.stream.watch("BTCUSDT");
    harness.stream.start();
    const socket = harness.sockets.sockets[0];
    socket?.serverEmit("connect");
    socket?.serverEmit("depthUpdate", {
      s: "BTCUSDT",
      b: [["99900", "1"]],
    });
    socket?.serverEmit("24hrTicker", {
      s: "BTCUSDT",
      b: "100100",
      a: "100000",
    });

    expect(harness.stream.getFreshQuote("BTCUSDT")).toBeNull();
    expect(harness.stream.getHealth().invalidMessages).toBe(2);
    harness.stream.stop();
  });

  it("reconnects with bounded backoff, resubscribes, and stops cleanly", () => {
    vi.useFakeTimers();
    const harness = createHarness({ reconnectBaseMs: 10, reconnectMaxMs: 10 });
    harness.stream.watch("BTCUSDT");
    harness.stream.start();
    const socket = harness.sockets.sockets[0];
    socket?.serverEmit("connect");
    socket?.serverEmit("disconnect");
    vi.advanceTimersByTime(10);
    expect(socket?.connectCalls).toBe(2);
    socket?.serverEmit("connect");
    expect(
      socket?.emitted.filter((message) => message.event === "subscribe"),
    ).toHaveLength(2);

    harness.stream.stop();
    const calls = socket?.connectCalls;
    socket?.serverEmit("disconnect");
    vi.advanceTimersByTime(60_000);
    expect(socket?.connectCalls).toBe(calls);
    expect(harness.stream.getHealth().state).toBe("STOPPED");
  });

  it("does not treat a silent TCP connection as healthy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T08:00:00Z"));
    const harness = createHarness({
      now: () => new Date(),
      staleAfterMs: 5_000,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    harness.stream.watch("BTCUSDT");
    harness.stream.start();
    const socket = harness.sockets.sockets[0];
    socket?.serverEmit("connect");

    vi.advanceTimersByTime(7_500);

    expect(harness.stream.getHealth().staleDetections).toBeGreaterThan(0);
    expect(socket?.disconnectCalls).toBeGreaterThan(0);
    harness.stream.stop();
  });
});
