import { describe, expect, it, vi } from "vitest";
import { ConfirmationRejectedError } from "../src/repositories/store.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { DraftService } from "../src/services/drafts.js";
import { ExecutionService } from "../src/services/execution.js";
import { PreviewService } from "../src/services/preview.js";
import { FakeExchange, openPosition } from "./helpers/fake-exchange.js";

describe("draft and confirmation lifecycle", () => {
  it("invalidates the old confirmation when a draft is edited", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    const drafts = new DraftService(store, new PreviewService(exchange), 120);
    const initial = await drafts.create(
      {
        kind: "TRADE",
        symbolInput: "BTCUSDT",
        direction: "LONG",
        orderType: "MARKET",
        marginAmount: "100",
        requestedMarginAsset: "USDT",
        leverage: 10,
        marginMode: "ISOLATED",
      },
      "123",
      "123",
      "USDT",
    );
    const edited = await drafts.edit(
      {
        kind: "EDIT",
        draftId: initial.draft.id,
        field: "margin",
        values: ["200", "USDT"],
      },
      "123",
      "123",
      "USDT",
    );
    expect(edited.draft.version).toBe(2);
    expect(edited.draft.preview.estimatedNotional).toBe("2000");

    const execution = new ExecutionService(store, exchange, true);
    await expect(
      execution.confirm(initial.confirmationToken, "123", "123"),
    ).rejects.toBeInstanceOf(ConfirmationRejectedError);
  });

  it("executes one confirmed trade once and rejects replay", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    const drafts = new DraftService(store, new PreviewService(exchange), 120);
    const draft = await drafts.create(
      {
        kind: "TRADE",
        symbolInput: "BTCUSDT",
        direction: "LONG",
        orderType: "MARKET",
        marginAmount: "100",
        requestedMarginAsset: "USDT",
        leverage: 10,
        marginMode: "ISOLATED",
      },
      "123",
      "123",
      "USDT",
    );
    const execution = new ExecutionService(store, exchange, true);
    const result = await execution.confirm(
      draft.confirmationToken,
      "123",
      "123",
    );
    expect(result.state).toBe("SUBMITTED");
    expect(exchange.preferences).toEqual([
      { symbol: "BTCUSDT", leverage: 10, marginMode: "ISOLATED" },
    ]);
    expect(exchange.placed).toHaveLength(1);
    await expect(
      execution.confirm(draft.confirmationToken, "123", "123"),
    ).rejects.toMatchObject({
      code: "CONFIRMATION_ALREADY_USED",
    });
    expect(exchange.placed).toHaveLength(1);
  });

  it("re-fetches the close position and always submits reduce-only for its current quantity", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    exchange.positions = [openPosition()];
    const drafts = new DraftService(store, new PreviewService(exchange), 120);
    const draft = await drafts.create(
      { kind: "CLOSE", symbolInput: "BTCUSDT", orderType: "MARKET" },
      "123",
      "123",
      "USDT",
    );
    exchange.positions[0] = openPosition({ quantity: "0.008" });
    const result = await new ExecutionService(store, exchange, true).confirm(
      draft.confirmationToken,
      "123",
      "123",
    );
    expect(result.state).toBe("SUBMITTED");
    expect(exchange.placed[0]).toMatchObject({
      placeType: "POSITION",
      positionId: "position-1",
      quantity: "0.008",
      side: "SELL",
      reduceOnly: true,
    });
  });

  it("does not consume a confirmation while trading is disabled", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    const drafts = new DraftService(store, new PreviewService(exchange), 120);
    const draft = await drafts.create(
      {
        kind: "TRADE",
        symbolInput: "BTCUSDT",
        direction: "LONG",
        orderType: "MARKET",
        marginAmount: "100",
        requestedMarginAsset: "USDT",
        leverage: 10,
        marginMode: "ISOLATED",
      },
      "123",
      "123",
      "USDT",
    );
    await expect(
      new ExecutionService(store, exchange, false).confirm(
        draft.confirmationToken,
        "123",
        "123",
      ),
    ).rejects.toMatchObject({ code: "TRADING_DISABLED" });
    expect(exchange.placed).toHaveLength(0);
  });

  it("fails closed when contract price precision changes before confirmation", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    const envelope = await new DraftService(
      store,
      new PreviewService(exchange),
      120,
    ).create(
      {
        kind: "TRADE",
        symbolInput: "BTCUSDT",
        direction: "LONG",
        orderType: "LIMIT",
        limitPrice: "95000.5",
        marginAmount: "100",
        requestedMarginAsset: "USDT",
        leverage: 10,
        marginMode: "ISOLATED",
      },
      "123",
      "123",
      "USDT",
    );
    exchange.contracts = exchange.contracts.map((contract) =>
      contract.symbol === "BTCUSDT"
        ? { ...contract, pricePrecision: 0 }
        : contract,
    );
    const result = await new ExecutionService(store, exchange, true).confirm(
      envelope.confirmationToken,
      "123",
      "123",
    );
    expect(result.state).toBe("FAILED");
    expect(result.message).toContain("at most 0 decimal places");
    expect(exchange.placed).toHaveLength(0);
  });

  it.each([
    [
      { kind: "CLOSE_ALL" } as const,
      (exchange: FakeExchange) => {
        exchange.positions = [openPosition()];
      },
      "RECONCILED",
      (exchange: FakeExchange) => expect(exchange.closeAllCalls).toBe(1),
    ],
    [
      {
        kind: "PROTECTION",
        protectionType: "TAKE_PROFIT",
        symbolInput: "BTCUSDT",
        price: "110000",
      } as const,
      (exchange: FakeExchange) => {
        exchange.positions = [openPosition()];
      },
      "SUBMITTED",
      (exchange: FakeExchange) => expect(exchange.protections).toHaveLength(1),
    ],
  ] as const)(
    "executes confirmed non-order action",
    async (intent, arrange, expectedState, verify) => {
      const store = new MemoryStore();
      const exchange = new FakeExchange();
      arrange(exchange);
      const envelope = await new DraftService(
        store,
        new PreviewService(exchange),
        120,
      ).create(intent, "123", "123", "USDT");
      const result = await new ExecutionService(store, exchange, true).confirm(
        envelope.confirmationToken,
        "123",
        "123",
      );
      expect(result.state).toBe(expectedState);
      verify(exchange);
    },
  );

  it("executes filtered order cancellation individually", async () => {
    const store = new MemoryStore();
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
    const envelope = await new DraftService(
      store,
      new PreviewService(exchange),
      120,
    ).create(
      { kind: "CANCEL_ORDERS", symbolInput: "BTCUSDT" },
      "123",
      "123",
      "USDT",
    );
    const result = await new ExecutionService(store, exchange, true).confirm(
      envelope.confirmationToken,
      "123",
      "123",
    );
    expect(result.state).toBe("RECONCILED");
    expect(exchange.cancelled).toEqual(["order-1"]);
  });

  it("keeps close-all submitted when the postcondition is not yet visible", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    exchange.positions = [openPosition()];
    vi.spyOn(exchange, "closeAllPositions").mockResolvedValue({
      success: true,
    });
    const envelope = await new DraftService(
      store,
      new PreviewService(exchange),
      120,
    ).create({ kind: "CLOSE_ALL" }, "123", "123", "USDT");

    const result = await new ExecutionService(store, exchange, true).confirm(
      envelope.confirmationToken,
      "123",
      "123",
    );

    expect(result.state).toBe("SUBMITTED");
    expect(result.message).toContain("verification is pending");
  });

  it.each([
    ["leverage", ["5"]],
    ["mode", ["cross"]],
    ["market", ["BTC"]],
    ["order", ["limit", "95000"]],
    ["price", ["96000"]],
  ] as const)(
    "supports editing %s with a fresh version",
    async (field, values) => {
      const store = new MemoryStore();
      const exchange = new FakeExchange();
      const drafts = new DraftService(store, new PreviewService(exchange), 120);
      const initial = await drafts.create(
        {
          kind: "TRADE",
          symbolInput: "BTCUSDT",
          direction: "LONG",
          orderType: "MARKET",
          marginAmount: "100",
          requestedMarginAsset: "USDT",
          leverage: 10,
          marginMode: "ISOLATED",
        },
        "123",
        "123",
        "USDT",
      );
      const edited = await drafts.edit(
        { kind: "EDIT", draftId: initial.draft.id, field, values: [...values] },
        "123",
        "123",
        "USDT",
      );
      expect(edited.draft.version).toBe(2);
    },
  );

  it("returns a fresh confirmation instead of trading after a material price change", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    const initialPreview = new PreviewService(exchange);
    const drafts = new DraftService(store, initialPreview, 120);
    const initial = await drafts.create(
      {
        kind: "TRADE",
        symbolInput: "BTCUSDT",
        direction: "LONG",
        orderType: "MARKET",
        marginAmount: "100",
        requestedMarginAsset: "USDT",
        leverage: 10,
        marginMode: "ISOLATED",
      },
      "123",
      "123",
      "USDT",
    );
    vi.spyOn(exchange, "getBestBidAsk").mockResolvedValue({
      bestBid: "109900",
      bestAsk: "110000",
    });
    const execution = new ExecutionService(store, exchange, true, {
      authoritativePreview: new PreviewService(exchange),
      draftService: drafts,
      materialChangeBps: 25,
    });

    const result = await execution.confirm(
      initial.confirmationToken,
      "123",
      "123",
    );

    expect(result.state).toBe("FAILED");
    expect(result.message).toContain("Nothing was executed");
    expect(result.refreshedDraft?.draft.id).not.toBe(initial.draft.id);
    expect(result.refreshedDraft?.draft.preview.estimatedEntryPrice).toBe(
      "110000",
    );
    expect(exchange.placed).toHaveLength(0);

    const submitted = await execution.confirm(
      result.refreshedDraft?.confirmationToken as string,
      "123",
      "123",
    );
    expect(submitted.state).toBe("SUBMITTED");
    expect(exchange.placed).toHaveLength(1);
  });

  it("refreshes confirmation when available margin changes materially", async () => {
    const store = new MemoryStore();
    const exchange = new FakeExchange();
    const drafts = new DraftService(store, new PreviewService(exchange), 120);
    const initial = await drafts.create(
      {
        kind: "TRADE",
        symbolInput: "BTCUSDT",
        direction: "LONG",
        orderType: "LIMIT",
        limitPrice: "95000",
        marginAmount: "100",
        requestedMarginAsset: "USDT",
        leverage: 10,
        marginMode: "ISOLATED",
      },
      "123",
      "123",
      "USDT",
    );
    const originalWallet = exchange.getWallet.bind(exchange);
    vi.spyOn(exchange, "getWallet").mockImplementation(async (asset) => ({
      ...(await originalWallet(asset)),
      withdrawableBalance: "12000",
    }));
    const result = await new ExecutionService(store, exchange, true, {
      authoritativePreview: new PreviewService(exchange),
      draftService: drafts,
      materialChangeBps: 25,
    }).confirm(initial.confirmationToken, "123", "123");

    expect(result.state).toBe("FAILED");
    expect(result.message).toContain("free collateral");
    expect(result.refreshedDraft?.draft.preview.freeCollateralAfter).toBe(
      "11900",
    );
    expect(exchange.placed).toHaveLength(0);
  });
});
