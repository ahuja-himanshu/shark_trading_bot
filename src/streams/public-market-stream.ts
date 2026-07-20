import { Decimal } from "decimal.js";
import type { Logger } from "pino";
import type { MarketQuote } from "../domain/types.js";
import type { MarketStreamHealth, StreamState } from "./health.js";
import {
  createSocket,
  messageSize,
  safeSocketErrorCode,
  type SocketFactory,
  type SocketLike,
} from "./socket.js";

export interface PublicMarketStreamOptions {
  url: string;
  maxQuoteAgeMs: number;
  staleAfterMs: number;
  subscriptionLeaseMs: number;
  maxMessageBytes: number;
  maxSubscriptions?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  socketFactory?: SocketFactory;
  now?: () => Date;
  random?: () => number;
}

interface Subscription {
  depthGrouping: string;
  leaseExpiresAt: number | null;
}

export class PublicMarketStream {
  private readonly quotes = new Map<string, MarketQuote>();
  private readonly leased = new Map<string, Subscription>();
  private readonly held = new Map<string, string>();
  private readonly sentTopics = new Set<string>();
  private readonly socketFactory: SocketFactory;
  private readonly now: () => Date;
  private readonly random: () => number;
  private socket: SocketLike | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private livenessTimer: NodeJS.Timeout | undefined;
  private state: StreamState = "STOPPED";
  private stopped = true;
  private connecting = false;
  private reconnectAttempt = 0;
  private lastValidEventAt: Date | null = null;
  private lastHeartbeatAt: Date | null = null;
  private lastErrorCode: string | null = null;
  private reconnects = 0;
  private invalidMessages = 0;
  private staleDetections = 0;
  private sequenceGaps = 0;

  public constructor(
    private readonly options: PublicMarketStreamOptions,
    private readonly logger: Logger,
  ) {
    this.socketFactory = options.socketFactory ?? createSocket;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.state = "CONNECTING";
    this.connect(false);
    const interval = Math.max(
      1_000,
      Math.min(15_000, Math.floor(this.options.staleAfterMs / 2)),
    );
    this.livenessTimer = setInterval(() => this.checkLiveness(), interval);
    this.livenessTimer.unref();
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.state = "STOPPED";
    this.connecting = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.reconnectTimer = undefined;
    this.livenessTimer = undefined;
    this.detachSocket();
    this.sentTopics.clear();
  }

  public watch(
    rawSymbol: string,
    depthGrouping = "0.1",
    leaseMs = this.options.subscriptionLeaseMs,
  ): void {
    const symbol = validSymbol(rawSymbol);
    if (!symbol) return;
    const maximum = this.options.maxSubscriptions ?? 200;
    if (
      !this.leased.has(symbol) &&
      !this.held.has(symbol) &&
      this.desiredSymbols().size >= maximum
    ) {
      this.logger.warn(
        { metric: "market_subscription_limit", maximum },
        "Market subscription limit reached",
      );
      return;
    }
    this.leased.set(symbol, {
      depthGrouping: validGrouping(depthGrouping),
      leaseExpiresAt: this.now().getTime() + leaseMs,
    });
    this.refreshSubscriptions();
  }

  public unwatch(rawSymbol: string): void {
    const symbol = validSymbol(rawSymbol);
    if (!symbol) return;
    this.leased.delete(symbol);
    this.refreshSubscriptions();
  }

  public setHeldSymbols(
    symbols: ReadonlyArray<{ symbol: string; depthGrouping?: string }>,
  ): void {
    this.held.clear();
    const maximum = this.options.maxSubscriptions ?? 200;
    for (const item of symbols) {
      if (this.held.size >= maximum) break;
      const symbol = validSymbol(item.symbol);
      if (symbol) this.held.set(symbol, validGrouping(item.depthGrouping));
    }
    this.refreshSubscriptions();
  }

