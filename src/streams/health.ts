export type StreamState =
  | "STOPPED"
  | "CONNECTING"
  | "HEALTHY"
  | "STALE"
  | "RECONNECTING"
  | "DEGRADED";

export interface StreamHealth {
  state: StreamState;
  connected: boolean;
  lastValidEventAt: Date | null;
  lastHeartbeatAt: Date | null;
  reconnects: number;
  invalidMessages: number;
  staleDetections: number;
  lastErrorCode: string | null;
}

export interface MarketStreamHealth extends StreamHealth {
  subscriptions: number;
  sequenceGaps: number;
}

export interface AccountStreamHealth extends StreamHealth {
  accountResyncs: number;
  duplicateEvents: number;
  outOfOrderEvents: number;
  queueOverflows: number;
}

export interface RestFallbackHealth {
  state: "UNKNOWN" | "AVAILABLE" | "UNAVAILABLE";
  fallbacks: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

export interface RuntimeHealth {
  publicMarket: MarketStreamHealth;
  authenticatedAccount: AccountStreamHealth;
  restFallback: RestFallbackHealth;
}

export interface RuntimeHealthProvider {
  getHealth(): RuntimeHealth;
}
