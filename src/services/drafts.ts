import { randomBytes } from "node:crypto";
import { Decimal } from "decimal.js";
import type {
  Confirmation,
  Currency,
  MutatingIntent,
  TradeDraft,
} from "../domain/types.js";
import { randomToken, sha256, stableJson } from "../security/crypto.js";
import type { EditCommand } from "../commands/parser.js";
import type { PreviewService } from "./preview.js";
import type { Store } from "../repositories/store.js";

export interface DraftEnvelope {
  draft: TradeDraft;
  confirmationToken: string;
}

export interface CalculatedDraft {
  intent: MutatingIntent;
  preview: TradeDraft["preview"];
}

export class DraftService {
  public constructor(
    private readonly store: Store,
    private readonly previewService: PreviewService,
    private readonly ttlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(
    intent: MutatingIntent,
    userId: string,
    chatId: string,
    defaultMarket: Currency,
  ): Promise<DraftEnvelope> {
    const calculated = await this.previewService.calculate(
      intent,
      defaultMarket,
    );
    return this.createCalculated(calculated, userId, chatId);
  }

  public async createCalculated(
    calculated: CalculatedDraft,
    userId: string,
    chatId: string,
  ): Promise<DraftEnvelope> {
    const now = this.now();
    const draft: TradeDraft = {
      id: newDraftId(),
      version: 1,
      status: "DRAFTED",
      userId,
      chatId,
      intent: calculated.intent,
      preview: calculated.preview,
      payloadHash: payloadHash(calculated.intent, calculated.preview),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createDraft(draft);
    const confirmationToken = await this.issueConfirmation(draft);
    await this.store.appendAudit({
      actorUserId: userId,
      actorChatId: chatId,
      action: "DRAFT_CREATED",
      entityType: "TRADE_DRAFT",
      entityId: draft.id,
      outcome: "SUCCESS",
      metadata: {
        version: draft.version,
        intentKind: calculated.intent.kind,
        payloadHash: draft.payloadHash,
      },
    });
    return { draft, confirmationToken };
  }

  public async edit(
    command: EditCommand,
    userId: string,
    chatId: string,
    defaultMarket: Currency,
  ): Promise<DraftEnvelope> {
    const existing = await this.store.getDraft(command.draftId);
    if (!existing || existing.userId !== userId || existing.chatId !== chatId) {
      throw new DraftError("DRAFT_NOT_FOUND", "Draft was not found.");
    }
    if (existing.status !== "DRAFTED") {
      throw new DraftError(
        "DRAFT_NOT_EDITABLE",
        `Draft is ${existing.status.toLowerCase()}.`,
      );
    }
    if (existing.expiresAt <= this.now()) {
      throw new DraftError(
        "DRAFT_EXPIRED",
        "Draft expired; create a new command.",
      );
    }
    const editedIntent = applyEdit(existing, command);
    const calculated = await this.previewService.calculate(
      editedIntent,
      defaultMarket,
    );
    const now = this.now();
    const updated: TradeDraft = {
      ...existing,
      version: existing.version + 1,
      intent: calculated.intent,
      preview: calculated.preview,
      payloadHash: payloadHash(calculated.intent, calculated.preview),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000),
      updatedAt: now,
    };
    await this.store.replaceDraft(updated, existing.version);
    const confirmationToken = await this.issueConfirmation(updated);
    await this.store.appendAudit({
      actorUserId: userId,
      actorChatId: chatId,
      action: "DRAFT_EDITED",
      entityType: "TRADE_DRAFT",
      entityId: updated.id,
      outcome: "SUCCESS",
      metadata: {
        previousVersion: existing.version,
        version: updated.version,
        field: command.field,
        payloadHash: updated.payloadHash,
      },
    });
    return { draft: updated, confirmationToken };
  }

  public async cancel(
    draftId: string,
    userId: string,
    chatId: string,
  ): Promise<boolean> {
    const cancelled = await this.store.cancelDraft(
      draftId.toUpperCase(),
      userId,
      chatId,
    );
    await this.store.appendAudit({
      actorUserId: userId,
      actorChatId: chatId,
      action: "DRAFT_CANCELLED",
      entityType: "TRADE_DRAFT",
      entityId: draftId.toUpperCase(),
      outcome: cancelled ? "SUCCESS" : "NOT_FOUND_OR_NOT_EDITABLE",
      metadata: {},
    });
    return cancelled;
  }

  private async issueConfirmation(draft: TradeDraft): Promise<string> {
    const token = randomToken(16);
    const confirmation: Confirmation = {
      tokenHash: sha256(token),
      draftId: draft.id,
      draftVersion: draft.version,
      userId: draft.userId,
      chatId: draft.chatId,
      payloadHash: draft.payloadHash,
      expiresAt: draft.expiresAt,
    };
    await this.store.saveConfirmation(confirmation);
    return token;
  }
}

export class DraftError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DraftError";
  }
}