  public getFreshQuote(rawSymbol: string): MarketQuote | null {
    const symbol = validSymbol(rawSymbol);
    if (!symbol) return null;
    if (this.socket?.connected !== true || this.currentState() !== "HEALTHY")
      return null;
    const quote = this.quotes.get(symbol);
    const bookReceivedAt = quote?.bookReceivedAt ?? quote?.receivedAt;
    if (
      !quote?.bestBid ||
      !quote.bestAsk ||
      !bookReceivedAt ||
      this.now().getTime() - bookReceivedAt.getTime() >
        this.options.maxQuoteAgeMs
    ) {
      return null;
    }
    const fresh = structuredClone(quote);
    if (
      fresh.markPrice &&
      (!fresh.markReceivedAt ||
        this.now().getTime() - fresh.markReceivedAt.getTime() >
          this.options.maxQuoteAgeMs)
    ) {
      delete fresh.markPrice;
      delete fresh.markReceivedAt;
    }
    return fresh;
  }

  public seedBook(symbolInput: string, bestBid: string, bestAsk: string): void {
    const symbol = validSymbol(symbolInput);
    if (!symbol || !positiveDecimal(bestBid) || !positiveDecimal(bestAsk))
      return;
    const existing = this.quotes.get(symbol);
    const receivedAt = this.now();
    this.quotes.set(symbol, {
      ...(existing ?? { symbol }),
      symbol,
      bestBid,
      bestAsk,
      receivedAt,
      bookReceivedAt: receivedAt,
    });
  }

  public getHealth(): MarketStreamHealth {
    this.pruneExpiredLeases();
    return {
      state: this.currentState(),
      connected: this.socket?.connected === true,
      lastValidEventAt: this.lastValidEventAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      reconnects: this.reconnects,
      invalidMessages: this.invalidMessages,
      staleDetections: this.staleDetections,
      lastErrorCode: this.lastErrorCode,
      subscriptions: this.desiredSymbols().size,
      sequenceGaps: this.sequenceGaps,
    };
  }

  private connect(reconnecting: boolean): void {
    if (this.stopped || this.connecting || this.socket?.connected) return;
    this.connecting = true;
    this.state = reconnecting ? "RECONNECTING" : "CONNECTING";
    try {
      if (!this.socket) this.attachSocket(this.socketFactory(this.options.url));
      const socket = this.socket;
      if (!socket) throw new Error("Socket was not created");
      socket.connect();
    } catch (error) {
      this.connecting = false;
      this.lastErrorCode = safeSocketErrorCode(error);
      this.scheduleReconnect();
    }
  }

  private attachSocket(socket: SocketLike): void {
    this.socket = socket;
    socket.on("connect", this.onConnect);
    socket.on("disconnect", this.onDisconnect);
    socket.on("connect_error", this.onConnectError);
    socket.on("error", this.onSocketError);
    socket.on("depthUpdate", this.onDepth);
    socket.on("markPriceUpdate", this.onMarkPrice);
    socket.on("24hrTicker", this.onTicker);
    socket.io.on("ping", this.onHeartbeat);
  }

