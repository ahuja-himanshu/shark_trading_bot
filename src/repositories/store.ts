import type {
  AuditEvent,
  Confirmation,
  Currency,
  ExecutionAttempt,
  ExchangeOrder,
  Position,
  Principal,
  TradeDraft,
  TradeFill,
  TransactionEvent,
} from "../domain/types.js";

export interface ClaimResult {
  draft: TradeDraft;
  execution: ExecutionAttempt;
}

export interface PnlLedgerRows {
  fills: TradeFill[];
  transactions: TransactionEvent[];
}

export interface ReconciliationStatus {
  stream: string;
  cursor: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  updatedAt: Date;
}

export interface AccountStreamEventClaim {
  eventKey: string;
  entityKey: string;
  eventType: string;
  eventTime: Date;
  payloadHash: string;
}

export type AccountStreamClaimResult = "CLAIMED" | "DUPLICATE" | "OUT_OF_ORDER";

export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;
  getOrCreatePrincipal(userId: string, chatId: string): Promise<Principal>;
  setDefaultMarket(
    userId: string,
    chatId: string,
    market: Currency,
  ): Promise<Principal>;
  createDraft(draft: TradeDraft): Promise<void>;
  getDraft(draftId: string): Promise<TradeDraft | null>;
  replaceDraft(draft: TradeDraft, expectedVersion: number): Promise<void>;
  cancelDraft(
    draftId: string,
    userId: string,
    chatId: string,
  ): Promise<boolean>;
  saveConfirmation(confirmation: Confirmation): Promise<void>;
  consumeConfirmationAndClaim(
    tokenHash: string,
    userId: string,
    chatId: string,
    now: Date,
  ): Promise<ClaimResult>;
  updateExecution(
    executionId: string,
    patch: Pick<ExecutionAttempt, "state"> &
      Partial<
        Pick<
          ExecutionAttempt,
          "clientOrderId" | "exchangeOrderId" | "result" | "errorCode"
        >
      >,
  ): Promise<void>;
  updateDraftStatus(
    draftId: string,
    status: TradeDraft["status"],
  ): Promise<void>;
  appendAudit(
    event: Omit<AuditEvent, "id" | "eventHash" | "previousHash" | "createdAt">,
  ): Promise<AuditEvent>;
  getAuditEvents(entityId: string, limit?: number): Promise<AuditEvent[]>;
  saveOrders(orders: ExchangeOrder[]): Promise<void>;
  savePositionSnapshots(positions: Position[], capturedAt: Date): Promise<void>;
  saveFills(fills: TradeFill[]): Promise<void>;
  saveTransactions(events: TransactionEvent[]): Promise<void>;
  claimAccountStreamEvent(
    event: AccountStreamEventClaim,
  ): Promise<AccountStreamClaimResult>;
  getPnlLedger(start: Date | null, end: Date): Promise<PnlLedgerRows>;
  getReconciliationCursor(stream: string): Promise<Date | null>;
  getReconciliationStatus(stream: string): Promise<ReconciliationStatus | null>;
  markReconciliation(
    stream: string,
    cursor: Date | null,
    success: boolean,
    errorCode?: string,
  ): Promise<void>;
  recordCommand(input: {
    id: string;
    updateId: number;
    userId?: string;
    chatId?: string;
    commandName: string;
    parsedIntent?: unknown;
    outcome: string;
    errorCode?: string;
  }): Promise<boolean>;
  finishCommand(
    updateId: number,
    outcome: string,
    parsedIntent?: unknown,
    errorCode?: string,
  ): Promise<void>;
}

export class StoreConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export class ConfirmationRejectedError extends Error {
  public constructor(
    public readonly code:
      | "CONFIRMATION_NOT_FOUND"
      | "CONFIRMATION_ALREADY_USED"
      | "CONFIRMATION_EXPIRED"
      | "CONFIRMATION_OWNER_MISMATCH"
      | "STALE_DRAFT"
      | "DRAFT_NOT_CONFIRMABLE",
    message: string,
  ) {
    super(message);
    this.name = "ConfirmationRejectedError";
  }
}
