import { Decimal } from "decimal.js";
import type {
  Contract,
  ContractFilter,
  Currency,
  ExchangeOrder,
  FuturesWallet,
  MarginMode,
  Position,
  TradeFill,
  TransactionEvent,
} from "../domain/types.js";
import { hmacSha256, stableJson } from "../security/crypto.js";
import type {
  HistoryFilter,
  PlaceOrderRequest,
  ProtectionRequest,
  SharkExchangePort,
} from "./port.js";

export class SharkApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SharkApiError";
  }
}

interface SharkClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

type QueryValue = string | number | boolean | undefined;

export class SharkClient implements SharkExchangePort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  public constructor(options: SharkClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async getContracts(market?: Currency): Promise<Contract[]> {
    const response = await this.request("GET", "/v1/exchange/exchangeInfo", {
      public: true,
      query: market ? { market } : {},
    });
    return normaliseContracts(unwrap(response));
  }

  public async getBestBidAsk(
    symbol: string,
  ): Promise<{ bestBid: string; bestAsk: string }> {
    const response = await this.request(
      "GET",
      `/v1/market/depth/${encodeURIComponent(symbol)}`,
      { public: true },
    );
    const data = asRecord(unwrap(response));
    // Shark does not guarantee depth row ordering (live responses return
    // bids ascending by price), so select true best prices instead of
    // trusting row position.
    const bestBid = bestBookPrice(asRows(data.b ?? data.bids), "BID");
    const bestAsk = bestBookPrice(asRows(data.a ?? data.asks), "ASK");
    if (!bestBid || !bestAsk) {
      throw new SharkApiError(
        `Shark returned no usable order book for ${symbol}`,
        undefined,
        "INVALID_DEPTH_RESPONSE",
        true,
      );
    }
    return { bestBid, bestAsk };
  }

  public async getWallet(marginAsset: Currency): Promise<FuturesWallet> {
    const data = asRecord(
      unwrap(
        await this.request("GET", "/v1/wallet/futures-wallet/details", {
          query: { marginAsset },
        }),
      ),
    );
    return {
      marginAsset: currency(data.marginAsset ?? marginAsset),
      walletBalance: responseDecimal(data.walletBalance, "walletBalance"),
      withdrawableBalance: responseDecimal(
        data.withdrawableBalance,
        "withdrawableBalance",
      ),
      lockedBalance: responseDecimal(data.lockedBalance, "lockedBalance"),
      marginBalance: responseDecimal(data.marginBalance, "marginBalance"),
      maintenanceMargin: responseDecimal(
        data.maintenanceMargin,
        "maintenanceMargin",
      ),
      unrealisedPnlCross: responseDecimal(
        data.unrealisedPnlCross,
        "unrealisedPnlCross",
      ),
      unrealisedPnlIsolated: responseDecimal(
        data.unrealisedPnlIsolated,
        "unrealisedPnlIsolated",
      ),
    };
  }

  public async getPositions(
    status: Position["status"] = "OPEN",
  ): Promise<Position[]> {
    const response = await this.request("GET", `/v1/positions/${status}`, {
      query: { pageSize: "100", sortOrder: "desc" },
    });
    return asArray(unwrap(response)).map(normalisePosition);
  }

  public async getPosition(positionId: string): Promise<Position | null> {
    const response = await this.request("GET", "/v1/positions", {
      query: { positionId },
    });
    const entries = asArray(unwrap(response));
    return entries.length > 0 ? normalisePosition(entries[0]) : null;
  }

  public async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    const response = await this.request("GET", "/v1/order/open-orders", {
      query: { pageSize: "100", sortOrder: "desc", symbol },
    });
    return asArray(unwrap(response)).map(normaliseOrder);
  }

  public async getOrder(clientOrderId: string): Promise<ExchangeOrder | null> {
    const response = await this.request(
      "GET",
      `/v1/order/${encodeURIComponent(clientOrderId)}`,
    );
    const raw = unwrap(response);
    if (raw === null || raw === undefined) return null;
    const entries = Array.isArray(raw) ? raw : [raw];
    return entries.length > 0 ? normaliseOrder(entries[0]) : null;
  }

  public async getTradeHistory(
    filter: HistoryFilter = {},
  ): Promise<TradeFill[]> {
    const response = await this.request("GET", "/v1/user-data/trade-history", {
      query: historyQuery(filter),
    });
    return asArray(unwrap(response)).map(normaliseFill);
  }

  public async getTransactionHistory(
    filter: HistoryFilter = {},
  ): Promise<TransactionEvent[]> {
    const response = await this.request(
      "GET",
      "/v1/user-data/transaction-history",
      { query: historyQuery(filter) },
    );
    return asArray(unwrap(response)).map(normaliseTransaction);
  }

  public async createListenKey(): Promise<string> {
    const response = asRecord(
      unwrap(await this.request("POST", "/v1/retail/listen-key", { body: {} })),
    );
    return requiredString(response.listenKey, "listenKey");
  }

  public async renewListenKey(): Promise<void> {
    await this.request("PUT", "/v1/retail/listen-key", { body: {} });
  }

  public async deleteListenKey(): Promise<void> {
    await this.request("DELETE", "/v1/retail/listen-key", { body: {} });
  }

  public async updatePreference(
    symbol: string,
    leverage: number,
    marginMode: MarginMode,
  ): Promise<unknown> {
    return this.request("POST", "/v1/exchange/update/preference", {
      body: { contractName: symbol, leverage, marginMode },
    });
  }

  public async placeOrder(request: PlaceOrderRequest): Promise<ExchangeOrder> {
    const response = await this.request("POST", "/v1/order/place-order", {
      body: {
        ...request,
        quantity: apiNumber(request.quantity, "quantity"),
        ...(request.price === undefined
          ? {}
          : { price: apiNumber(request.price, "price") }),
        ...(request.stopPrice === undefined
          ? {}
          : { stopPrice: apiNumber(request.stopPrice, "stopPrice") }),
        deviceType: "WEB",
        userCategory: "EXTERNAL",
      },
      ambiguousMutation: true,
    });
    return normaliseOrder(unwrap(response));
  }

  public async cancelOrder(clientOrderId: string): Promise<unknown> {
    return this.request("DELETE", "/v1/order/delete-order", {
      body: { clientOrderId },
      ambiguousMutation: true,
    });
  }

  public async cancelAllOrders(): Promise<unknown> {
    return this.request("DELETE", "/v1/order/cancel-all-orders", {
      body: {},
      ambiguousMutation: true,
    });
  }

  public async closeAllPositions(): Promise<unknown> {
    return this.request("DELETE", "/v1/positions/close-all-positions", {
      body: {},
      ambiguousMutation: true,
    });
  }

  public async setProtection(request: ProtectionRequest): Promise<unknown> {
    return this.request("POST", "/v2/order/split-tp-sl", {
      body: {
        positionId: request.positionId,
        splitTakeProfitOrders: (request.takeProfits ?? []).map((leg) => ({
          quantity: apiNumber(leg.quantity, "take-profit quantity"),
          price: apiNumber(leg.price, "take-profit price"),
        })),
        splitStopLossOrders: (request.stopLosses ?? []).map((leg) => ({
          quantity: apiNumber(leg.quantity, "stop-loss quantity"),
          price: apiNumber(leg.price, "stop-loss price"),
        })),
      },
      ambiguousMutation: true,
    });
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: {
      public?: boolean;
      query?: Record<string, QueryValue>;
      body?: Record<string, unknown>;
      ambiguousMutation?: boolean;
    } = {},
  ): Promise<unknown> {
    const queryEntries = Object.entries(options.query ?? {})
      .filter(
        (entry): entry is [string, string | number | boolean] =>
          entry[1] !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right));

    let bodyText: string | undefined;
    if (!options.public && method === "GET") {
      queryEntries.push(["timestamp", String(this.now())]);
      queryEntries.sort(([left], [right]) => left.localeCompare(right));
    } else if (!options.public) {
      bodyText = stableJson({
        ...(options.body ?? {}),
        timestamp: String(this.now()),
      });
    } else if (options.body) {
      bodyText = stableJson(options.body);
    }

    const query = new URLSearchParams(
      queryEntries.map(([key, value]) => [key, String(value)]),
    ).toString();
    const headers: Record<string, string> = { accept: "application/json" };
    if (bodyText !== undefined) headers["content-type"] = "application/json";
    if (!options.public) {
      const signed = method === "GET" ? query : (bodyText ?? "");
      headers["api-key"] = this.apiKey;
      headers.signature = hmacSha256(this.apiSecret, signed);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    let rawText: string;
    try {
      response = await this.fetchFn(
        `${this.baseUrl}${path}${query ? `?${query}` : ""}`,
        {
          method,
          headers,
          ...(bodyText === undefined ? {} : { body: bodyText }),
          signal: controller.signal,
        },
      );
      rawText = await response.text();
    } catch (error) {
      const ambiguous = options.ambiguousMutation === true;
      throw new SharkApiError(
        error instanceof Error ? error.message : "Shark request failed",
        undefined,
        ambiguous ? "AMBIGUOUS_MUTATION" : "NETWORK_ERROR",
        !ambiguous,
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }

    let responseBody: unknown = null;
    if (rawText) {
      try {
        responseBody = JSON.parse(rawText) as unknown;
      } catch {
        responseBody = { message: "Non-JSON response from Shark" };
      }
    }

    if (!response.ok) {
      const record = asRecord(responseBody);
      const code =
        valueString(record.code ?? record.errorCode) ||
        `HTTP_${response.status}`;
      const message =
        valueString(record.message ?? record.error) ||
        `Shark request failed (${response.status})`;
      throw new SharkApiError(
        message,
        response.status,
        code,
        response.status >= 500,
      );
    }
    return responseBody;
  }
}