  private detachSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.off("connect", this.onConnect);
    socket.off("disconnect", this.onDisconnect);
    socket.off("connect_error", this.onConnectError);
    socket.off("error", this.onSocketError);
    socket.off("depthUpdate", this.onDepth);
    socket.off("markPriceUpdate", this.onMarkPrice);
    socket.off("24hrTicker", this.onTicker);
    socket.io.off("ping", this.onHeartbeat);
    socket.disconnect();
    this.socket = undefined;
  }

  private readonly onConnect = (): void => {
    this.connecting = false;
    this.reconnectAttempt = 0;
    this.lastErrorCode = null;
    this.lastHeartbeatAt = null;
    this.state = "CONNECTING";
    this.sentTopics.clear();
    this.refreshSubscriptions();
    this.logger.info({ stream: "public_market" }, "WebSocket connected");
  };

  private readonly onDisconnect = (): void => {
    if (this.stopped) return;
    this.connecting = false;
    this.scheduleReconnect();
  };

  private readonly onConnectError = (error: unknown): void => {
    this.connecting = false;
    this.lastErrorCode = safeSocketErrorCode(error);
    this.scheduleReconnect();
  };

  private readonly onSocketError = (error: unknown): void => {
    this.lastErrorCode = safeSocketErrorCode(error);
    this.state = "DEGRADED";
  };

  private readonly onHeartbeat = (): void => {
    this.lastHeartbeatAt = this.now();
    this.lastErrorCode = null;
    this.state = "HEALTHY";
  };

  private readonly onDepth = (payload: unknown): void => {
    if (!this.acceptMessage(payload)) return;
    const raw = eventRecord(payload);
    const symbol = validSymbol(
      stringValue(raw.s ?? raw.symbol ?? raw.contractPair),
    );
    const bids = rows(raw.b ?? raw.bids);
    const asks = rows(raw.a ?? raw.asks);
    const bestBid = bestPrice(bids, "BID");
    const bestAsk = bestPrice(asks, "ASK");
    if (!symbol) return this.rejectMessage();
    if (!this.desiredSymbols().has(symbol)) return;
    if (!bestBid || !bestAsk || new Decimal(bestBid).gte(bestAsk))
      return this.rejectMessage();

    const existing = this.quotes.get(symbol);
    const firstUpdateId = idValue(raw.U ?? raw.firstUpdateId);
    const lastUpdateId = idValue(raw.u ?? raw.lastUpdateId);
    const previousUpdateId = idValue(raw.pu ?? raw.previousUpdateId);
    if (isOlderUpdate(existing?.lastUpdateId, lastUpdateId)) return;
    if (
      hasSequenceGap(existing?.lastUpdateId, firstUpdateId, previousUpdateId)
    ) {
      this.sequenceGaps += 1;
      this.lastErrorCode = "MARKET_SEQUENCE_GAP";
      this.quotes.set(symbol, {
        symbol,
        ...(existing?.markPrice ? { markPrice: existing.markPrice } : {}),
        ...(existing?.tickerPrice ? { tickerPrice: existing.tickerPrice } : {}),
        ...(existing?.markReceivedAt
          ? { markReceivedAt: existing.markReceivedAt }
          : {}),
        ...(existing?.exchangeEventAt
          ? { exchangeEventAt: existing.exchangeEventAt }
          : {}),
        receivedAt: this.now(),
      });
      this.resubscribeSymbol(symbol);
      return;
    }
    const receivedAt = this.now();
    this.quotes.set(
      symbol,
      compactQuote({
        ...(existing ?? { symbol }),
        symbol,
        ...(bestBid ? { bestBid } : {}),
        ...(bestAsk ? { bestAsk } : {}),
        ...(eventDate(raw) ? { exchangeEventAt: eventDate(raw) as Date } : {}),
        receivedAt,
        bookReceivedAt: receivedAt,
        ...(firstUpdateId ? { firstUpdateId } : {}),
        ...(lastUpdateId ? { lastUpdateId } : {}),
        ...(previousUpdateId ? { previousUpdateId } : {}),
      }),
    );
    this.validMessage(receivedAt);
  };

  private readonly onMarkPrice = (payload: unknown): void => {
    if (!this.acceptMessage(payload)) return;
    const raw = eventRecord(payload);
    const symbol = validSymbol(
      stringValue(raw.s ?? raw.symbol ?? raw.contractPair),
    );
    const markPrice = decimalValue(raw.p ?? raw.markPrice ?? raw.price);
    if (!symbol) return this.rejectMessage();
    if (!this.desiredSymbols().has(symbol)) return;
    if (!markPrice) return this.rejectMessage();
    const receivedAt = this.now();
    this.quotes.set(
      symbol,
      compactQuote({
        ...(this.quotes.get(symbol) ?? { symbol }),
        symbol,
        markPrice,
        ...(eventDate(raw) ? { exchangeEventAt: eventDate(raw) as Date } : {}),
        receivedAt,
        markReceivedAt: receivedAt,
      }),
    );
    this.validMessage(receivedAt);
  };

  private readonly onTicker = (payload: unknown): void => {
    if (!this.acceptMessage(payload)) return;
    const raw = eventRecord(payload);
    const symbol = validSymbol(
      stringValue(raw.s ?? raw.symbol ?? raw.contractPair),
    );
    if (!symbol) return this.rejectMessage();
    if (!this.desiredSymbols().has(symbol)) return;
    const tickerPrice = decimalValue(raw.c ?? raw.lastPrice ?? raw.price);
    const bestBid = decimalValue(raw.b ?? raw.bestBid);
    const bestAsk = decimalValue(raw.a ?? raw.bestAsk);
    if (!tickerPrice && !bestBid && !bestAsk) return this.rejectMessage();
    if (bestBid && bestAsk && new Decimal(bestBid).gte(bestAsk))
      return this.rejectMessage();
    const receivedAt = this.now();
    this.quotes.set(
      symbol,
      compactQuote({
        ...(this.quotes.get(symbol) ?? { symbol }),
        symbol,
        ...(tickerPrice ? { tickerPrice } : {}),
        ...(bestBid && bestAsk ? { bestBid, bestAsk } : {}),
        ...(eventDate(raw) ? { exchangeEventAt: eventDate(raw) as Date } : {}),
        receivedAt,
        ...(bestBid && bestAsk ? { bookReceivedAt: receivedAt } : {}),
        tickerReceivedAt: receivedAt,
      }),
    );
    this.validMessage(receivedAt);
  };

  private acceptMessage(payload: unknown): boolean {
    const size = messageSize(payload);
    if (size === null || size > this.options.maxMessageBytes) {
      this.rejectMessage();
      return false;
    }
    return true;
  }

  private rejectMessage(): void {
    this.invalidMessages += 1;
    this.lastErrorCode = "INVALID_MARKET_MESSAGE";
  }

  private validMessage(at: Date): void {
    this.lastValidEventAt = at;
    this.lastErrorCode = null;
    this.state = "HEALTHY";
  }

  private checkLiveness(): void {
    this.pruneExpiredLeases();
    if (!this.socket?.connected) return;
    const activity = latest(this.lastValidEventAt, this.lastHeartbeatAt);
    if (
      activity &&
      this.now().getTime() - activity.getTime() <= this.options.staleAfterMs
    )
      return;
    this.staleDetections += 1;
    this.lastErrorCode = "PUBLIC_STREAM_STALE";
    this.state = "STALE";
    this.socket.disconnect();
    this.scheduleReconnect();
  }

  private currentState(): StreamState {
    if (this.stopped) return "STOPPED";
    if (this.state === "HEALTHY") {
      const activity = latest(this.lastValidEventAt, this.lastHeartbeatAt);
      if (
        !activity ||
        this.now().getTime() - activity.getTime() > this.options.staleAfterMs
      )
        return "STALE";
    }
    return this.state;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.state = "RECONNECTING";
    this.reconnectAttempt += 1;
    this.reconnects += 1;
    const base = this.options.reconnectBaseMs ?? 500;
    const maximum = this.options.reconnectMaxMs ?? 30_000;
    const upper = Math.min(
      maximum,
      base * 2 ** Math.min(this.reconnectAttempt - 1, 16),
    );
    const delay = Math.max(1, Math.floor(upper * this.random()));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(true);
    }, delay);
    this.reconnectTimer.unref();
  }

  private refreshSubscriptions(): void {
    this.pruneExpiredLeases(false);
    const desiredSymbols = this.desiredSymbols();
    for (const symbol of this.quotes.keys()) {
      if (!desiredSymbols.has(symbol)) this.quotes.delete(symbol);
    }
    if (!this.socket?.connected) return;
    const desiredTopics = this.desiredTopics();
    const added = [...desiredTopics].filter(
      (topic) => !this.sentTopics.has(topic),
    );
    const removed = [...this.sentTopics].filter(
      (topic) => !desiredTopics.has(topic),
    );
    if (added.length > 0) this.socket.emit("subscribe", { params: added });
    if (removed.length > 0)
      this.socket.emit("unsubscribe", { params: removed });
    this.sentTopics.clear();
    for (const topic of desiredTopics) this.sentTopics.add(topic);
  }

  private desiredTopics(): Set<string> {
    const topics = new Set<string>();
    for (const [symbol, grouping] of this.desiredSymbols()) {
      const lower = symbol.toLowerCase();
      topics.add(`${lower}@depth_${grouping}`);
      topics.add(`${lower}@markPrice`);
      topics.add(`${lower}@ticker`);
    }
    return topics;
  }

  private desiredSymbols(): Map<string, string> {
    const symbols = new Map(this.held);
    for (const [symbol, subscription] of this.leased)
      symbols.set(symbol, subscription.depthGrouping);
    return symbols;
  }

  private pruneExpiredLeases(refresh = true): void {
    const now = this.now().getTime();
    let changed = false;
    for (const [symbol, subscription] of this.leased) {
      if (
        subscription.leaseExpiresAt !== null &&
        subscription.leaseExpiresAt <= now
      ) {
        this.leased.delete(symbol);
        changed = true;
      }
    }
    if (changed && refresh) this.refreshSubscriptions();
  }

  private resubscribeSymbol(symbol: string): void {
    if (!this.socket?.connected) return;
    const topics = [...this.desiredTopics()].filter((topic) =>
      topic.startsWith(`${symbol.toLowerCase()}@`),
    );
    if (topics.length === 0) return;
    this.socket.emit("unsubscribe", { params: topics });
    this.socket.emit("subscribe", { params: topics });
  }
}

