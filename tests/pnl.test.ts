import { describe, expect, it, vi } from "vitest";
import { PnlService, istDayRange } from "../src/services/pnl.js";
import { FakeExchange, openPosition } from "./helpers/fake-exchange.js";

describe("P&L accounting", () => {
  it("computes realised P&L, fees, and funding from account postings", async () => {
    const exchange = new FakeExchange();
    exchange.positions = [openPosition()];
    const at = (iso: string) => new Date(iso);
    exchange.transactions = [
      {
        exchangeEventId: "r1",
        type: "REALIZED_PNL",
        amount: "100",
        asset: "USDT",
        occurredAt: at("2026-07-17T01:00:00Z"),
      },
      {
        exchangeEventId: "r2",
        type: "REALIZED_PNL",
        amount: "-20",
        asset: "USDT",
        occurredAt: at("2026-07-17T01:05:00Z"),
      },
      {
        exchangeEventId: "c1",
        type: "COMMISSION",
        amount: "-2",
        asset: "USDT",
        occurredAt: at("2026-07-17T01:00:10Z"),
      },
      {
        exchangeEventId: "g1",
        type: "GST_ON_COMMISSION",
        amount: "-0.36",
        asset: "USDT",
        occurredAt: at("2026-07-17T01:00:11Z"),
      },
      {
        exchangeEventId: "d1",
        type: "FEE_DISCOUNT",
        amount: "0.5",
        asset: "USDT",
        occurredAt: at("2026-07-17T01:00:12Z"),
      },
      {
        exchangeEventId: "cl1",
        type: "CLEARANCE_FEE",
        amount: "-0.1",
        asset: "USDT",
        occurredAt: at("2026-07-17T01:00:13Z"),
      },
      {
        exchangeEventId: "cl2",
        type: "GST_ON_CLEARANCE_FEE",
        amount: "-0.02",
        asset: "USDT",
        occurredAt: at("2026-07-17T01:00:14Z"),
      },
      {
        exchangeEventId: "f1",
        type: "FUNDING_FEE",
        amount: "-3",
        asset: "USDT",
        occurredAt: at("2026-07-17T02:00:00Z"),
      },
      {
        exchangeEventId: "f2",
        type: "GST_ON_FUNDING_FEE",
        amount: "-0.54",
        asset: "USDT",
        occurredAt: at("2026-07-17T02:00:01Z"),
      },
      {
        exchangeEventId: "dep1",
        type: "DEPOSIT",
        amount: "1000",
        asset: "USDT",
        occurredAt: at("2026-07-17T03:00:00Z"),
      },
      {
        exchangeEventId: "old",
        type: "REALIZED_PNL",
        amount: "999",
        asset: "USDT",
        occurredAt: at("2026-07-10T01:00:00Z"),
      },
    ];
    const result = await new PnlService(exchange).summary(
      new Date("2026-07-17T00:00:00Z"),
      new Date("2026-07-17T23:59:59Z"),
    );
    expect(result.realisedProfit.USDT).toBe("80");
    expect(result.fees.USDT).toBe("1.98");
    expect(result.funding.USDT).toBe("-3.54");
    expect(result.netRealised.USDT).toBe("74.48");
    expect(result.unrealised.USDT).toBe("25");
  });

  it("paginates through the complete history for a custom range", async () => {
    const exchange = new FakeExchange();
    exchange.transactions = Array.from({ length: 150 }, (_, index) => ({
      exchangeEventId: `pnl-${index}`,
      type: "REALIZED_PNL",
      amount: "1",
      asset: "USDT" as const,
      occurredAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)),
    }));
    const result = await new PnlService(exchange).summary(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T23:59:59Z"),
    );
    expect(result.realisedProfit.USDT).toBe("150");
  });

  it("reads from the history floor when no start is given", async () => {
    const exchange = new FakeExchange();
    const transactions = vi.spyOn(exchange, "getTransactionHistory");
    await new PnlService(exchange).summary(
      null,
      new Date("2026-07-18T00:00:00Z"),
    );
    expect(transactions).toHaveBeenCalledWith(
      expect.objectContaining({ start: new Date("2024-01-01T00:00:00Z") }),
    );
  });

  it("uses Asia/Kolkata day boundaries", () => {
    const range = istDayRange("2026-07-17");
    expect(range.start.toISOString()).toBe("2026-07-16T18:30:00.000Z");
    expect(range.end.toISOString()).toBe("2026-07-17T18:29:59.999Z");
  });
});