function historyQuery(filter: HistoryFilter): Record<string, QueryValue> {
  return {
    startTimestamp: filter.start?.getTime(),
    endTimestamp: filter.end?.getTime(),
    symbol: filter.symbol,
    pageSize: filter.pageSize ?? 100,
    sortOrder: filter.sortOrder ?? "desc",
  };
}

function unwrap(value: unknown): unknown {
  const record = asRecord(value);
  return Object.hasOwn(record, "data") ? record.data : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  for (const key of ["items", "rows", "list", "contracts"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return Object.keys(record).length > 0 ? [record] : [];
}

function asRows(value: unknown): unknown[][] {
  return Array.isArray(value) ? value.filter(Array.isArray) : [];
}

function bestBookPrice(rows: unknown[][], side: "BID" | "ASK"): string {
  let best: Decimal | undefined;
  for (const row of rows) {
    const priceText = valueString(row[0]);
    const quantityText = valueString(row[1]);
    if (!priceText || !quantityText) continue;
    try {
      const price = new Decimal(priceText);
      const quantity = new Decimal(quantityText);
      if (!price.isFinite() || price.lte(0)) continue;
      if (!quantity.isFinite() || quantity.lte(0)) continue;
      if (!best || (side === "BID" ? price.gt(best) : price.lt(best))) {
        best = price;
      }
    } catch {
      continue;
    }
  }
  return best?.toString() ?? "";
}

function valueString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function requiredString(value: unknown, field: string): string {
  const parsed = valueString(value);
  if (!parsed) {
    throw new SharkApiError(
      `Missing ${field} in Shark response`,
      undefined,
      "INVALID_API_RESPONSE",
      false,
    );
  }
  return parsed;
}

function responseDecimal(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  try {
    const parsed = new Decimal(raw);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed.toString();
  } catch {
    throw new SharkApiError(
      `Invalid ${field} in Shark response`,
      undefined,
      "INVALID_API_RESPONSE",
      false,
    );
  }
}

function responseInteger(value: unknown, field: string): number {
  const raw = requiredString(value, field);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SharkApiError(
      `Invalid ${field} in Shark response`,
      undefined,
      "INVALID_API_RESPONSE",
      false,
    );
  }
  return parsed;
}

function responseEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  const parsed = requiredString(value, field).toUpperCase();
  if (!allowed.includes(parsed)) {
    throw new SharkApiError(
      `Invalid ${field} in Shark response`,
      undefined,
      "INVALID_API_RESPONSE",
      false,
    );
  }
  return parsed as T[number];
}

