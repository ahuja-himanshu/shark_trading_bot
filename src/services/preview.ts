import { Decimal } from "decimal.js";
import type {
  CloseIntent,
  Contract,
  Currency,
  DraftPreview,
  MutatingIntent,
  Position,
  TradeIntent,
} from "../domain/types.js";
import type { SharkExchangePort } from "../exchange/port.js";
import type { BestBidAskSource } from "./market-data.js";

export class PreviewError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PreviewError";
  }
}

export class PreviewService {
  private readonly marketData: BestBidAskSource;

  public constructor(
    private readonly exchange: SharkExchangePort,
    private readonly now: () => Date = () => new Date(),
    marketData?: BestBidAskSource,
  ) {
    this.marketData = marketData ?? exchange;
  }

  public async calculate(
    originalIntent: MutatingIntent,
    defaultMarket: Currency,
  ): Promise<{ intent: MutatingIntent; preview: DraftPreview }> {
    switch (originalIntent.kind) {
      case "TRADE":
        return this.tradePreview(originalIntent, defaultMarket);
      case "CLOSE":
        return this.closePreview(originalIntent, defaultMarket);
      case "CLOSE_ALL":
        return this.closeAllPreview(originalIntent);
      case "CANCEL_ORDERS":
        return this.cancelOrdersPreview(originalIntent, defaultMarket);
      case "CANCEL_ORDER":
        return this.cancelOrderPreview(originalIntent);
      case "PROTECTION":
        return this.protectionPreview(originalIntent, defaultMarket);
    }
  }

