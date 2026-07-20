export type Currency = "INR" | "USDT";
export type Direction = "LONG" | "SHORT";
export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type MarginMode = "ISOLATED" | "CROSS";
export type DraftStatus =
  | "DRAFTED"
  | "CONFIRMED"
  | "EXECUTING"
  | "SUBMITTED"
  | "RECONCILED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED"
  | "UNKNOWN";

export interface ContractFilter {
  filterType: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  notional?: string;
  limit?: number;
}

export interface Contract {
  symbol: string;
  contractName: string;
  contractType: "PERPETUAL";
  baseAsset: string;
  quoteAsset: Currency;
  marginAssetsSupported: Currency[];
  conversionRates: Record<string, string>;
  maxLeverage: number;
  pricePrecision: number;
  quantityPrecision: number;
  makerFeeRate: string;
  takerFeeRate: string;
  maintenanceMarginRate?: string;
  orderTypes: string[];
  filters: ContractFilter[];
  depthGroupings?: string[];
  tradeable: boolean;
}

export interface MarketQuote {
  symbol: string;
  bestBid?: string;
  bestAsk?: string;
  markPrice?: string;
  tickerPrice?: string;
  exchangeEventAt?: Date;
  receivedAt: Date;
  bookReceivedAt?: Date;
  markReceivedAt?: Date;
  tickerReceivedAt?: Date;
  firstUpdateId?: string;
  lastUpdateId?: string;
  previousUpdateId?: string;
}

export interface OrderBook {
  symbol: string;
  bestBid: string;
  bestAsk: string;
  eventTime?: Date;
}

export interface FuturesWallet {
  marginAsset: Currency;
  walletBalance: string;
  withdrawableBalance: string;
  lockedBalance: string;
  marginBalance: string;
  maintenanceMargin: string;
  unrealisedPnlCross: string;
  unrealisedPnlIsolated: string;
}

export interface Position {
  positionId: string;
  symbol: string;
  status: "OPEN" | "CLOSED" | "LIQUIDATED";
  direction: Direction;
  marginMode: MarginMode;
  marginAsset: Currency;
  quoteAsset: Currency;
  baseAsset: string;
  entryPrice: string;
  liquidationPrice: string;
  margin: string;
  marginInMarginAsset: string;
  quantity: string;
  positionSize: string;
  leverage: number;
  realisedProfit?: string;
  unrealisedProfit?: string;
  /** True when unrealisedProfit was estimated by the bot, not supplied by Shark. */
  unrealisedProfitEstimated?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExchangeOrder {
  clientOrderId: string;
  symbol: string;
  type: string;
  side: OrderSide;
  price: string;
  orderAmount: string;
  filledAmount: string;
  reduceOnly?: boolean;
  status?: string;
  leverage?: number;
  lockedMargin?: string;
  marginAsset?: Currency;
  positionId?: string;
  createdAt?: Date;
  raw?: unknown;
}

export interface TradeFill {
  exchangeFillId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  orderType: string;
  price: string;
  quantity: string;
  fee: string;
  realisedProfit: string;
  marginAsset: Currency;
  occurredAt: Date;
}

export interface TransactionEvent {
  exchangeEventId: string;
  type: string;
  amount: string;
  asset: Currency;
  symbol?: string;
  occurredAt: Date;
}

export interface TradeIntent {
  kind: "TRADE";
  symbolInput: string;
  symbol?: string;
  direction: Direction;
  orderType: OrderType;
  limitPrice?: string;
  marginAmount: string;
  requestedMarginAsset: Currency;
  leverage: number;
  marginMode: MarginMode;
}

export interface CloseIntent {
  kind: "CLOSE";
  symbolInput: string;
  symbol?: string;
  orderType: OrderType;
  limitPrice?: string;
}

export interface CloseAllIntent {
  kind: "CLOSE_ALL";
}

export interface CancelOrdersIntent {
  kind: "CANCEL_ORDERS";
  symbolInput?: string;
  symbol?: string;
}

export interface ProtectionIntent {
  kind: "PROTECTION";
  protectionType: "STOP_LOSS" | "TAKE_PROFIT";
  symbolInput: string;
  symbol?: string;
  price: string;
}

export interface CancelOrderIntent {
  kind: "CANCEL_ORDER";
  clientOrderId: string;
}

export type MutatingIntent =
  | TradeIntent
  | CloseIntent
  | CloseAllIntent
  | CancelOrdersIntent
  | ProtectionIntent
  | CancelOrderIntent;

export interface PreviewLine {
  label: string;
  value: string;
}

export interface DraftPreview {
  title: string;
  summary: string;
  lines: PreviewLine[];
  warnings: string[];
  calculatedAt: Date;
  contract?: Contract;
  positionIds?: string[];
  estimatedQuantity?: string;
  estimatedEntryPrice?: string;
  referenceMarkPrice?: string;
  estimatedNotional?: string;
  estimatedFee?: string;
  estimatedLiquidationPrice?: string;
  freeCollateralAfter?: string;
}

export interface TradeDraft {
  id: string;
  version: number;
  status: DraftStatus;
  userId: string;
  chatId: string;
  intent: MutatingIntent;
  preview: DraftPreview;
  payloadHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Confirmation {
  tokenHash: string;
  draftId: string;
  draftVersion: number;
  userId: string;
  chatId: string;
  payloadHash: string;
  expiresAt: Date;
  consumedAt?: Date;
}

export interface ExecutionAttempt {
  id: string;
  draftId: string;
  draftVersion: number;
  clientOrderId?: string;
  requestHash: string;
  state: "EXECUTING" | "SUBMITTED" | "RECONCILED" | "FAILED" | "UNKNOWN";
  exchangeOrderId?: string;
  result?: unknown;
  errorCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Principal {
  userId: string;
  chatId: string;
  defaultMarket: Currency;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditEvent {
  id: string;
  actorUserId?: string;
  actorChatId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  outcome: string;
  metadata: Record<string, unknown>;
  previousHash?: string;
  eventHash: string;
  createdAt: Date;
}

export interface PnlSummary {
  start: Date | null;
  end: Date;
  realisedProfit: Record<Currency, string>;
  fees: Record<Currency, string>;
  funding: Record<Currency, string>;
  netRealised: Record<Currency, string>;
  unrealised: Record<Currency, string>;
}
