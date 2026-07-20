import { randomUUID } from "node:crypto";
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
import { sha256, stableJson } from "../security/crypto.js";
import {
  ConfirmationRejectedError,
  StoreConflictError,
  type AccountStreamClaimResult,
  type AccountStreamEventClaim,
  type ClaimResult,
  type PnlLedgerRows,
  type ReconciliationStatus,
  type Store,
} from "./store.js";

export class MemoryStore implements Store {
  public readonly drafts = new Map<string, TradeDraft>();
  public readonly confirmations = new Map<string, Confirmation>();
  public readonly executions = new Map<string, ExecutionAttempt>();
  public readonly audits: AuditEvent[] = [];
  public readonly fills = new Map<string, TradeFill>();
  public readonly transactions = new Map<string, TransactionEvent>();
  public readonly orders = new Map<string, ExchangeOrder>();
  public readonly snapshots: Array<{ position: Position; capturedAt: Date }> =
    [];
  private readonly principals = new Map<string, Principal>();
  private readonly commands = new Set<number>();
  private readonly reconciliation = new Map<string, ReconciliationStatus>();
  private readonly accountStreamEvents = new Set<string>();
  private readonly accountStreamEntityTimes = new Map<string, Date>();

  public async migrate(): Promise<void> {}
  public async close(): Promise<void> {}

  public async getOrCreatePrincipal(
    userId: string,
    chatId: string,
  ): Promise<Principal> {
    const existing = this.principals.get(userId);
    const now = new Date();
    if (existing) {
      existing.chatId = chatId;
      existing.updatedAt = now;
      return structuredClone(existing);
    }
    const principal: Principal = {
      userId,
      chatId,
      defaultMarket: "INR",
      createdAt: now,
      updatedAt: now,
    };
    this.principals.set(userId, principal);
    return structuredClone(principal);
  }

  public async setDefaultMarket(
    userId: string,
    chatId: string,
    market: Currency,
  ): Promise<Principal> {
    const principal = this.principals.get(userId);
    if (!principal || principal.chatId !== chatId)
      throw new StoreConflictError("Principal not found");
    principal.defaultMarket = market;
    principal.updatedAt = new Date();
    return structuredClone(principal);
  }

  public async createDraft(draft: TradeDraft): Promise<void> {
    if (this.drafts.has(draft.id))
      throw new StoreConflictError("Draft already exists");
    this.drafts.set(draft.id, structuredClone(draft));
  }

  public async getDraft(draftId: string): Promise<TradeDraft | null> {
    const draft = this.drafts.get(draftId);
    return draft ? structuredClone(draft) : null;
  }

  public async replaceDraft(
    draft: TradeDraft,
    expectedVersion: number,
  ): Promise<void> {
    const current = this.drafts.get(draft.id);
    if (
      !current ||
      current.version !== expectedVersion ||
      current.status !== "DRAFTED"
    ) {
      throw new StoreConflictError("Draft changed");
    }
    this.drafts.set(draft.id, structuredClone(draft));
    for (const confirmation of this.confirmations.values()) {
      if (confirmation.draftId === draft.id && !confirmation.consumedAt) {
        confirmation.expiresAt = new Date(0);
      }
    }
  }

  public async cancelDraft(
    draftId: string,
    userId: string,
    chatId: string,
  ): Promise<boolean> {
    const draft = this.drafts.get(draftId);
    if (
      !draft ||
      draft.userId !== userId ||
      draft.chatId !== chatId ||
      draft.status !== "DRAFTED"
    ) {
      return false;
    }
    draft.status = "CANCELLED";
    draft.updatedAt = new Date();
    return true;
  }

  public async saveConfirmation(confirmation: Confirmation): Promise<void> {
    this.confirmations.set(
      confirmation.tokenHash,
      structuredClone(confirmation),
    );
  }

  public async consumeConfirmationAndClaim(
    tokenHash: string,
    userId: string,
    chatId: string,
    now: Date,
  ): Promise<ClaimResult> {
    const confirmation = this.confirmations.get(tokenHash);
    if (!confirmation) {
      throw new ConfirmationRejectedError(
        "CONFIRMATION_NOT_FOUND",
        "Confirmation not found",
      );
    }
    if (confirmation.consumedAt) {
      throw new ConfirmationRejectedError(
        "CONFIRMATION_ALREADY_USED",
        "Confirmation already used",
      );
    }
    if (confirmation.expiresAt <= now) {
      throw new ConfirmationRejectedError(
        "CONFIRMATION_EXPIRED",
        "Confirmation expired",
      );
    }
    if (confirmation.userId !== userId || confirmation.chatId !== chatId) {
      throw new ConfirmationRejectedError(
        "CONFIRMATION_OWNER_MISMATCH",
        "Confirmation owner mismatch",
      );
    }
    const draft = this.drafts.get(confirmation.draftId);
    if (
      !draft ||
      draft.version !== confirmation.draftVersion ||
      draft.payloadHash !== confirmation.payloadHash
    ) {
      throw new ConfirmationRejectedError("STALE_DRAFT", "Stale draft");
    }
    if (draft.status !== "DRAFTED") {
      throw new ConfirmationRejectedError(
        "DRAFT_NOT_CONFIRMABLE",
        "Draft not confirmable",
      );
    }
    confirmation.consumedAt = now;
    draft.status = "EXECUTING";
    draft.updatedAt = now;
    const execution: ExecutionAttempt = {
      id: randomUUID(),
      draftId: draft.id,
      draftVersion: draft.version,
      requestHash: draft.payloadHash,
      state: "EXECUTING",
      createdAt: now,
      updatedAt: now,
    };
    this.executions.set(execution.id, execution);
    return {
      draft: structuredClone(draft),
      execution: structuredClone(execution),
    };
  }

