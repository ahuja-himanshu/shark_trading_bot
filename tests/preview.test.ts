import { describe, expect, it } from "vitest";
import type { TradeIntent } from "../src/domain/types.js";
import { PreviewService } from "../src/services/preview.js";
import {
  BTC_USDT,
  FakeExchange,
  openPosition,
} from "./helpers/fake-exchange.js";

function trade(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    kind: "TRADE",
    symbolInput: "BTC",
    direction: "LONG",
    orderType: "MARKET",
    marginAmount: "100",
    requestedMarginAsset: "USDT",
    leverage: 10,
    marginMode: "ISOLATED",
    ...overrides,
  };
}

describe("trade preview", () => {
  it("resolves the default market and makes 100 USDT at 10x a 1000 USDT position", async () => {
    const result = await new PreviewService(new FakeExchange()).calculate(
      trade(),
      "USDT",
    );
    expect(result.intent).toMatchObject({
      symbol: "BTCUSDT",
      marginMode: "ISOLATED",
    });
    expect(result.preview.estimatedNotional).toBe("1000");
    expect(result.preview.estimatedQuantity).toBe("0.01");
    expect(result.preview.lines).toContainEqual({
      label: "Margin",
      value: "100 USDT",
    });
  });

  it("includes a fresh stream mark price as a non-executable reference", async () => {
    const exchange = new FakeExchange();
    const result = await new PreviewService(exchange, undefined, {
      getBestBidAsk: async () => ({
        bestBid: "99900",
        bestAsk: "100000",
        markPrice: "99950",
      }),
    }).calculate(trade(), "USDT");

    expect(result.preview.referenceMarkPrice).toBe("99950");
    expect(result.preview.lines).toContainEqual({
      label: "Mark price",
      value: "99950 USDT",
    });
    expect(result.preview.estimatedEntryPrice).toBe("100000");
  });

  it("keeps quote market and margin asset distinct using conversion metadata", async () => {
    const result = await new PreviewService(new FakeExchange()).calculate(
      trade({
        symbolInput: "BTCUSDT",
        marginAmount: "9000",
        requestedMarginAsset: "INR",
        leverage: 10,
      }),
      "INR",
    );
    expect(result.preview.estimatedNotional).toBe("1000");
    expect(result.preview.warnings.join(" ")).toContain(
      "Quote market is USDT; margin is INR",
    );
  });

  it("rejects limit and protection prices that violate contract ticks", async () => {
    const exchange = new FakeExchange();
    exchange.contracts = [
      {
        ...BTC_USDT,
        filters: [
          ...BTC_USDT.filters,
          { filterType: "PRICE_FILTER", tickSize: "0.5" },
        ],
      },
    ];
    await expect(
      new PreviewService(exchange).calculate(
        trade({
          symbolInput: "BTCUSDT",
          orderType: "LIMIT",
          limitPrice: "95000.2",
        }),
        "USDT",
      ),
    ).rejects.toMatchObject({ code: "PRICE_NOT_ON_TICK" });

    exchange.positions = [openPosition()];
    await expect(
      new PreviewService(exchange).calculate(
        {
          kind: "PROTECTION",
          protectionType: "TAKE_PROFIT",
          symbolInput: "BTCUSDT",
          price: "100000.2",
        },
        "USDT",
      ),
    ).rejects.toMatchObject({ code: "PRICE_NOT_ON_TICK" });
  });

  it("uses the exchange quantity step and explains exposure/liquidation assumptions", async () => {
    const exchange = new FakeExchange();
    exchange.contracts = [
      {
        ...BTC_USDT,
        quantityPrecision: 3,
        filters: BTC_USDT.filters.map((filter) =>
          filter.filterType === "MARKET_QTY_SIZE"
            ? { ...filter, stepSize: "0.003" }
            : filter,
        ),
      },
    ];
    exchange.positions = [openPosition({ direction: "SHORT" })];
    const result = await new PreviewService(exchange).calculate(
      trade({ symbolInput: "BTCUSDT" }),
      "USDT",
    );
    expect(result.preview.estimatedQuantity).toBe("0.009");
    expect(result.preview.lines).toContainEqual({
      label: "Exposure effect",
      value: "Reduces existing SHORT exposure",
    });
    expect(result.preview.warnings.join(" ")).toContain(
      "Liquidation is a bot estimate",
    );
  });

  it("classifies a trade that can reverse opposite exposure", async () => {
    const exchange = new FakeExchange();
    exchange.positions = [
      openPosition({ direction: "SHORT", quantity: "0.005" }),
    ];
    const result = await new PreviewService(exchange).calculate(
      trade({ symbolInput: "BTCUSDT" }),
      "USDT",
    );
    expect(result.preview.lines).toContainEqual({
      label: "Exposure effect",
      value: "May reverse SHORT exposure to LONG",
    });
  });

  it("fails closed for unsupported leverage", async () => {
    await expect(
      new PreviewService(new FakeExchange()).calculate(
        trade({ leverage: 100 }),
        "USDT",
      ),
    ).rejects.toMatchObject({ code: "LEVERAGE_NOT_SUPPORTED" });
  });

  it("previews reduce-only close using the executable side of the book", async () => {
    const exchange = new FakeExchange();
    exchange.positions = [openPosition()];
    const result = await new PreviewService(exchange).calculate(
      { kind: "CLOSE", symbolInput: "BTC", orderType: "MARKET" },
      "USDT",
    );
    expect(result.intent).toMatchObject({ symbol: "BTCUSDT" });
    expect(result.preview.positionIds).toEqual(["position-1"]);
    expect(result.preview.estimatedEntryPrice).toBe("99900");
  });

  it("previews close-all and manual protection", async () => {
    const exchange = new FakeExchange();
    exchange.positions = [openPosition()];
    const service = new PreviewService(exchange);
    const closeAll = await service.calculate({ kind: "CLOSE_ALL" }, "USDT");
    expect(closeAll.preview.positionIds).toEqual(["position-1"]);
    const stop = await service.calculate(
      {
        kind: "PROTECTION",
        protectionType: "STOP_LOSS",
        symbolInput: "BTCUSDT",
        price: "85000",
      },
      "USDT",
    );
    expect(stop.preview.estimatedQuantity).toBe("0.01");
  });

  it("previews one or many order cancellations", async () => {
    const exchange = new FakeExchange();
    exchange.orders = [
      {
        clientOrderId: "order-1",
        symbol: "BTCUSDT",
        type: "LIMIT",
        side: "BUY",
        price: "90000",
        orderAmount: "0.01",
        filledAmount: "0",
      },
    ];
    const service = new PreviewService(exchange);
    expect(
      (
        await service.calculate(
          { kind: "CANCEL_ORDERS", symbolInput: "BTC" },
          "USDT",
        )
      ).preview.title,
    ).toContain("BTCUSDT");
    expect(
      (
        await service.calculate(
          { kind: "CANCEL_ORDER", clientOrderId: "order-1" },
          "USDT",
        )
      ).preview.title,
    ).toContain("Cancel BTCUSDT");
  });

  it.each([
    [{ kind: "CLOSE_ALL" } as const, "NO_OPEN_POSITIONS"],
    [
      {
        kind: "PROTECTION",
        protectionType: "STOP_LOSS",
        symbolInput: "BTCUSDT",
        price: "80000",
      } as const,
      "POSITION_NOT_FOUND",
    ],
    [{ kind: "CANCEL_ORDERS" } as const, "NO_OPEN_ORDERS"],
    [
      { kind: "CANCEL_ORDER", clientOrderId: "missing" } as const,
      "ORDER_NOT_FOUND",
    ],
  ])(
    "fails closed when preview precondition is absent",
    async (intent, code) => {
      await expect(
        new PreviewService(new FakeExchange()).calculate(intent, "USDT"),
      ).rejects.toMatchObject({
        code,
      });
    },
  );
});
