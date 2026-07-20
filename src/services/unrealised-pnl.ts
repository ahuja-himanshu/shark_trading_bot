import { Decimal } from "decimal.js";
import type { Contract, Position } from "../domain/types.js";
import type { SharkExchangePort } from "../exchange/port.js";
import type { BestBidAskSource } from "./market-data.js";

/**
 * Shark's positions endpoint does not return per-position unrealised P&L
 * (only aggregate wallet-level figures), so this estimator derives it from
 * live market data: (reference price - entry) * quantity, sign-flipped for
 * shorts, converted into the position's margin asset when it differs from the
 * quote asset. Exchange-supplied values are never overwritten.
 */
export class UnrealisedPnlEstimator {
  public constructor(
    private readonly exchange: SharkExchangePort,
    private readonly marketData: BestBidAskSource,
  ) {}

  public async enrich(positions: Position[]): Promise<Position[]> {
    const missing = positions.filter(
      (position) => position.unrealisedProfit === undefined,
    );
    if (missing.length === 0) return positions;
    const contracts = await this.exchange.getContracts();
    const bySymbol = new Map(
      contracts.map((contract) => [contract.symbol, contract]),
    );
    const books = new Map<
      string,
      { bestBid: string; bestAsk: string; markPrice?: string } | null
    >();
    await Promise.all(
      [...new Set(missing.map((position) => position.symbol))].map(
        async (symbol) => {
          const contract = bySymbol.get(symbol);
          if (!contract) {
            books.set(symbol, null);
            return;
          }
          try {
            books.set(
              symbol,
              await this.marketData.getBestBidAsk(
                symbol,
                contract.depthGroupings?.[0],
              ),
            );
          } catch {
            books.set(symbol, null);
          }
        },
      ),
    );
    return positions.map((position) => {
      if (position.unrealisedProfit !== undefined) return position;
      const contract = bySymbol.get(position.symbol);
      const book = books.get(position.symbol);
      if (!contract || !book) return position;
      const estimate = estimateUnrealisedPnl(
        position,
        referencePrice(book),
        contract,
      );
      return estimate === undefined
        ? position
        : {
            ...position,
            unrealisedProfit: estimate,
            unrealisedProfitEstimated: true,
          };
    });
  }
}

export function estimateUnrealisedPnl(
  position: Pick<
    Position,
    "direction" | "entryPrice" | "quantity" | "marginAsset"
  >,
  reference: string,
  contract: Pick<Contract, "quoteAsset" | "conversionRates">,
): string | undefined {
  const quotePnl = new Decimal(reference)
    .minus(position.entryPrice)
    .mul(position.quantity)
    .mul(position.direction === "LONG" ? 1 : -1);
  if (position.marginAsset === contract.quoteAsset) {
    return quotePnl.toFixed(2);
  }
  const key = `${position.marginAsset}_MARGIN_${contract.quoteAsset}`;
  const rate = contract.conversionRates[key];
  if (!rate) return undefined;
  const marginUnitsPerQuoteUnit = new Decimal(rate);
  if (!marginUnitsPerQuoteUnit.gt(0)) return undefined;
  return quotePnl.mul(marginUnitsPerQuoteUnit).toFixed(2);
}

function referencePrice(book: {
  bestBid: string;
  bestAsk: string;
  markPrice?: string;
}): string {
  return (
    book.markPrice ??
    new Decimal(book.bestBid).plus(book.bestAsk).div(2).toString()
  );
}
