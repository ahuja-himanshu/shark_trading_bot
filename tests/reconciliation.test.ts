import { describe, expect, it, vi } from "vitest";
import { SharkApiError } from "../src/exchange/shark-client.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { ReconciliationService } from "../src/services/reconciliation.js";
import { FakeExchange, openPosition } from "./helpers/fake-exchange.js";

const NOW = new Date("2026-07-17T06:00:00.000Z");

describe("account reconciliation", () => {
  it("idempotently persists fills, funding, positions, orders, cursor, and audit evidence", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    exchange.positions = [openPosition()];
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
    exchange.fills = [
      {
        exchangeFillId: "fill-1",
        clientOrderId: "order-0",
        symbol: "BTCUSDT",
        side: "SELL",
        orderType: "MARKET",
        price: "100000",
        quantity: "0.01",
        fee: "1",
        realisedProfit: "50",
        marginAsset: "USDT",
        occurredAt: new Date("2026-07-17T05:00:00Z"),
      },
    ];
    exchange.transactions = [
      {
        exchangeEventId: "funding-1",
        type: "FUNDING_FEE",
        amount: "-2",
        asset: "USDT",
        occurredAt: new Date("2026-07-17T05:30:00Z"),
      },
    ];
    const onError = vi.fn();
    const service = new ReconciliationService(
      store,
      exchange,
      60,
      onError,
      () => NOW,
    );

    await service.runOnce();
    await service.runOnce();

    expect(store.fills.size).toBe(1);
    expect(store.transactions.size).toBe(1);
    expect(store.orders.size).toBe(1);
    expect(store.snapshots).toHaveLength(2);
    expect(await store.getReconciliationCursor("ACCOUNT_LEDGER")).toEqual(NOW);
    expect(
      (await store.getReconciliationStatus("ACCOUNT_LEDGER"))?.lastErrorCode,
    ).toBeNull();
    expect(
      store.audits.filter(
        (event) => event.action === "RECONCILIATION_COMPLETED",
      ),
    ).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("uses an overlap window from the last cursor", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    const previous = new Date("2026-07-17T05:00:00Z");
    await store.markReconciliation("ACCOUNT_LEDGER", previous, true);
    const history = vi.spyOn(exchange, "getTradeHistory");
    const service = new ReconciliationService(
      store,
      exchange,
      60,
      vi.fn(),
      () => NOW,
    );

    await service.runOnce();

    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        start: new Date("2026-07-17T04:59:00Z"),
        end: NOW,
        sortOrder: "asc",
      }),
    );
  });

  it("records a failure without advancing the successful cursor", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    const previous = new Date("2026-07-17T05:00:00Z");
    await store.markReconciliation("ACCOUNT_LEDGER", previous, true);
    vi.spyOn(exchange, "getTradeHistory").mockRejectedValue(
      new SharkApiError("unavailable", 503, "HTTP_503", true),
    );
    const onError = vi.fn();
    const service = new ReconciliationService(
      store,
      exchange,
      60,
      onError,
      () => NOW,
    );

    await service.runOnce();

    const status = await store.getReconciliationStatus("ACCOUNT_LEDGER");
    expect(status?.cursor).toEqual(previous);
    expect(status?.lastErrorCode).toBe("HTTP_503");
    expect(store.audits.at(-1)?.action).toBe("RECONCILIATION_FAILED");
    expect(onError).toHaveBeenCalledOnce();
  });
});
