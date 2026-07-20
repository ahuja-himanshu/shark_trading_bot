import type { Logger } from "pino";
import type { Position } from "../domain/types.js";
import type { SharkExchangePort } from "../exchange/port.js";
import {
  SharkApiError,
  normaliseFill,
  normaliseOrder,
  normalisePosition,
} from "../exchange/shark-client.js";
import type { Store } from "../repositories/store.js";
import { sha256, stableJson } from "../security/crypto.js";
import type { AccountStreamHealth, StreamState } from "./health.js";
import {
  createSocket,
  messageSize,
  safeSocketErrorCode,
  type SocketFactory,
  type SocketLike,
} from "./socket.js";

const POSITION_EVENTS = new Set([
  "newPosition",
  "updatePosition",
  "closePosition",
]);
const ORDER_EVENTS = new Set([
  "newOrder",
  "updateOrder",
  "orderFilled",
  "orderPartiallyFilled",
  "orderCancelled",
]);
const ACCOUNT_EVENTS = [
  ...POSITION_EVENTS,
  ...ORDER_EVENTS,
  "orderFailed",
  "balanceUpdate",
  "newTrade",
] as const;

export interface AuthenticatedAccountStreamOptions {
  url: string;
  renewalMs: number;
  staleAfterMs: number;
  maxMessageBytes: number;
  maxQueueSize?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  socketFactory?: SocketFactory;
  now?: () => Date;
  random?: () => number;
}

interface QueuedAccountEvent {
  eventType: string;
  payload: unknown;
  receivedAt: Date;
}

export class AuthenticatedAccountStream {
  private readonly socketFactory: SocketFactory;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly queue: QueuedAccountEvent[] = [];
  private socket: SocketLike | undefined;
  private listenKey: string | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private renewalTimer: NodeJS.Timeout | undefined;
  private livenessTimer: NodeJS.Timeout | undefined;
  private drainPromise: Promise<void> | undefined;
  private stopped = true;
  private establishing = false;
  private reconnectAttempt = 0;
  private state: StreamState = "STOPPED";
  private lastValidEventAt: Date | null = null;
  private lastHeartbeatAt: Date | null = null;
  private lastErrorCode: string | null = null;
  private reconnects = 0;
  private invalidMessages = 0;
  private staleDetections = 0;
  private accountResyncs = 0;
  private duplicateEvents = 0;
  private outOfOrderEvents = 0;
  private queueOverflows = 0;

  public constructor(
    private readonly options: AuthenticatedAccountStreamOptions,
    private readonly exchange: SharkExchangePort,
    private readonly store: Store,
    private readonly onResync: () => Promise<void>,
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
    void this.establish(false);
    const interval = Math.max(
      1_000,
      Math.min(15_000, Math.floor(this.options.staleAfterMs / 2)),
    );
    this.livenessTimer = setInterval(() => this.checkLiveness(), interval);
    this.livenessTimer.unref();
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.state = "STOPPED";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.reconnectTimer = undefined;
    this.renewalTimer = undefined;
    this.livenessTimer = undefined;
    this.detachSocket();
    await this.drainPromise;
    if (this.listenKey) {
      await this.exchange.deleteListenKey().catch(() => undefined);
      this.listenKey = undefined;
    }
  }

  public getHealth(): AccountStreamHealth {
    return {
      state: this.currentState(),
      connected: this.socket?.connected === true,
      lastValidEventAt: this.lastValidEventAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      reconnects: this.reconnects,
      invalidMessages: this.invalidMessages,
      staleDetections: this.staleDetections,
      lastErrorCode: this.lastErrorCode,
      accountResyncs: this.accountResyncs,
      duplicateEvents: this.duplicateEvents,
      outOfOrderEvents: this.outOfOrderEvents,
      queueOverflows: this.queueOverflows,
    };
  }

  private async establish(reconnecting: boolean): Promise<void> {
    if (this.stopped || this.establishing || this.socket?.connected) return;
    this.establishing = true;
    this.state = reconnecting ? "RECONNECTING" : "CONNECTING";
    try {
      if (!this.listenKey) {
        const key = await this.exchange.createListenKey();
        if (!validListenKey(key)) throw new Error("Invalid listen key");
        if (this.stopped) {
          await this.exchange.deleteListenKey().catch(() => undefined);
          return;
        }
        this.listenKey = key;
      }
      if (!this.socket) {
        const url = `${this.options.url}/${encodeURIComponent(this.listenKey)}`;
        this.attachSocket(this.socketFactory(url));
      }
      const socket = this.socket;
      if (!socket) throw new Error("Socket was not created");
      socket.connect();
    } catch (error) {
      this.lastErrorCode = errorCode(error, "LISTEN_KEY_CREATE_FAILED");
      this.state = "DEGRADED";
      this.scheduleReconnect();
    } finally {
      this.establishing = false;
    }
  }