  private async tradePreview(
    intent: TradeIntent,
    defaultMarket: Currency,
  ): Promise<{ intent: TradeIntent; preview: DraftPreview }> {
    const contracts = await this.exchange.getContracts();
    const contract = resolveContract(
      contracts,
      intent.symbolInput,
      defaultMarket,
    );
    if (!contract.tradeable)
      throw new PreviewError(
        "CONTRACT_NOT_TRADEABLE",
        `${contract.symbol} is disabled.`,
      );
    if (!contract.orderTypes.includes(intent.orderType)) {
      throw new PreviewError(
        "ORDER_TYPE_NOT_SUPPORTED",
        `${intent.orderType} is not supported for ${contract.symbol}.`,
      );
    }
    if (intent.leverage > contract.maxLeverage) {
      throw new PreviewError(
        "LEVERAGE_NOT_SUPPORTED",
        `${contract.symbol} supports at most ${contract.maxLeverage}x leverage.`,
      );
    }
    if (!contract.marginAssetsSupported.includes(intent.requestedMarginAsset)) {
      throw new PreviewError(
        "MARGIN_ASSET_NOT_SUPPORTED",
        `${contract.symbol} does not support ${intent.requestedMarginAsset} margin. Supported: ${contract.marginAssetsSupported.join(", ")}.`,
      );
    }

    const [book, wallet, positions] = await Promise.all([
      this.marketData.getBestBidAsk(
        contract.symbol,
        contract.depthGroupings?.[0],
      ),
      this.exchange.getWallet(intent.requestedMarginAsset),
      this.exchange.getPositions("OPEN"),
    ]);
    const margin = new Decimal(intent.marginAmount);
    const freeCollateral = new Decimal(wallet.withdrawableBalance);
    if (freeCollateral.lt(margin)) {
      throw new PreviewError(
        `INSUFFICIENT_${intent.requestedMarginAsset}_MARGIN`,
        `Requested margin ${margin.toString()} ${intent.requestedMarginAsset} exceeds free collateral ${freeCollateral.toString()} ${intent.requestedMarginAsset}.`,
      );
    }

    const entry = new Decimal(
      intent.orderType === "LIMIT"
        ? requiredPrice(intent.limitPrice)
        : intent.direction === "LONG"
          ? book.bestAsk
          : book.bestBid,
    );
    if (intent.orderType === "LIMIT") validateOrderPrice(entry, contract);
    const marginNotional = margin.mul(intent.leverage);
    const quoteNotional = convertMarginToQuote(
      marginNotional,
      intent.requestedMarginAsset,
      contract,
    );
    const quantity = floorToContractQuantity(
      quoteNotional.div(entry),
      contract,
      intent.orderType,
    );
    validateOrderQuantity(
      quantity,
      quantity.mul(entry),
      contract,
      intent.orderType,
    );
    const feeRate = new Decimal(
      intent.orderType === "MARKET"
        ? contract.takerFeeRate
        : contract.makerFeeRate,
    );
    const estimatedFee = marginNotional.mul(feeRate);
    const liquidation = estimateLiquidation(
      entry,
      intent.leverage,
      intent.direction,
      contract,
    );
    const current = positions.filter(
      (position) =>
        position.symbol === contract.symbol &&
        position.marginMode === intent.marginMode &&
        position.marginAsset === intent.requestedMarginAsset,
    );
    const exposureEffect = describeExposureEffect(
      current,
      intent.direction,
      quantity,
    );
    const warnings: string[] = [];
    if (intent.marginMode === "CROSS") {
      warnings.push(
        "CROSS margin was explicitly selected; other cross positions share collateral.",
      );
    }
    if (current.length > 0) {
      warnings.push(
        `Existing ${contract.symbol} exposure: ${current.map((position) => `${position.direction} ${position.quantity}`).join(", ")}.`,
      );
    }
    if (contract.quoteAsset !== intent.requestedMarginAsset) {
      warnings.push(
        `Quote market is ${contract.quoteAsset}; margin is ${intent.requestedMarginAsset}. Conversion uses Shark exchange metadata.`,
      );
    }
    warnings.push(
      "Liquidation is a bot estimate using entry price, leverage, and Shark's maintenance-margin metadata; the exchange formula and displayed liquidation price prevail.",
    );

    const resolvedIntent: TradeIntent = { ...intent, symbol: contract.symbol };
    return {
      intent: resolvedIntent,
      preview: {
        title: `${contract.symbol} ${intent.direction} ${intent.orderType}`,
        summary: `${intent.marginMode} ${intent.leverage}x — NOT EXECUTED`,
        lines: [
          { label: "Contract", value: `${contract.symbol} perpetual` },
          { label: "Side", value: intent.direction },
          { label: "Margin mode", value: intent.marginMode },
          { label: "Exposure effect", value: exposureEffect },
          {
            label: "Margin",
            value: `${margin.toString()} ${intent.requestedMarginAsset}`,
          },
          {
            label: "Estimated size",
            value: `${quoteNotional.toFixed(contract.pricePrecision)} ${contract.quoteAsset}`,
          },
          {
            label: "Estimated quantity",
            value: `${quantity.toString()} ${contract.baseAsset}`,
          },
          {
            label:
              intent.orderType === "MARKET" ? "Estimated entry" : "Limit price",
            value: `${entry.toString()} ${contract.quoteAsset}`,
          },
          {
            label: "Best bid / ask",
            value: `${book.bestBid} / ${book.bestAsk} ${contract.quoteAsset}`,
          },
          ...(book.markPrice
            ? [
                {
                  label: "Mark price",
                  value: `${book.markPrice} ${contract.quoteAsset}`,
                },
              ]
            : []),
          {
            label: "Estimated liquidation",
            value: `${liquidation.toFixed(contract.pricePrecision)} ${contract.quoteAsset}`,
          },
          {
            label: "Estimated fee",
            value: `${estimatedFee.toSignificantDigits(8).toString()} ${intent.requestedMarginAsset}`,
          },
          {
            label: "Free collateral after",
            value: `${freeCollateral.minus(margin).toString()} ${intent.requestedMarginAsset}`,
          },
        ],
        warnings,
        calculatedAt: this.now(),
        contract,
        estimatedQuantity: quantity.toString(),
        estimatedEntryPrice: entry.toString(),
        ...(book.markPrice ? { referenceMarkPrice: book.markPrice } : {}),
        estimatedNotional: quoteNotional.toString(),
        estimatedFee: estimatedFee.toString(),
        estimatedLiquidationPrice: liquidation.toString(),
        freeCollateralAfter: freeCollateral.minus(margin).toString(),
      },
    };
  }

