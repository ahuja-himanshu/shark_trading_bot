import { describe, expect, it } from "vitest";
import type { BestBidAskSource } from "../src/services/market-data.js";
import {
  estimateUnrealisedPnl,
  UnrealisedPnlEstimator,
} from "../src/services/unrealised-pnl.js";
import {
  BTC_USDT,
  FakeExchange,
  openPosition,
  openPositionWithoutUnrealisedPnl,
} from "./helpers/fake-exchange.js";

describe("estimateUnrealisedPnl", () => {
  const longUsdt = {
    direction: "LONG" as const,
    entryPrice: "90000",
    quantity: "0.01",
    marginAsset: "USDT" as const,
  };

  it("computes long P&L in the quote asset", () => {
    expect(estimateUnrealisedPnl(longUsdt, "99950", BTC_USDT)).toBe("99.50");
  });

  it("sign-flips shorts, including losses", () => {
    const short = { ...longUsdt, direction: "SHORT" as const };
    expect(estimateUnrealisedPnl(short, "85000", BTC_USDT)).toBe("50.00");
    expect(estimateUnrealisedPnl(short, "95000", BTC_USDT)).toBe("-50.00");
  });

  it("converts quote P&L into a different margin asset", () => {
    expect(
      estimateUnrealisedPnl(
        { ...longUsdt, marginAsset: "INR" as const },
        "99950",
        BTC_USDT,
      ),
    ).toBe("8955.00");
  });

  it("returns undefined when the conversion rate is missing or invalid", () => {
    const noRates = { ...BTC_USDT, conversionRates: {} };
    expect(
      estimateUnrealisedPnl(
        { ...longUsdt, marginAsset: "INR" as const },
        "99950",
        noRates,
      ),
    ).toBeUndefined();
    const zeroRate = { ...BTC_USDT, conversionRates: { INR_MARGIN_USDT: "0" } };
    expect(
      estimateUnrealisedPnl(
        { ...longUsdt, marginAsset: "INR" as const },
        "99950",
        zeroRate,
      ),
    ).toBeUndefined();
  });
});

describe("UnrealisedPnlEstimator", () => {
  it("keeps exchange-supplied values and estimates missing ones from mid price", async () => {
    const exchange = new FakeExchange();
    const estimator = new UnrealisedPnlEstimator(exchange, exchange);
    const supplied = openPosition({ positionId: "supplied" });
    const missing = openPositionWithoutUnrealisedPnl({
      positionId: "missing",
    });
    const enriched = await estimator.enrich([supplied, missing]);
    expect(enriched[0]).toMatchObject({
      positionId: "supplied",
      unrealisedProfit: "25",
    });
    expect(enriched[0]?.unrealisedProfitEstimated).toBeUndefined();
    expect(enriched[1]).toMatchObject({
      positionId: "missing",
      unrealisedProfit: "99.50",
      unrealisedProfitEstimated: true,
    });
  });

  it("prefers mark price over mid price when available", async () => {
    const exchange = new FakeExchange();
    const marketData: BestBidAskSource = {
      getBestBidAsk: () =>
        Promise.resolve({
          bestBid: "1",
          bestAsk: "3",
          markPrice: "91000",
        }),
    };
    const estimator = new UnrealisedPnlEstimator(exchange, marketData);
    const enriched = await estimator.enrich([
      openPositionWithoutUnrealisedPnl(),
    ]);
    expect(enriched[0]?.unrealisedProfit).toBe("10.00");
  });

  it("leaves positions untouched when market data fails or the contract is unknown", async () => {
    const exchange = new FakeExchange();
    const failing: BestBidAskSource = {
      getBestBidAsk: () => Promise.reject(new Error("stream down")),
    };
    const estimator = new UnrealisedPnlEstimator(exchange, failing);
    const missing = openPositionWithoutUnrealisedPnl();
    const unknown = openPositionWithoutUnrealisedPnl({
      positionId: "unknown",
      symbol: "DOGEUSDT",
    });
    const enriched = await estimator.enrich([missing, unknown]);
    expect(enriched[0]?.unrealisedProfit).toBeUndefined();
    expect(enriched[1]?.unrealisedProfit).toBeUndefined();
  });
});