function newDraftId(): string {
  return `T-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function payloadHash(
  intent: MutatingIntent,
  preview: TradeDraft["preview"],
): string {
  return sha256(stableJson({ intent, preview }));
}

function applyEdit(draft: TradeDraft, command: EditCommand): MutatingIntent {
  const intent = structuredClone(draft.intent);
  switch (command.field) {
    case "margin": {
      if (intent.kind !== "TRADE")
        throw unsupported(command.field, intent.kind);
      if (command.values.length !== 2)
        throw syntax("Margin edit requires AMOUNT and INR|USDT.");
      intent.marginAmount = positiveDecimal(command.values[0], "margin amount");
      intent.requestedMarginAsset = editCurrency(command.values[1]);
      return clearResolvedSymbol(intent);
    }
    case "leverage": {
      if (intent.kind !== "TRADE")
        throw unsupported(command.field, intent.kind);
      if (command.values.length !== 1)
        throw syntax("Leverage edit requires one whole number.");
      intent.leverage = positiveInteger(command.values[0], "leverage");
      return intent;
    }
    case "market": {
      if (!("symbolInput" in intent))
        throw unsupported(command.field, intent.kind);
      if (command.values.length !== 1)
        throw syntax("Market edit requires one full symbol or asset.");
      intent.symbolInput = editSymbol(command.values[0]);
      return clearResolvedSymbol(intent);
    }
    case "order": {
      if (intent.kind !== "TRADE" && intent.kind !== "CLOSE") {
        throw unsupported(command.field, intent.kind);
      }
      if (command.values.length < 1 || command.values.length > 2) {
        throw syntax("Order edit requires market or limit [PRICE].");
      }
      const type = command.values[0]?.toUpperCase();
      if (type !== "MARKET" && type !== "LIMIT")
        throw syntax("Order must be market or limit.");
      intent.orderType = type;
      if (type === "MARKET") {
        delete intent.limitPrice;
      } else {
        intent.limitPrice = command.values[1]
          ? positiveDecimal(command.values[1], "limit price")
          : requiredEstimate(draft.preview.estimatedEntryPrice);
      }
      return intent;
    }
    case "price": {
      if (intent.kind !== "TRADE" && intent.kind !== "CLOSE") {
        throw unsupported(command.field, intent.kind);
      }
      if (command.values.length !== 1)
        throw syntax("Price edit requires one price.");
      intent.orderType = "LIMIT";
      intent.limitPrice = positiveDecimal(command.values[0], "limit price");
      return intent;
    }
    case "mode": {
      if (intent.kind !== "TRADE")
        throw unsupported(command.field, intent.kind);
      if (command.values.length !== 1)
        throw syntax("Mode edit requires isolated or cross.");
      const mode = command.values[0]?.toUpperCase();
      if (mode !== "ISOLATED" && mode !== "CROSS")
        throw syntax("Mode must be isolated or cross.");
      intent.marginMode = mode;
      return intent;
    }
  }
}

function clearResolvedSymbol<T extends MutatingIntent>(intent: T): T {
  if ("symbol" in intent) delete intent.symbol;
  return intent;
}

function positiveDecimal(value: string | undefined, field: string): string {
  try {
    const parsed = new Decimal(value ?? "");
    if (!parsed.isPositive() || !parsed.isFinite())
      throw new Error("not positive");
    return parsed.toString();
  } catch {
    throw syntax(`${field} must be a positive number.`);
  }
}

function positiveInteger(value: string | undefined, field: string): number {
  if (!value || !/^\d+$/.test(value))
    throw syntax(`${field} must be a positive whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw syntax(`${field} is invalid.`);
  return parsed;
}

function editCurrency(value: string | undefined): Currency {
  const parsed = value?.toUpperCase();
  if (parsed !== "INR" && parsed !== "USDT")
    throw syntax("Currency must be INR or USDT.");
  return parsed;
}

function editSymbol(value: string | undefined): string {
  const parsed = value?.toUpperCase();
  if (!parsed || !/^[A-Z0-9]{2,20}$/.test(parsed))
    throw syntax("Symbol is invalid.");
  return parsed;
}

function requiredEstimate(value: string | undefined): string {
  if (!value) throw syntax("Provide a limit price when switching order type.");
  return value;
}

function syntax(message: string): DraftError {
  return new DraftError("INVALID_EDIT", message);
}

function unsupported(field: string, kind: string): DraftError {
  return new DraftError(
    "EDIT_NOT_SUPPORTED",
    `Cannot edit ${field} on a ${kind} draft.`,
  );
}