  private async closePreview(
    intent: CloseIntent,
    defaultMarket: Currency,
  ): Promise<{ intent: CloseIntent; preview: DraftPreview }> {
    const [positions, contracts] = await Promise.all([
      this.exchange.getPositions("OPEN"),
      this.exchange.getContracts(),
    ]);
    const position = resolvePosition(
      positions,
      intent.symbolInput,
      defaultMarket,
    );
    const contract = requiredContract(contracts, position.symbol);
    const book = await this.marketData.getBestBidAsk(
      position.symbol,
      contract.depthGroupings?.[0],
    );
    if (!contract.orderTypes.includes(intent.orderType)) {
      throw new PreviewError(
        "ORDER_TYPE_NOT_SUPPORTED",
        `${intent.orderType} is not supported for ${position.symbol}.`,
      );
    }
    const closePrice =
      intent.orderType === "LIMIT"
        ? requiredPrice(intent.limitPrice)
        : position.direction === "LONG"
          ? book.bestBid
          : book.bestAsk;
    if (intent.orderType === "LIMIT") {
      validateOrderPrice(new Decimal(closePrice), contract);
    }
    const resolvedIntent: CloseIntent = { ...intent, symbol: position.symbol };
    return {
      intent: resolvedIntent,
      preview: {
        title: `Close ${position.symbol} ${intent.orderType}`,
        summary: "REDUCE ONLY — NOT EXECUTED",
        lines: [
          {
            label: "Position",
            value: `${position.direction} ${position.quantity} ${position.baseAsset}`,
          },
          {
            label: "Entry",
            value: `${position.entryPrice} ${position.quoteAsset}`,
          },
          {
            label: "Close quantity",
            value: `${position.quantity} ${position.baseAsset}`,
          },
          {
            label:
              intent.orderType === "LIMIT" ? "Limit price" : "Estimated exit",
            value: `${closePrice} ${position.quoteAsset}`,
          },
          {
            label: "Best bid / ask",
            value: `${book.bestBid} / ${book.bestAsk} ${position.quoteAsset}`,
          },
          ...(book.markPrice
            ? [
                {
                  label: "Mark price",
                  value: `${book.markPrice} ${position.quoteAsset}`,
                },
              ]
            : []),
        ],
        warnings: [],
        calculatedAt: this.now(),
        positionIds: [position.positionId],
        estimatedQuantity: position.quantity,
        estimatedEntryPrice: closePrice,
        ...(book.markPrice ? { referenceMarkPrice: book.markPrice } : {}),
      },
    };
  }

  private async closeAllPreview(
    intent: MutatingIntent & { kind: "CLOSE_ALL" },
  ): Promise<{ intent: typeof intent; preview: DraftPreview }> {
    const positions = await this.exchange.getPositions("OPEN");
    if (positions.length === 0)
      throw new PreviewError(
        "NO_OPEN_POSITIONS",
        "There are no positions to close.",
      );
    return {
      intent,
      preview: {
        title: "Market close all positions",
        summary: `${positions.length} positions — NOT EXECUTED`,
        lines: positions.map((position) => ({
          label: position.symbol,
          value: `${position.direction} ${position.quantity} ${position.baseAsset} | margin ${position.marginInMarginAsset} ${position.marginAsset}`,
        })),
        warnings: [
          "Confirmation re-fetches positions and immediately market-closes every open position.",
        ],
        calculatedAt: this.now(),
        positionIds: positions.map((position) => position.positionId),
      },
    };
  }

