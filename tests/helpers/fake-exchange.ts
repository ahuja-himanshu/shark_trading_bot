import type {
  Contract,
  Currency,
  ExchangeOrder,
  FuturesWallet,
  MarginMode,
  Position,
  TradeFill,
  TransactionEvent,
} from "../../src/domain/types.js";
import type {
  HistoryFilter,
  PlaceOrderRequest,
  ProtectionRequest,
  SharkExchangePort,
} from "../../src/exchange/port.js";

export const BTC_INR: Contract = {
  symbol: "BTCINR",
  contractName: "Bitcoin",
  contractType: "PERPETUAL",
  baseAsset: "BTC",
  quoteAsset: "INR",
  marginAssetsSupported: ["INR"],
  conversionRates: {},
  maxLeverage: 20,
  pricePrecision: 0,
  quantityPrecision: 4,
  makerFeeRate: "0.0002",
  takerFeeRate: "0.0005",
  maintenanceMarginRate: "1",
  orderTypes: ["MARKET", "LIMIT", "STOP_MARKET", "STOP_LIMIT"],
  filters: [
    { filterType: "MARKET_QTY_SIZE", minQty: "0.0001", maxQty: "10" },
    { filterType: "LIMIT_QTY_SIZE", minQty: "0.0001", maxQty: "10" },
    { filterType: "MIN_NOTIONAL", notional: "100" },
  ],
  tradeable: true,
};

export const BTC_USDT: Contract = {
  ...BTC_INR,
  symbol: "BTCUSDT",
  quoteAsset: "USDT",
  marginAssetsSupported: ["USDT", "INR"],
  conversionRates: { INR_MARGIN_USDT: "90" },
  pricePrecision: 2,
};

export function openPosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "position-1",
    symbol: "BTCUSDT",
    status: "OPEN",
    direction: "LONG",
    marginMode: "ISOLATED",
    marginAsset: "USDT",
    quoteAsset: "USDT",
    baseAsset: "BTC",
    entryPrice: "90000",
    liquidationPrice: "81000",
    margin: "100",
    marginInMarginAsset: "100",
    quantity: "0.01",
    positionSize: "1000",
    leverage: 10,
    unrealisedProfit: "25",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

/** An open position as Shark actually returns it: no unrealised P&L field. */
export function openPositionWithoutUnrealisedPnl(
  overrides: Partial<Position> = {},
): Position {
  const position = openPosition(overrides);
  delete position.unrealisedProfit;
  return position;
}

/** Emulates Shark's time-filtered, sorted, single-page history responses. */
function paged<T extends { occurredAt: Date }>(
  rows: T[],
  filter: HistoryFilter,
): T[] {
  const filtered = rows.filter(
    (row) =>
      (!filter.start || row.occurredAt >= filter.start) &&
      (!filter.end || row.occurredAt <= filter.end),
  );
  filtered.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (filter.sortOrder === "desc") filtered.reverse();
  return structuredClone(filtered.slice(0, filter.pageSize ?? 100));
}

export class FakeExchange implements SharkExchangePort {
  public contracts = [BTC_INR, BTC_USDT];
  public positions: Position[] = [];
  public orders: ExchangeOrder[] = [];
  public fills: TradeFill[] = [];
  public transactions: TransactionEvent[] = [];
  public placed: PlaceOrderRequest[] = [];
  public preferences: Array<{
    symbol: string;
    leverage: number;
    marginMode: MarginMode;
  }> = [];
  public protections: ProtectionRequest[] = [];
  public cancelled: string[] = [];
  public closeAllCalls = 0;
  public listenKeyCreates = 0;
  public listenKeyRenewals = 0;
  public listenKeyDeletes = 0;
  public failingWallets = new Set<Currency>();

  public async getContracts(): Promise<Contract[]> {
    return structuredClone(this.contracts);
  }
  public async getBestBidAsk(
    symbol: string,
  ): Promise<{ bestBid: string; bestAsk: string }> {
    return symbol.endsWith("USDT")
      ? { bestBid: "99900", bestAsk: "100000" }
      : { bestBid: "8990000", bestAsk: "9000000" };
  }
  public async getWallet(marginAsset: Currency): Promise<FuturesWallet> {
    if (this.failingWallets.has(marginAsset)) {
      throw new Error(`Shark request failed (HTTP_400)`);
    }
    return {
      marginAsset,
      walletBalance: "20000",
      withdrawableBalance: "15000",
      lockedBalance: "500",
      marginBalance: "20025",
      maintenanceMargin: "10",
      unrealisedPnlCross: "0",
      unrealisedPnlIsolated: "25",
    };
  }
  public async getPositions(
    status: Position["status"] = "OPEN",
  ): Promise<Position[]> {
    return structuredClone(
      this.positions.filter((position) => position.status === status),
    );
  }
  public async getPosition(positionId: string): Promise<Position | null> {
    return structuredClone(
      this.positions.find((position) => position.positionId === positionId) ??
        null,
    );
  }
  public async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    return structuredClone(
      symbol
        ? this.orders.filter((order) => order.symbol === symbol)
        : this.orders,
    );
  }
  public async getOrder(clientOrderId: string): Promise<ExchangeOrder | null> {
    return structuredClone(
      this.orders.find((order) => order.clientOrderId === clientOrderId) ??
        null,
    );
  }
  public async getTradeHistory(filter?: HistoryFilter): Promise<TradeFill[]> {
    return paged(this.fills, filter ?? {});
  }
  public async getTransactionHistory(
    filter?: HistoryFilter,
  ): Promise<TransactionEvent[]> {
    return paged(this.transactions, filter ?? {});
  }
  public async createListenKey(): Promise<string> {
    this.listenKeyCreates += 1;
    return "test-listen-key-1234567890";
  }
  public async renewListenKey(): Promise<void> {
    this.listenKeyRenewals += 1;
  }
  public async deleteListenKey(): Promise<void> {
    this.listenKeyDeletes += 1;
  }
  public async updatePreference(
    symbol: string,
    leverage: number,
    marginMode: MarginMode,
  ): Promise<unknown> {
    this.preferences.push({ symbol, leverage, marginMode });
    return { ok: true };
  }
  public async placeOrder(request: PlaceOrderRequest): Promise<ExchangeOrder> {
    this.placed.push(structuredClone(request));
    return {
      clientOrderId: `order-${this.placed.length}`,
      symbol: request.symbol,
      type: request.type,
      side: request.side,
      price: request.price ?? "100000",
      orderAmount: request.quantity,
      filledAmount: request.type === "MARKET" ? request.quantity : "0",
      reduceOnly: request.reduceOnly,
      marginAsset: request.marginAsset,
      ...(request.positionId ? { positionId: request.positionId } : {}),
    };
  }
  public async cancelOrder(clientOrderId: string): Promise<unknown> {
    this.cancelled.push(clientOrderId);
    this.orders = this.orders.filter(
      (order) => order.clientOrderId !== clientOrderId,
    );
    return { clientOrderId, status: "CANCELLED" };
  }
  public async cancelAllOrders(): Promise<unknown> {
    this.cancelled.push("ALL");
    this.orders = [];
    return { success: true };
  }
  public async closeAllPositions(): Promise<unknown> {
    this.closeAllCalls += 1;
    this.positions = this.positions.map((position) => ({
      ...position,
      status: "CLOSED",
    }));
    return { success: true };
  }
  public async setProtection(request: ProtectionRequest): Promise<unknown> {
    this.protections.push(structuredClone(request));
    return { success: true };
  }
}