function currency(value: unknown): Currency {
  const parsed = valueString(value).toUpperCase();
  if (parsed !== "INR" && parsed !== "USDT") {
    throw new SharkApiError(
      `Unsupported currency returned by Shark: ${parsed || "empty"}`,
      undefined,
      "UNSUPPORTED_CURRENCY",
      false,
    );
  }
  return parsed;
}

function date(value: unknown): Date {
  const parsed =
    typeof value === "number" ? new Date(value) : new Date(valueString(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new SharkApiError(
      "Invalid timestamp in Shark response",
      undefined,
      "INVALID_API_RESPONSE",
      false,
    );
  }
  return parsed;
}

function normaliseContracts(value: unknown): Contract[] {
  const root = asRecord(value);
  let rawContracts: unknown[] = [];
  const conversionRates: Record<string, string> = {};
  collectConversionRates(root.conversionRates, conversionRates);
  if (Array.isArray(value)) rawContracts = value;
  else if (Array.isArray(root.contracts)) rawContracts = root.contracts;
  else {
    for (const marketValue of Object.values(root)) {
      const market = asRecord(marketValue);
      collectConversionRates(market.conversionRates, conversionRates);
      if (Array.isArray(market.contracts))
        rawContracts.push(...asArray(market.contracts));
    }
  }
  return rawContracts
    .filter(
      (item) =>
        valueString(asRecord(item).contractType).toUpperCase() === "PERPETUAL",
    )
    .map((item) => {
      const raw = asRecord(item);
      const filters = asArray(raw.filters).map((filter): ContractFilter => {
        const record = asRecord(filter);
        const result: ContractFilter = {
          filterType: valueString(record.filterType),
        };
        const minQty = valueString(record.minQty);
        const maxQty = valueString(record.maxQty);
        const stepSize = valueString(record.stepSize);
        const minPrice = valueString(record.minPrice);
        const maxPrice = valueString(record.maxPrice);
        const tickSize = valueString(record.tickSize);
        const notional = valueString(record.notional);
        if (minQty) result.minQty = responseDecimal(minQty, "filter minQty");
        if (maxQty) result.maxQty = responseDecimal(maxQty, "filter maxQty");
        if (stepSize)
          result.stepSize = responseDecimal(stepSize, "filter stepSize");
        if (minPrice)
          result.minPrice = responseDecimal(minPrice, "filter minPrice");
        if (maxPrice)
          result.maxPrice = responseDecimal(maxPrice, "filter maxPrice");
        if (tickSize)
          result.tickSize = responseDecimal(tickSize, "filter tickSize");
        if (notional)
          result.notional = responseDecimal(notional, "filter notional");
        if (typeof record.limit === "number") result.limit = record.limit;
        return result;
      });
      const quoteAsset = currency(raw.quoteAsset ?? raw.market);
      const marginAssets = Array.isArray(raw.marginAssetsSupported)
        ? raw.marginAssetsSupported.map(currency)
        : [quoteAsset];
      const contract: Contract = {
        symbol: requiredString(
          raw.name ?? raw.symbol,
          "contract symbol",
        ).toUpperCase(),
        contractName: valueString(raw.contractName) || valueString(raw.name),
        contractType: "PERPETUAL",
        baseAsset: requiredString(raw.baseAsset, "baseAsset").toUpperCase(),
        quoteAsset,
        marginAssetsSupported: marginAssets,
        conversionRates: { ...conversionRates },
        maxLeverage: responseInteger(raw.maxLeverage, "maxLeverage"),
        pricePrecision: responseInteger(raw.pricePrecision, "pricePrecision"),
        quantityPrecision: responseInteger(
          raw.quantityPrecision,
          "quantityPrecision",
        ),
        makerFeeRate: percentageToRate(raw.makerFee),
        takerFeeRate: percentageToRate(raw.takerFee),
        orderTypes: Array.isArray(raw.orderTypes)
          ? raw.orderTypes.map(String)
          : [],
        filters,
        tradeable:
          raw.status === undefined ||
          valueString(raw.status).toUpperCase() !== "DISABLED",
      };
      if (Array.isArray(raw.depthGrouping)) {
        const groupings = raw.depthGrouping
          .map(valueString)
          .filter((value) => value.length > 0);
        if (groupings.length > 0) contract.depthGroupings = groupings;
      }
      const maintenanceMarginRate = valueString(
        raw.maintenanceMarginPercentage,
      );
      if (!maintenanceMarginRate) {
        throw new SharkApiError(
          `Missing maintenance margin for ${contract.symbol}`,
          undefined,
          "INVALID_API_RESPONSE",
          false,
        );
      }
      if (contract.orderTypes.length === 0) {
        throw new SharkApiError(
          `Missing order types for ${contract.symbol}`,
          undefined,
          "INVALID_API_RESPONSE",
          false,
        );
      }
      contract.maintenanceMarginRate = responseDecimal(
        maintenanceMarginRate,
        "maintenanceMarginPercentage",
      );
      return contract;
    });
}

function percentageToRate(value: unknown): string {
  const parsed = requiredString(value, "fee percentage");
  try {
    return new Decimal(parsed).dividedBy(100).toString();
  } catch {
    throw new SharkApiError(
      `Invalid fee percentage returned by Shark: ${parsed}`,
      undefined,
      "INVALID_API_RESPONSE",
      false,
    );
  }
}

function apiNumber(value: string, field: string): number {
  try {
    const parsed = new Decimal(value);
    const converted = parsed.toNumber();
    if (
      !parsed.isFinite() ||
      !Number.isFinite(converted) ||
      !new Decimal(converted).eq(parsed)
    ) {
      throw new Error("not finite");
    }
    return converted;
  } catch {
    throw new SharkApiError(
      `Invalid numeric ${field} for Shark request`,
      undefined,
      "INVALID_REQUEST",
      false,
    );
  }
}

function collectConversionRates(
  value: unknown,
  target: Record<string, string>,
): void {
  const record = asRecord(value);
  for (const [key, rate] of Object.entries(record)) {
    const parsed = valueString(rate);
    if (parsed) target[key] = parsed;
  }
}

export function normalisePosition(value: unknown): Position {
  const raw = asRecord(value);
  const createdAt = date(raw.createdAt ?? raw.createdTime);
  const updatedAt = date(
    raw.updatedAt ?? raw.updatedTime ?? raw.createdAt ?? raw.createdTime,
  );
  const position: Position = {
    positionId: requiredString(raw.positionId, "positionId"),
    symbol: requiredString(
      raw.contractPair ?? raw.symbol,
      "contractPair",
    ).toUpperCase(),
    status: responseEnum(
      raw.positionStatus,
      ["OPEN", "CLOSED", "LIQUIDATED"] as const,
      "positionStatus",
    ),
    direction: responseEnum(
      raw.positionType,
      ["LONG", "SHORT"] as const,
      "positionType",
    ),
    marginMode: responseEnum(
      raw.marginType,
      ["ISOLATED", "CROSS"] as const,
      "marginType",
    ),
    marginAsset: currency(raw.marginAsset),
    quoteAsset: currency(raw.quoteAsset ?? raw.marginAsset),
    baseAsset: requiredString(raw.baseAsset, "baseAsset").toUpperCase(),
    entryPrice: responseDecimal(raw.entryPrice, "entryPrice"),
    liquidationPrice: responseDecimal(raw.liquidationPrice, "liquidationPrice"),
    margin: responseDecimal(raw.margin, "margin"),
    marginInMarginAsset: responseDecimal(
      raw.marginInMarginAsset ?? raw.margin,
      "marginInMarginAsset",
    ),
    quantity: responseDecimal(
      raw.quantity ?? raw.positionAmount,
      "position quantity",
    ),
    positionSize: responseDecimal(raw.positionSize, "positionSize"),
    leverage: responseInteger(raw.leverage, "leverage"),
    createdAt,
    updatedAt,
  };
  const realised = valueString(raw.realizedProfit ?? raw.realisedProfit);
  const unrealised = valueString(
    raw.unrealizedProfit ?? raw.unrealisedProfit ?? raw.unrealisedPnl,
  );
  if (realised)
    position.realisedProfit = responseDecimal(realised, "realisedProfit");
  if (unrealised)
    position.unrealisedProfit = responseDecimal(unrealised, "unrealisedProfit");
  return position;
}

export function normaliseOrder(value: unknown): ExchangeOrder {
  const raw = asRecord(value);
  const order: ExchangeOrder = {
    clientOrderId: requiredString(raw.clientOrderId, "clientOrderId"),
    symbol: requiredString(raw.symbol, "symbol").toUpperCase(),
    type: requiredString(raw.type, "order type"),
    side: responseEnum(raw.side, ["BUY", "SELL"] as const, "order side"),
    price: responseDecimal(raw.price ?? 0, "order price"),
    orderAmount: responseDecimal(
      raw.orderAmount ?? raw.origQty ?? raw.quantity,
      "order amount",
    ),
    filledAmount: responseDecimal(
      raw.filledAmount ?? raw.executedQty ?? 0,
      "filled amount",
    ),
    raw: value,
  };
  if (typeof raw.reduceOnly === "boolean") order.reduceOnly = raw.reduceOnly;
  const status = valueString(raw.status);
  if (status) order.status = status;
  if (raw.leverage !== undefined)
    order.leverage = responseInteger(raw.leverage, "order leverage");
  const lockedMargin = valueString(
    raw.lockedMarginInMarginAsset ?? raw.lockedMargin,
  );
  if (lockedMargin)
    order.lockedMargin = responseDecimal(lockedMargin, "locked margin");
  if (raw.marginAsset) order.marginAsset = currency(raw.marginAsset);
  const positionId = valueString(raw.positionId);
  if (positionId) order.positionId = positionId;
  if (raw.time ?? raw.createdAt)
    order.createdAt = date(raw.time ?? raw.createdAt);
  return order;
}

export function normaliseFill(value: unknown): TradeFill {
  const raw = asRecord(value);
  return {
    exchangeFillId: requiredString(raw.id, "trade id"),
    clientOrderId: requiredString(raw.clientOrderId, "clientOrderId"),
    symbol: requiredString(raw.symbol, "symbol").toUpperCase(),
    side: responseEnum(raw.side, ["BUY", "SELL"] as const, "trade side"),
    orderType: requiredString(raw.type, "trade order type"),
    price: responseDecimal(raw.price, "trade price"),
    quantity: responseDecimal(raw.quantity, "trade quantity"),
    fee: responseDecimal(raw.fee ?? 0, "trade fee"),
    realisedProfit: responseDecimal(
      raw.realizedProfit ?? raw.realisedProfit ?? 0,
      "realised profit",
    ),
    marginAsset: currency(raw.marginAsset ?? raw.quoteAsset),
    occurredAt: date(raw.time),
  };
}

export function normaliseTransaction(value: unknown): TransactionEvent {
  const raw = asRecord(value);
  const event: TransactionEvent = {
    exchangeEventId: requiredString(raw.id, "transaction id"),
    type: requiredString(raw.type, "transaction type").toUpperCase(),
    amount: responseDecimal(raw.amount, "transaction amount"),
    asset: currency(raw.asset),
    occurredAt: date(raw.time),
  };
  const symbol = valueString(raw.symbol);
  if (symbol) event.symbol = symbol.toUpperCase();
  return event;
}