  public async updateExecution(
    executionId: string,
    patch: Pick<ExecutionAttempt, "state"> &
      Partial<
        Pick<
          ExecutionAttempt,
          "clientOrderId" | "exchangeOrderId" | "result" | "errorCode"
        >
      >,
  ): Promise<void> {
    const execution = this.executions.get(executionId);
    if (!execution) throw new StoreConflictError("Execution not found");
    Object.assign(execution, structuredClone(patch), { updatedAt: new Date() });
  }

  public async updateDraftStatus(
    draftId: string,
    status: TradeDraft["status"],
  ): Promise<void> {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new StoreConflictError("Draft not found");
    draft.status = status;
    draft.updatedAt = new Date();
  }

  public async appendAudit(
    input: Omit<AuditEvent, "id" | "eventHash" | "previousHash" | "createdAt">,
  ): Promise<AuditEvent> {
    const previousHash = this.audits.at(-1)?.eventHash;
    const createdAt = new Date();
    const id = randomUUID();
    const eventHash = sha256(
      stableJson({
        id,
        ...input,
        previousHash: previousHash ?? null,
        createdAt: createdAt.toISOString(),
      }),
    );
    const event: AuditEvent = { id, ...input, eventHash, createdAt };
    if (previousHash) event.previousHash = previousHash;
    this.audits.push(event);
    return structuredClone(event);
  }

  public async getAuditEvents(
    entityId: string,
    limit = 20,
  ): Promise<AuditEvent[]> {
    return this.audits
      .filter((event) => event.entityId === entityId)
      .slice(-limit)
      .reverse()
      .map((event) => structuredClone(event));
  }

  public async saveOrders(orders: ExchangeOrder[]): Promise<void> {
    for (const order of orders)
      this.orders.set(order.clientOrderId, structuredClone(order));
  }

  public async savePositionSnapshots(
    positions: Position[],
    capturedAt: Date,
  ): Promise<void> {
    this.snapshots.push(
      ...positions.map((position) => ({
        position: structuredClone(position),
        capturedAt,
      })),
    );
  }

  public async saveFills(fills: TradeFill[]): Promise<void> {
    for (const fill of fills)
      this.fills.set(fill.exchangeFillId, structuredClone(fill));
  }

  public async saveTransactions(events: TransactionEvent[]): Promise<void> {
    for (const event of events)
      this.transactions.set(event.exchangeEventId, structuredClone(event));
  }

  public async claimAccountStreamEvent(
    event: AccountStreamEventClaim,
  ): Promise<AccountStreamClaimResult> {
    if (this.accountStreamEvents.has(event.eventKey)) return "DUPLICATE";
    const latest = this.accountStreamEntityTimes.get(event.entityKey);
    if (latest && latest > event.eventTime) return "OUT_OF_ORDER";
    this.accountStreamEvents.add(event.eventKey);
    this.accountStreamEntityTimes.set(event.entityKey, event.eventTime);
    return "CLAIMED";
  }

  public async getPnlLedger(
    start: Date | null,
    end: Date,
  ): Promise<PnlLedgerRows> {
    const includes = (date: Date): boolean =>
      date <= end && (start === null || date >= start);
    return {
      fills: [...this.fills.values()]
        .filter((fill) => includes(fill.occurredAt))
        .map((fill) => structuredClone(fill)),
      transactions: [...this.transactions.values()]
        .filter((event) => includes(event.occurredAt))
        .map((event) => structuredClone(event)),
    };
  }

  public async getReconciliationCursor(stream: string): Promise<Date | null> {
    return this.reconciliation.get(stream)?.cursor ?? null;
  }

  public async getReconciliationStatus(
    stream: string,
  ): Promise<ReconciliationStatus | null> {
    const status = this.reconciliation.get(stream);
    return status ? structuredClone(status) : null;
  }

  public async markReconciliation(
    stream: string,
    cursor: Date | null,
    success: boolean,
    errorCode?: string,
  ): Promise<void> {
    const existing = this.reconciliation.get(stream);
    const now = new Date();
    this.reconciliation.set(stream, {
      stream,
      cursor: success && cursor ? cursor : (existing?.cursor ?? null),
      lastSuccessAt: success ? now : (existing?.lastSuccessAt ?? null),
      lastErrorCode: success ? null : (errorCode ?? "UNKNOWN"),
      updatedAt: now,
    });
  }

  public async recordCommand(input: { updateId: number }): Promise<boolean> {
    if (this.commands.has(input.updateId)) return false;
    this.commands.add(input.updateId);
    return true;
  }

  public async finishCommand(): Promise<void> {}
}