function validSymbol(value: string | undefined): string | null {
  const symbol = value?.trim().toUpperCase();
  return symbol && /^[A-Z0-9]{3,30}$/.test(symbol) ? symbol : null;
}

function validGrouping(value: string | undefined): string {
  return value && /^\d+(?:\.\d+)?$/.test(value) ? value : "0.1";
}

function eventRecord(value: unknown): Record<string, unknown> {
  const root = record(value);
  const data = record(root.data);
  return Object.keys(data).length > 0 ? data : root;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rows(value: unknown): unknown[][] {
  return Array.isArray(value) ? value.filter(Array.isArray) : [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function decimalValue(value: unknown): string | undefined {
  const raw = stringValue(value);
  return raw && positiveDecimal(raw) ? new Decimal(raw).toString() : undefined;
}

function positiveDecimal(value: string): boolean {
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && parsed.gt(0);
  } catch {
    return false;
  }
}

function bestPrice(
  values: unknown[][],
  side: "BID" | "ASK",
): string | undefined {
  const prices = values
    .filter((row) => decimalValue(row[1]) !== undefined)
    .map((row) => decimalValue(row[0]))
    .filter((value): value is string => value !== undefined);
  if (prices.length === 0) return undefined;
  return prices.reduce((selected, value) => {
    const comparison = new Decimal(value).comparedTo(selected);
    return side === "BID"
      ? comparison > 0
        ? value
        : selected
      : comparison < 0
        ? value
        : selected;
  });
}

function idValue(value: unknown): string | undefined {
  const raw = stringValue(value);
  return raw && /^\d+$/.test(raw) ? raw : undefined;
}

function isOlderUpdate(
  previous: string | undefined,
  current: string | undefined,
): boolean {
  return (
    previous !== undefined &&
    current !== undefined &&
    BigInt(current) <= BigInt(previous)
  );
}

function hasSequenceGap(
  previous: string | undefined,
  first: string | undefined,
  reportedPrevious: string | undefined,
): boolean {
  if (!previous) return false;
  if (reportedPrevious) return BigInt(reportedPrevious) !== BigInt(previous);
  return first !== undefined && BigInt(first) > BigInt(previous) + 1n;
}

function eventDate(raw: Record<string, unknown>): Date | undefined {
  const value = raw.E ?? raw.eventTime ?? raw.T ?? raw.time;
  const parsed =
    typeof value === "number"
      ? new Date(value)
      : typeof value === "string" && /^\d+$/.test(value)
        ? new Date(Number(value))
        : typeof value === "string"
          ? new Date(value)
          : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
}

function latest(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function compactQuote(quote: MarketQuote): MarketQuote {
  return Object.fromEntries(
    Object.entries(quote).filter(([, value]) => value !== undefined),
  ) as unknown as MarketQuote;
}