  private async cancelOrdersPreview(
    intent: MutatingIntent & { kind: "CANCEL_ORDERS" },
    defaultMarket: Currency,
  ): Promise<{ intent: typeof intent; preview: DraftPreview }> {
    let symbol: string | undefined;
    if (intent.symbolInput) {
      const contracts = await this.exchange.getContracts();
      symbol = resolveContract(
        contracts,
        intent.symbolInput,
        defaultMarket,
      ).symbol;
    }
    const orders = await this.exchange.getOpenOrders(symbol);
    if (orders.length === 0)
      throw new PreviewError(
        "NO_OPEN_ORDERS",
        "There are no matching open orders.",
      );
    const resolvedIntent = symbol ? { ...intent, symbol } : intent;
    return {
      intent: resolvedIntent,
      preview: {
        title: symbol
          ? `Cancel open ${symbol} orders`
          : "Cancel all open orders",
        summary: `${orders.length} orders — NOT EXECUTED`,
        lines: orders.map((order) => ({
          label: order.clientOrderId,
          value: `${order.symbol} ${order.side} ${order.type} ${order.orderAmount} @ ${order.price}`,
        })),
        warnings: ["Linked stop-loss or take-profit orders may be included."],
        calculatedAt: this.now(),
      },
    };
  }

  private async cancelOrderPreview(
    intent: MutatingIntent & { kind: "CANCEL_ORDER" },
  ): Promise<{ intent: typeof intent; preview: DraftPreview }> {
    const order = await this.exchange.getOrder(intent.clientOrderId);
    if (!order)
      throw new PreviewError("ORDER_NOT_FOUND", "The order was not found.");
    return {
      intent,
      preview: {
        title: `Cancel ${order.symbol} order`,
        summary: "NOT EXECUTED",
        lines: [
          { label: "Order ID", value: order.clientOrderId },
          {
            label: "Order",
            value: `${order.side} ${order.type} ${order.orderAmount} @ ${order.price}`,
          },
        ],
        warnings: [],
        calculatedAt: this.now(),
      },
    };
  }

  private async protectionPreview(
    intent: MutatingIntent & { kind: "PROTECTION" },
    defaultMarket: Currency,
  ): Promise<{ intent: typeof intent; preview: DraftPreview }> {
    const [positions, contracts] = await Promise.all([
      this.exchange.getPositions("OPEN"),
      this.exchange.getContracts(),
    ]);
    const position = resolvePosition(
      positions,
      intent.symbolInput,
      defaultMarket,
    );
    validateProtectionPrice(
      position,
      intent.protectionType,
      new Decimal(intent.price),
    );
    validateOrderPrice(
      new Decimal(intent.price),
      requiredContract(contracts, position.symbol),
    );
    const resolvedIntent = { ...intent, symbol: position.symbol };
    return {
      intent: resolvedIntent,
      preview: {
        title: `${intent.protectionType === "STOP_LOSS" ? "Stop loss" : "Take profit"} ${position.symbol}`,
        summary: "FULL POSITION — NOT EXECUTED",
        lines: [
          {
            label: "Position",
            value: `${position.direction} ${position.quantity} ${position.baseAsset}`,
          },
          {
            label: "Trigger price",
            value: `${intent.price} ${position.quoteAsset}`,
          },
        ],
        warnings: [
          "This replaces/adds the exchange-linked protection for the current full position.",
        ],
        calculatedAt: this.now(),
        positionIds: [position.positionId],
        estimatedQuantity: position.quantity,
      },
    };
  }
}

export function resolveContract(
  contracts: Contract[],
  symbolInput: string,
  defaultMarket: Currency,
): Contract {
  const requested = symbolInput.toUpperCase();
  const exact = contracts.find((contract) => contract.symbol === requested);
  if (exact) return exact;
  const resolved = `${requested}${defaultMarket}`;
  const match = contracts.find((contract) => contract.symbol === resolved);
  if (!match)
    throw new PreviewError(
      "CONTRACT_NOT_FOUND",
      `No perpetual contract found for ${requested}.`,
    );
  return match;
}

