import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
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

const { Pool } = pg;

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  public constructor(databaseUrl: string, pool?: pg.Pool) {
    this.pool = pool ?? new Pool({ connectionString: databaseUrl, max: 10 });
  }

  public async migrate(): Promise<void> {
    const directory = join(process.cwd(), "migrations");
    const migrations = (await readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(directory, migration), "utf8");
      await this.pool.query(sql);
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async getOrCreatePrincipal(
    userId: string,
    chatId: string,
  ): Promise<Principal> {
    const result = await this.pool.query(
      `INSERT INTO telegram_principals (user_id, chat_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, updated_at = now()
       RETURNING *`,
      [userId, chatId],
    );
    return principalFromRow(requiredRow(result.rows));
  }

  public async setDefaultMarket(
    userId: string,
    chatId: string,
    market: Currency,
  ): Promise<Principal> {
    const result = await this.pool.query(
      `UPDATE telegram_principals
       SET default_market = $3, updated_at = now()
       WHERE user_id = $1 AND chat_id = $2
       RETURNING *`,
      [userId, chatId, market],
    );
    if (result.rowCount !== 1)
      throw new StoreConflictError("Principal not found");
    return principalFromRow(requiredRow(result.rows));
  }

  public async createDraft(draft: TradeDraft): Promise<void> {
    await this.pool.query(
      `INSERT INTO trade_drafts
       (id, version, status, user_id, chat_id, intent, preview, payload_hash, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)`,
      draftParams(draft),
    );
  }

  public async getDraft(draftId: string): Promise<TradeDraft | null> {
    const result = await this.pool.query(
      "SELECT * FROM trade_drafts WHERE id = $1",
      [draftId],
    );
    return result.rowCount ? draftFromRow(requiredRow(result.rows)) : null;
  }

  public async replaceDraft(
    draft: TradeDraft,
    expectedVersion: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE trade_drafts SET
         version=$2, status=$3, intent=$6::jsonb, preview=$7::jsonb,
         payload_hash=$8, expires_at=$9, updated_at=$11
       WHERE id=$1 AND user_id=$4 AND chat_id=$5 AND version=$12 AND status='DRAFTED'`,
      [...draftParams(draft), expectedVersion],
    );
    if (result.rowCount !== 1)
      throw new StoreConflictError(
        "Draft was changed or is no longer editable",
      );
    await this.pool.query(
      "UPDATE draft_confirmations SET expires_at = now() WHERE draft_id = $1 AND consumed_at IS NULL",
      [draft.id],
    );
  }

  public async cancelDraft(
    draftId: string,
    userId: string,
    chatId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE trade_drafts SET status='CANCELLED', updated_at=now()
       WHERE id=$1 AND user_id=$2 AND chat_id=$3 AND status='DRAFTED'`,
      [draftId, userId, chatId],
    );
    await this.pool.query(
      "UPDATE draft_confirmations SET expires_at=now() WHERE draft_id=$1 AND consumed_at IS NULL",
      [draftId],
    );
    return result.rowCount === 1;
  }

  public async saveConfirmation(confirmation: Confirmation): Promise<void> {
    await this.pool.query(
      `INSERT INTO draft_confirmations
       (token_hash, draft_id, draft_version, user_id, chat_id, payload_hash, expires_at, consumed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        confirmation.tokenHash,
        confirmation.draftId,
        confirmation.draftVersion,
        confirmation.userId,
        confirmation.chatId,
        confirmation.payloadHash,
        confirmation.expiresAt,
        confirmation.consumedAt ?? null,
      ],
    );
  }

  public async consumeConfirmationAndClaim(
    tokenHash: string,
    userId: string,
    chatId: string,
    now: Date,
  ): Promise<ClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const confirmationResult = await client.query(
        "SELECT * FROM draft_confirmations WHERE token_hash=$1 FOR UPDATE",
        [tokenHash],
      );
      if (!confirmationResult.rowCount) {
        throw new ConfirmationRejectedError(
          "CONFIRMATION_NOT_FOUND",
          "Confirmation was not found.",
        );
      }
      const confirmation = confirmationFromRow(
        requiredRow(confirmationResult.rows),
      );
      if (confirmation.consumedAt) {
        throw new ConfirmationRejectedError(
          "CONFIRMATION_ALREADY_USED",
          "Confirmation was already used.",
        );
      }
      if (confirmation.expiresAt <= now) {
        throw new ConfirmationRejectedError(
          "CONFIRMATION_EXPIRED",
          "Confirmation expired.",
        );
      }
      if (confirmation.userId !== userId || confirmation.chatId !== chatId) {
        throw new ConfirmationRejectedError(
          "CONFIRMATION_OWNER_MISMATCH",
          "Confirmation does not belong to this user/chat.",
        );
      }
      const draftResult = await client.query(
        "SELECT * FROM trade_drafts WHERE id=$1 FOR UPDATE",
        [confirmation.draftId],
      );
      if (!draftResult.rowCount) {
        throw new ConfirmationRejectedError(
          "STALE_DRAFT",
          "Draft no longer exists.",
        );
      }
      const draft = draftFromRow(requiredRow(draftResult.rows));
      if (
        draft.version !== confirmation.draftVersion ||
        draft.payloadHash !== confirmation.payloadHash
      ) {
        throw new ConfirmationRejectedError(
          "STALE_DRAFT",
          "Draft was edited; confirm the latest preview.",
        );
      }
      if (draft.status !== "DRAFTED") {
        throw new ConfirmationRejectedError(
          "DRAFT_NOT_CONFIRMABLE",
          `Draft is ${draft.status.toLowerCase()}.`,
        );
      }
      if (draft.expiresAt <= now) {
        throw new ConfirmationRejectedError(
          "CONFIRMATION_EXPIRED",
          "Draft expired.",
        );
      }

      const execution: ExecutionAttempt = {
        id: randomUUID(),
        draftId: draft.id,
        draftVersion: draft.version,
        requestHash: draft.payloadHash,
        state: "EXECUTING",
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        "UPDATE draft_confirmations SET consumed_at=$2 WHERE token_hash=$1",
        [tokenHash, now],
      );
      await client.query(
        "UPDATE trade_drafts SET status='EXECUTING', updated_at=$2 WHERE id=$1",
        [draft.id, now],
      );
      await client.query(
        `INSERT INTO execution_attempts
         (id,draft_id,draft_version,request_hash,state,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          execution.id,
          execution.draftId,
          execution.draftVersion,
          execution.requestHash,
          execution.state,
          execution.createdAt,
          execution.updatedAt,
        ],
      );
      await client.query("COMMIT");
      return {
        draft: { ...draft, status: "EXECUTING", updatedAt: now },
        execution,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    await this.pool.query(
      `UPDATE execution_attempts SET
       state=$2, client_order_id=COALESCE($3,client_order_id),
       exchange_order_id=COALESCE($4,exchange_order_id), result=COALESCE($5::jsonb,result),
       error_code=$6, updated_at=now() WHERE id=$1`,
      [
        executionId,
        patch.state,
        patch.clientOrderId ?? null,
        patch.exchangeOrderId ?? null,
        patch.result === undefined ? null : JSON.stringify(patch.result),
        patch.errorCode ?? null,
      ],
    );
  }

  public async updateDraftStatus(
    draftId: string,
    status: TradeDraft["status"],
  ): Promise<void> {
    await this.pool.query(
      "UPDATE trade_drafts SET status=$2,updated_at=now() WHERE id=$1",
      [draftId, status],
    );
  }

  public async appendAudit(
    event: Omit<AuditEvent, "id" | "eventHash" | "previousHash" | "createdAt">,
  ): Promise<AuditEvent> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE audit_events IN SHARE ROW EXCLUSIVE MODE");
      const previousResult = await client.query(
        "SELECT event_hash FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1",
      );
      const previousHash = previousResult.rowCount
        ? String(requiredRow(previousResult.rows).event_hash)
        : undefined;
      const createdAt = new Date();
      const id = randomUUID();
      const eventHash = sha256(
        stableJson({
          id,
          ...event,
          previousHash: previousHash ?? null,
          createdAt: createdAt.toISOString(),
        }),
      );
      await client.query(
        `INSERT INTO audit_events
         (id,actor_user_id,actor_chat_id,action,entity_type,entity_id,outcome,metadata,previous_hash,event_hash,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          id,
          event.actorUserId ?? null,
          event.actorChatId ?? null,
          event.action,
          event.entityType,
          event.entityId ?? null,
          event.outcome,
          JSON.stringify(event.metadata),
          previousHash ?? null,
          eventHash,
          createdAt,
        ],
      );
      await client.query("COMMIT");
      const result: AuditEvent = { id, ...event, eventHash, createdAt };
      if (previousHash) result.previousHash = previousHash;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async getAuditEvents(
    entityId: string,
    limit = 20,
  ): Promise<AuditEvent[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_events WHERE entity_id=$1 ORDER BY created_at DESC LIMIT $2",
      [entityId, Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows.map(auditFromRow);
  }

  public async saveOrders(orders: ExchangeOrder[]): Promise<void> {
    for (const order of orders) {
      await this.pool.query(
        `INSERT INTO exchange_orders
         (client_order_id,symbol,order_type,side,price,order_amount,filled_amount,reduce_only,status,margin_asset,position_id,raw,exchange_created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
         ON CONFLICT (client_order_id) DO UPDATE SET
         filled_amount=EXCLUDED.filled_amount,status=EXCLUDED.status,raw=EXCLUDED.raw,updated_at=now()`,
        [
          order.clientOrderId,
          order.symbol,
          order.type,
          order.side,
          order.price,
          order.orderAmount,
          order.filledAmount,
          order.reduceOnly ?? null,
          order.status ?? null,
          order.marginAsset ?? null,
          order.positionId ?? null,
          JSON.stringify(order.raw ?? order),
          order.createdAt ?? null,
        ],
      );
    }
  }

  public async savePositionSnapshots(
    positions: Position[],
    capturedAt: Date,
  ): Promise<void> {
    for (const position of positions) {
      await this.pool.query(
        `INSERT INTO position_snapshots (position_id,symbol,status,snapshot,captured_at)
         VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,
        [
          position.positionId,
          position.symbol,
          position.status,
          JSON.stringify(position),
          capturedAt,
        ],
      );
    }
  }

  public async saveFills(fills: TradeFill[]): Promise<void> {
    for (const fill of fills) {
      await this.pool.query(
        `INSERT INTO exchange_fills
         (exchange_fill_id,client_order_id,symbol,side,order_type,price,quantity,fee,realised_profit,margin_asset,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [
          fill.exchangeFillId,
          fill.clientOrderId,
          fill.symbol,
          fill.side,
          fill.orderType,
          fill.price,
          fill.quantity,
          fill.fee,
          fill.realisedProfit,
          fill.marginAsset,
          fill.occurredAt,
        ],
      );
    }
  }

  public async saveTransactions(events: TransactionEvent[]): Promise<void> {
    for (const event of events) {
      await this.pool.query(
        `INSERT INTO wallet_events
         (exchange_event_id,event_type,amount,asset,symbol,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          event.exchangeEventId,
          event.type,
          event.amount,
          event.asset,
          event.symbol ?? null,
          event.occurredAt,
        ],
      );
    }
  }

  public async claimAccountStreamEvent(
    event: AccountStreamEventClaim,
  ): Promise<AccountStreamClaimResult> {
    const result = await this.pool.query(
      `INSERT INTO account_stream_events
       (event_key,entity_key,event_type,event_time,payload_hash)
       SELECT $1,$2,$3,$4,$5
       WHERE NOT EXISTS (
         SELECT 1 FROM account_stream_events
         WHERE entity_key=$2 AND event_time > $4
       )
       ON CONFLICT (event_key) DO NOTHING
       RETURNING event_key`,
      [
        event.eventKey,
        event.entityKey,
        event.eventType,
        event.eventTime,
        event.payloadHash,
      ],
    );
    if (result.rowCount === 1) return "CLAIMED";
    const duplicate = await this.pool.query(
      "SELECT 1 FROM account_stream_events WHERE event_key=$1",
      [event.eventKey],
    );
    return duplicate.rowCount ? "DUPLICATE" : "OUT_OF_ORDER";
  }

  public async getPnlLedger(
    start: Date | null,
    end: Date,
  ): Promise<PnlLedgerRows> {
    const fillResult = await this.pool.query(
      `SELECT * FROM exchange_fills
       WHERE occurred_at <= $2 AND ($1::timestamptz IS NULL OR occurred_at >= $1)
       ORDER BY occurred_at`,
      [start, end],
    );
    const eventResult = await this.pool.query(
      `SELECT * FROM wallet_events
       WHERE occurred_at <= $2 AND ($1::timestamptz IS NULL OR occurred_at >= $1)
       ORDER BY occurred_at`,
      [start, end],
    );
    return {
      fills: fillResult.rows.map(fillFromRow),
      transactions: eventResult.rows.map(transactionFromRow),
    };
  }

  public async getReconciliationCursor(stream: string): Promise<Date | null> {
    const result = await this.pool.query(
      "SELECT cursor_time FROM reconciliation_state WHERE stream=$1",
      [stream],
    );
    if (!result.rowCount) return null;
    const value = requiredRow(result.rows).cursor_time;
    return value ? new Date(String(value)) : null;
  }

  public async getReconciliationStatus(
    stream: string,
  ): Promise<ReconciliationStatus | null> {
    const result = await this.pool.query(
      "SELECT * FROM reconciliation_state WHERE stream=$1",
      [stream],
    );
    if (!result.rowCount) return null;
    const row = requiredRow(result.rows);
    return {
      stream: String(row.stream),
      cursor: row.cursor_time ? new Date(String(row.cursor_time)) : null,
      lastSuccessAt: row.last_success_at
        ? new Date(String(row.last_success_at))
        : null,
      lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
      updatedAt: new Date(String(row.updated_at)),
    };
  }

  public async markReconciliation(
    stream: string,
    cursor: Date | null,
    success: boolean,
    errorCode?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO reconciliation_state
       (stream,cursor_time,last_success_at,last_error_code)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (stream) DO UPDATE SET cursor_time=COALESCE(EXCLUDED.cursor_time,reconciliation_state.cursor_time),
       last_success_at=COALESCE(EXCLUDED.last_success_at,reconciliation_state.last_success_at),
       last_error_code=EXCLUDED.last_error_code,updated_at=now()`,
      [
        stream,
        cursor,
        success ? new Date() : null,
        success ? null : (errorCode ?? "UNKNOWN"),
      ],
    );
  }

  public async recordCommand(input: {
    id: string;
    updateId: number;
    userId?: string;
    chatId?: string;
    commandName: string;
    parsedIntent?: unknown;
    outcome: string;
    errorCode?: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO command_events
       (id,telegram_update_id,actor_user_id,actor_chat_id,command_name,parsed_intent,outcome,error_code)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (telegram_update_id) DO NOTHING`,
      [
        input.id,
        input.updateId,
        input.userId ?? null,
        input.chatId ?? null,
        input.commandName,
        input.parsedIntent === undefined
          ? null
          : JSON.stringify(input.parsedIntent),
        input.outcome,
        input.errorCode ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  public async finishCommand(
    updateId: number,
    outcome: string,
    parsedIntent?: unknown,
    errorCode?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE command_events SET outcome=$2,
       parsed_intent=COALESCE($3::jsonb, parsed_intent), error_code=$4
       WHERE telegram_update_id=$1`,
      [
        updateId,
        outcome,
        parsedIntent === undefined ? null : JSON.stringify(parsedIntent),
        errorCode ?? null,
      ],
    );
  }
}

function draftParams(draft: TradeDraft): unknown[] {
  return [
    draft.id,
    draft.version,
    draft.status,
    draft.userId,
    draft.chatId,
    JSON.stringify(draft.intent),
    JSON.stringify(draft.preview),
    draft.payloadHash,
    draft.expiresAt,
    draft.createdAt,
    draft.updatedAt,
  ];
}

function requiredRow(rows: pg.QueryResultRow[]): pg.QueryResultRow {
  const row = rows[0];
  if (!row) throw new StoreConflictError("Expected database row was missing");
  return row;
}

function principalFromRow(row: pg.QueryResultRow): Principal {
  return {
    userId: String(row.user_id),
    chatId: String(row.chat_id),
    defaultMarket: String(row.default_market) as Currency,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function draftFromRow(row: pg.QueryResultRow): TradeDraft {
  const preview = row.preview as TradeDraft["preview"];
  preview.calculatedAt = new Date(preview.calculatedAt);
  return {
    id: String(row.id),
    version: Number(row.version),
    status: String(row.status) as TradeDraft["status"],
    userId: String(row.user_id),
    chatId: String(row.chat_id),
    intent: row.intent as TradeDraft["intent"],
    preview,
    payloadHash: String(row.payload_hash),
    expiresAt: new Date(String(row.expires_at)),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function confirmationFromRow(row: pg.QueryResultRow): Confirmation {
  const result: Confirmation = {
    tokenHash: String(row.token_hash),
    draftId: String(row.draft_id),
    draftVersion: Number(row.draft_version),
    userId: String(row.user_id),
    chatId: String(row.chat_id),
    payloadHash: String(row.payload_hash),
    expiresAt: new Date(String(row.expires_at)),
  };
  if (row.consumed_at) result.consumedAt = new Date(String(row.consumed_at));
  return result;
}

function auditFromRow(row: pg.QueryResultRow): AuditEvent {
  const event: AuditEvent = {
    id: String(row.id),
    action: String(row.action),
    entityType: String(row.entity_type),
    outcome: String(row.outcome),
    metadata: row.metadata as Record<string, unknown>,
    eventHash: String(row.event_hash),
    createdAt: new Date(String(row.created_at)),
  };
  if (row.actor_user_id) event.actorUserId = String(row.actor_user_id);
  if (row.actor_chat_id) event.actorChatId = String(row.actor_chat_id);
  if (row.entity_id) event.entityId = String(row.entity_id);
  if (row.previous_hash) event.previousHash = String(row.previous_hash);
  return event;
}

function fillFromRow(row: pg.QueryResultRow): TradeFill {
  return {
    exchangeFillId: String(row.exchange_fill_id),
    clientOrderId: String(row.client_order_id),
    symbol: String(row.symbol),
    side: String(row.side) as TradeFill["side"],
    orderType: String(row.order_type),
    price: String(row.price),
    quantity: String(row.quantity),
    fee: String(row.fee),
    realisedProfit: String(row.realised_profit),
    marginAsset: String(row.margin_asset) as Currency,
    occurredAt: new Date(String(row.occurred_at)),
  };
}

function transactionFromRow(row: pg.QueryResultRow): TransactionEvent {
  const event: TransactionEvent = {
    exchangeEventId: String(row.exchange_event_id),
    type: String(row.event_type),
    amount: String(row.amount),
    asset: String(row.asset) as Currency,
    occurredAt: new Date(String(row.occurred_at)),
  };
  if (row.symbol) event.symbol = String(row.symbol);
  return event;
}
