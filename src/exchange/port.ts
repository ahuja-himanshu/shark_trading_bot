import type {
  Contract,
  Currency,
  ExchangeOrder,
  FuturesWallet,
  MarginMode,
  OrderSide,
  Position,
  TradeFill,
  TransactionEvent,
} from "../domain/types.js";

export interface HistoryFilter {
  start?: Date;
  end?: Date;
  symbol?: string;
  pageSize?: number;
  sortOrder?: "asc" | "desc";
}

export interface PlaceOrderRequest {
  placeType: "ORDER_FORM" | "POSITION";
  positionId?: string;
  quantity: string;
  side: OrderSide;
  symbol: string;
  reduceOnly: boolean;
  marginAsset: Currency;
  type: "MARKET" | "LIMIT" | "STOP_MARKET" | "STOP_LIMIT";
  price?: string;
  stopPrice?: string;
}

export interface ProtectionRequest {
  positionId: string;
  takeProfits?: Array<{ quantity: string; price: string }>;
  stopLosses?: Array<{ quantity: string; price: string }>;
}

export interface SharkExchangePort {
  getContracts(market?: Currency): Promise<Contract[]>;
  getBestBidAsk(symbol: string): Promise<{ bestBid: string; bestAsk: string }>;
  getWallet(marginAsset: Currency): Promise<FuturesWallet>;
  getPositions(status?: Position["status"]): Promise<Position[]>;
  getPosition(positionId: string): Promise<Position | null>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getOrder(clientOrderId: string): Promise<ExchangeOrder | null>;
  getTradeHistory(filter?: HistoryFilter): Promise<TradeFill[]>;
  getTransactionHistory(filter?: HistoryFilter): Promise<TransactionEvent[]>;
  createListenKey(): Promise<string>;
  renewListenKey(): Promise<void>;
  deleteListenKey(): Promise<void>;
  updatePreference(
    symbol: string,
    leverage: number,
    marginMode: MarginMode,
  ): Promise<unknown>;
  placeOrder(request: PlaceOrderRequest): Promise<ExchangeOrder>;
  cancelOrder(clientOrderId: string): Promise<unknown>;
  cancelAllOrders(): Promise<unknown>;
  closeAllPositions(): Promise<unknown>;
  setProtection(request: ProtectionRequest): Promise<unknown>;
}