function resolvePosition(
  positions: Position[],
  symbolInput: string,
  defaultMarket: Currency,
): Position {
  const input = symbolInput.toUpperCase();
  const direct = positions.filter((position) => position.symbol === input);
  if (direct.length === 1) return direct[0] as Position;
  const resolved = positions.filter(
    (position) => position.symbol === `${input}${defaultMarket}`,
  );
  if (resolved.length === 1) return resolved[0] as Position;
  const assetMatches = positions.filter(
    (position) => position.baseAsset === input,
  );
  if (assetMatches.length > 1) {
    throw new PreviewError(
      "AMBIGUOUS_POSITION",
      `Multiple ${input} positions exist; specify the full symbol.`,
    );
  }
  if (assetMatches.length === 1) return assetMatches[0] as Position;
  throw new PreviewError(
    "POSITION_NOT_FOUND",
    `No open position found for ${input}.`,
  );
}

function convertMarginToQuote(
  marginNotional: Decimal,
  marginAsset: Currency,
  contract: Contract,
): Decimal {
  if (marginAsset === contract.quoteAsset) return marginNotional;
  const key = `${marginAsset}_MARGIN_${contract.quoteAsset}`;
  const rateRaw = contract.conversionRates[key];
  if (!rateRaw) {
    throw new PreviewError(
      "MISSING_CONVERSION_RATE",
      `Shark did not provide ${key}; quantity cannot be calculated safely.`,
    );
  }
  const marginUnitsPerQuoteUnit = new Decimal(rateRaw);
  if (!marginUnitsPerQuoteUnit.isPositive()) {
    throw new PreviewError(
      "INVALID_CONVERSION_RATE",
      `Shark returned an invalid ${key} rate.`,
    );
  }
  return marginNotional.div(marginUnitsPerQuoteUnit);
}

export function validateOrderQuantity(
  quantity: Decimal,
  quoteNotional: Decimal,
  contract: Contract,
  orderType: "MARKET" | "LIMIT",
): void {
  const filterName =
    orderType === "MARKET" ? "MARKET_QTY_SIZE" : "LIMIT_QTY_SIZE";
  const qtyFilter = contract.filters.find(
    (filter) => filter.filterType === filterName,
  );
  if (qtyFilter?.minQty && quantity.lt(qtyFilter.minQty)) {
    throw new PreviewError(
      "QUANTITY_BELOW_MINIMUM",
      `Quantity is below ${qtyFilter.minQty}.`,
    );
  }
  if (qtyFilter?.maxQty && quantity.gt(qtyFilter.maxQty)) {
    throw new PreviewError(
      "QUANTITY_ABOVE_MAXIMUM",
      `Quantity is above ${qtyFilter.maxQty}.`,
    );
  }
  const notional = contract.filters.find(
    (filter) => filter.filterType === "MIN_NOTIONAL",
  )?.notional;
  if (notional && quoteNotional.lt(notional)) {
    throw new PreviewError(
      "NOTIONAL_BELOW_MINIMUM",
      `Notional is below ${notional} ${contract.quoteAsset}.`,
    );
  }
  if (!quantity.isPositive())
    throw new PreviewError(
      "QUANTITY_ROUNDED_TO_ZERO",
      "Quantity rounded to zero.",
    );
}

export function validateOrderPrice(price: Decimal, contract: Contract): void {
  const priceFilter = contract.filters.find(
    (filter) => filter.filterType === "PRICE_FILTER",
  );
  if (priceFilter?.minPrice && price.lt(priceFilter.minPrice)) {
    throw new PreviewError(
      "PRICE_BELOW_MINIMUM",
      `Price is below ${priceFilter.minPrice} ${contract.quoteAsset}.`,
    );
  }
  if (priceFilter?.maxPrice && price.gt(priceFilter.maxPrice)) {
    throw new PreviewError(
      "PRICE_ABOVE_MAXIMUM",
      `Price is above ${priceFilter.maxPrice} ${contract.quoteAsset}.`,
    );
  }
  const tick = priceFilter?.tickSize;
  const onTick = tick
    ? price.mod(new Decimal(tick)).isZero()
    : price.decimalPlaces() <= contract.pricePrecision;
  if (!onTick) {
    throw new PreviewError(
      "PRICE_NOT_ON_TICK",
      tick
        ? `Price must be a multiple of ${tick} ${contract.quoteAsset}.`
        : `Price supports at most ${contract.pricePrecision} decimal places.`,
    );
  }
}