  private attachSocket(socket: SocketLike): void {
    this.socket = socket;
    socket.on("connect", this.onConnect);
    socket.on("disconnect", this.onDisconnect);
    socket.on("connect_error", this.onConnectError);
    socket.on("error", this.onSocketError);
    socket.on("sessionExpired", this.onSessionExpired);
    for (const eventType of ACCOUNT_EVENTS)
      socket.on(eventType, this.accountHandler(eventType));
    socket.io.on("ping", this.onHeartbeat);
  }

  private detachSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.off("connect", this.onConnect);
    socket.off("disconnect", this.onDisconnect);
    socket.off("connect_error", this.onConnectError);
    socket.off("error", this.onSocketError);
    socket.off("sessionExpired", this.onSessionExpired);
    for (const eventType of ACCOUNT_EVENTS)
      socket.off(eventType, this.accountHandler(eventType));
    socket.io.off("ping", this.onHeartbeat);
    socket.disconnect();
    this.socket = undefined;
  }

  private readonly handlers = new Map<string, (payload: unknown) => void>();

  private accountHandler(eventType: string): (payload: unknown) => void {
    const existing = this.handlers.get(eventType);
    if (existing) return existing;
    const handler = (payload: unknown): void =>
      this.enqueue(eventType, payload);
    this.handlers.set(eventType, handler);
    return handler;
  }

  private readonly onConnect = (): void => {
    this.reconnectAttempt = 0;
    this.lastErrorCode = null;
    this.lastHeartbeatAt = null;
    this.state = "CONNECTING";
    this.scheduleRenewal();
    this.logger.info(
      { stream: "authenticated_account" },
      "WebSocket connected",
    );
    void this.resync("ACCOUNT_STREAM_CONNECTED");
  };

  private readonly onDisconnect = (): void => {
    if (this.stopped) return;
    this.scheduleReconnect();
  };

  private readonly onConnectError = (error: unknown): void => {
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

  private readonly onSessionExpired = (payload: unknown): void => {
    if (!this.messageAllowed(payload)) return;
    this.lastErrorCode = "ACCOUNT_SESSION_EXPIRED";
    void this.recreateSession();
  };

  private enqueue(eventType: string, payload: unknown): void {
    if (!this.messageAllowed(payload)) return;
    const maximum = this.options.maxQueueSize ?? 1_000;
    if (this.queue.length >= maximum) {
      this.queueOverflows += 1;
      this.lastErrorCode = "ACCOUNT_EVENT_QUEUE_OVERFLOW";
      this.state = "DEGRADED";
      void this.resync("ACCOUNT_EVENT_QUEUE_OVERFLOW");
      return;
    }
    this.queue.push({ eventType, payload, receivedAt: this.now() });
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = undefined;
        if (this.queue.length > 0 && !this.stopped) this.enqueueDrain();
      });
    }
  }

  private enqueueDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
      if (this.queue.length > 0 && !this.stopped) this.enqueueDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const event = this.queue.shift();
      if (!event) continue;
      try {
        const accepted = await this.processEvent(event);
        if (accepted) {
          this.lastValidEventAt = event.receivedAt;
          this.lastErrorCode = null;
          this.state = "HEALTHY";
        }
      } catch (error) {
        this.invalidMessages += 1;
        this.lastErrorCode = errorCode(error, "INVALID_ACCOUNT_MESSAGE");
        this.state = "DEGRADED";
        void this.resync("INVALID_ACCOUNT_MESSAGE");
      }
    }
  }

  private async processEvent(event: QueuedAccountEvent): Promise<boolean> {
    const raw = eventRecord(event.payload);
    if (POSITION_EVENTS.has(event.eventType)) {
      const position = normalisePosition(
        event.eventType === "closePosition" && raw.positionStatus === undefined
          ? { ...raw, positionStatus: "CLOSED" }
          : raw,
      );
      if (
        !(await this.claim(
          event,
          `POSITION:${position.positionId}`,
          position.updatedAt,
        ))
      )
        return false;
      await this.store.savePositionSnapshots([position], event.receivedAt);
      return true;
    }

    if (ORDER_EVENTS.has(event.eventType)) {
      const order = normaliseOrder(raw);
      const eventTime = eventDate(raw) ?? order.createdAt ?? event.receivedAt;
      if (!(await this.claim(event, `ORDER:${order.clientOrderId}`, eventTime)))
        return false;
      await this.store.saveOrders([order]);
      return true;
    }

    if (event.eventType === "newTrade") {
      const fill = normaliseFill(raw);
      if (
        !(await this.claim(
          event,
          `FILL:${fill.exchangeFillId}`,
          fill.occurredAt,
        ))
      )
        return false;
      await this.store.saveFills([fill]);
      return true;
    }

    if (event.eventType === "orderFailed") {
      const identifier = identifierValue(raw.clientOrderId ?? raw.orderId);
      if (!identifier) throw new Error("Missing failed order identifier");
      if (
        !(await this.claim(
          event,
          `ORDER:${identifier}`,
          eventDate(raw) ?? event.receivedAt,
        ))
      )
        return false;
      void this.resync("ORDER_FAILED_EVENT");
      return true;
    }

    if (event.eventType === "balanceUpdate") {
      const asset = identifierValue(raw.asset ?? raw.marginAsset) ?? "ACCOUNT";
      if (
        !(await this.claim(
          event,
          `BALANCE:${asset}`,
          eventDate(raw) ?? event.receivedAt,
        ))
      )
        return false;
      void this.resync("BALANCE_UPDATE_EVENT");
      return true;
    }

    return false;
  }

  private async claim(
    event: QueuedAccountEvent,
    entityKey: string,
    eventTime: Date,
  ): Promise<boolean> {
    const payloadHash = sha256(stableJson(event.payload));
    const claim = await this.store.claimAccountStreamEvent({
      eventKey: sha256(`${event.eventType}:${entityKey}:${payloadHash}`),
      entityKey,
      eventType: event.eventType,
      eventTime,
      payloadHash,
    });
    if (claim === "DUPLICATE") this.duplicateEvents += 1;
    if (claim === "OUT_OF_ORDER") {
      this.outOfOrderEvents += 1;
      void this.resync("ACCOUNT_EVENT_OUT_OF_ORDER");
    }
    return claim === "CLAIMED";
  }

  private messageAllowed(payload: unknown): boolean {
    const size = messageSize(payload);
    if (size !== null && size <= this.options.maxMessageBytes) return true;
    this.invalidMessages += 1;
    this.lastErrorCode = "INVALID_ACCOUNT_MESSAGE";
    this.state = "DEGRADED";
    return false;
  }

  private scheduleRenewal(): void {
    if (this.stopped) return;
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.renewalTimer = setTimeout(
      () => void this.renewListenKey(),
      this.options.renewalMs,
    );
    this.renewalTimer.unref();
  }

  private async renewListenKey(): Promise<void> {
    if (this.stopped || !this.listenKey) return;
    try {
      await this.exchange.renewListenKey();
      this.scheduleRenewal();
    } catch (error) {
      this.lastErrorCode = errorCode(error, "LISTEN_KEY_RENEWAL_FAILED");
      this.state = "DEGRADED";
      await this.recreateSession();
    }
  }

  private async recreateSession(): Promise<void> {
    if (this.stopped || this.establishing) return;
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
    this.detachSocket();
    if (this.listenKey)
      await this.exchange.deleteListenKey().catch(() => undefined);
    this.listenKey = undefined;
    await this.establish(true);
  }

  private checkLiveness(): void {
    if (!this.socket?.connected) return;
    const activity = latest(this.lastValidEventAt, this.lastHeartbeatAt);
    if (
      activity &&
      this.now().getTime() - activity.getTime() <= this.options.staleAfterMs
    )
      return;
    this.staleDetections += 1;
    this.lastErrorCode = "ACCOUNT_STREAM_STALE";
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
      void this.establish(true);
    }, delay);
    this.reconnectTimer.unref();
  }

  private async resync(reason: string): Promise<void> {
    this.accountResyncs += 1;
    try {
      await this.onResync();
      this.logger.info(
        { stream: "authenticated_account", reason, metric: "account_resync" },
        "Account REST resynchronization completed",
      );
    } catch {
      this.lastErrorCode = "ACCOUNT_RESYNC_FAILED";
      this.state = "DEGRADED";
    }
  }
}

function validListenKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,512}$/.test(value);
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

function identifierValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = String(value).trim().toUpperCase();
  return /^[A-Z0-9_-]{1,128}$/.test(parsed) ? parsed : undefined;
}

function eventDate(raw: Record<string, unknown>): Date | undefined {
  const value = raw.updatedAt ?? raw.updatedTime ?? raw.E ?? raw.T ?? raw.time;
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

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof SharkApiError && /^[A-Z0-9_-]{1,64}$/.test(error.code))
    return error.code;
  return fallback;
}

export function positionSymbols(
  positions: Position[],
): Array<{ symbol: string }> {
  return [...new Set(positions.map((position) => position.symbol))].map(
    (symbol) => ({ symbol }),
  );
}
