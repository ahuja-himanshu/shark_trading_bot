import type { SharkExchangePort } from "../exchange/port.js";
import type { RestFallbackHealth } from "../streams/health.js";
import type { PublicMarketStream } from "../streams/public-market-stream.js";

export interface BestBidAskSource {
  getBestBidAsk(
    symbol: string,
    depthGrouping?: string,
  ): Promise<{ bestBid: string; bestAsk: string; markPrice?: string }>;
}

export class HybridMarketData implements BestBidAskSource {
  private fallbacks = 0;
  private lastSuccessAt: Date | null = null;
  private lastFailureAt: Date | null = null;

  public constructor(
    private readonly stream: PublicMarketStream,
    private readonly exchange: SharkExchangePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getBestBidAsk(
    symbol: string,
    depthGrouping?: string,
  ): Promise<{ bestBid: string; bestAsk: string; markPrice?: string }> {
    this.stream.watch(symbol, depthGrouping);
    const quote = this.stream.getFreshQuote(symbol);
    if (quote?.bestBid && quote.bestAsk) {
      return {
        bestBid: quote.bestBid,
        bestAsk: quote.bestAsk,
        ...(quote.markPrice ? { markPrice: quote.markPrice } : {}),
      };
    }

    this.fallbacks += 1;
    try {
      const book = await this.exchange.getBestBidAsk(symbol);
      this.lastSuccessAt = this.now();
      this.stream.seedBook(symbol, book.bestBid, book.bestAsk);
      return book;
    } catch (error) {
      this.lastFailureAt = this.now();
      throw error;
    }
  }

  public getHealth(): RestFallbackHealth {
    return {
      state:
        this.lastSuccessAt === null
          ? this.lastFailureAt === null
            ? "UNKNOWN"
            : "UNAVAILABLE"
          : this.lastFailureAt !== null &&
              this.lastFailureAt > this.lastSuccessAt
            ? "UNAVAILABLE"
            : "AVAILABLE",
      fallbacks: this.fallbacks,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }
}