function estimateLiquidation(
  entry: Decimal,
  leverage: number,
  direction: "LONG" | "SHORT",
  contract: Contract,
): Decimal {
  const maintenanceRaw = contract.maintenanceMarginRate ?? "0";
  let maintenance = new Decimal(maintenanceRaw);
  if (maintenance.gt(1)) maintenance = maintenance.div(100);
  const initial = new Decimal(1).div(leverage);
  const factor =
    direction === "LONG"
      ? new Decimal(1).minus(initial).plus(maintenance)
      : new Decimal(1).plus(initial).minus(maintenance);
  return Decimal.max(0, entry.mul(factor));
}

export function floorToContractQuantity(
  value: Decimal,
  contract: Contract,
  orderType: "MARKET" | "LIMIT",
): Decimal {
  const filterName =
    orderType === "MARKET" ? "MARKET_QTY_SIZE" : "LIMIT_QTY_SIZE";
  const step = contract.filters.find(
    (filter) => filter.filterType === filterName,
  )?.stepSize;
  if (step) {
    const increment = new Decimal(step);
    if (!increment.isPositive()) {
      throw new PreviewError(
        "INVALID_QUANTITY_STEP",
        `Shark returned an invalid ${filterName} step size.`,
      );
    }
    return value
      .dividedToIntegerBy(increment)
      .mul(increment)
      .toDecimalPlaces(contract.quantityPrecision, Decimal.ROUND_DOWN);
  }
  return value.toDecimalPlaces(contract.quantityPrecision, Decimal.ROUND_DOWN);
}

function requiredContract(contracts: Contract[], symbol: string): Contract {
  const contract = contracts.find((item) => item.symbol === symbol);
  if (!contract) {
    throw new PreviewError(
      "CONTRACT_NOT_FOUND",
      `No perpetual contract found for ${symbol}.`,
    );
  }
  return contract;
}

function describeExposureEffect(
  current: Position[],
  requestedDirection: TradeIntent["direction"],
  requestedQuantity: Decimal,
): string {
  if (current.length === 0) return `Opens new ${requestedDirection} exposure`;
  const same = current.filter(
    (position) => position.direction === requestedDirection,
  );
  const opposite = current.filter(
    (position) => position.direction !== requestedDirection,
  );
  if (same.length > 0 && opposite.length > 0) {
    return "Mixed current exposure; may increase, reduce, or reverse exposure";
  }
  if (same.length > 0)
    return `Increases existing ${requestedDirection} exposure`;
  const oppositeQuantity = opposite.reduce(
    (sum, position) => sum.plus(position.quantity),
    new Decimal(0),
  );
  const oppositeDirection = requestedDirection === "LONG" ? "SHORT" : "LONG";
  if (requestedQuantity.lt(oppositeQuantity)) {
    return `Reduces existing ${oppositeDirection} exposure`;
  }
  if (requestedQuantity.eq(oppositeQuantity)) {
    return `May fully close existing ${oppositeDirection} exposure`;
  }
  return `May reverse ${oppositeDirection} exposure to ${requestedDirection}`;
}

function requiredPrice(value: string | undefined): string {
  if (!value)
    throw new PreviewError("MISSING_LIMIT_PRICE", "Limit price is required.");
  return value;
}

function validateProtectionPrice(
  position: Position,
  type: "STOP_LOSS" | "TAKE_PROFIT",
  price: Decimal,
): void {
  const entry = new Decimal(position.entryPrice);
  const valid =
    position.direction === "LONG"
      ? type === "STOP_LOSS"
        ? price.lt(entry)
        : price.gt(entry)
      : type === "STOP_LOSS"
        ? price.gt(entry)
        : price.lt(entry);
  if (!valid) {
    throw new PreviewError(
      "INVALID_PROTECTION_PRICE",
      `${type === "STOP_LOSS" ? "Stop-loss" : "Take-profit"} price is on the wrong side of entry ${entry.toString()} for a ${position.direction} position.`,
    );
  }
}
