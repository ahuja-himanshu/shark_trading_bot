import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { helpText } from "../commands/catalog.js";
import {
  CommandParseError,
  parseCommand,
  type ParsedCommand,
} from "../commands/parser.js";
import type { Currency, MutatingIntent, Position } from "../domain/types.js";
import { SharkApiError } from "../exchange/shark-client.js";
import type { SharkExchangePort } from "../exchange/port.js";
import {
  ConfirmationRejectedError,
  type Store,
} from "../repositories/store.js";
import { authorizeTelegramIdentity } from "../security/authorization.js";
import { redact } from "../security/redaction.js";
import { DraftError, type DraftService } from "../services/drafts.js";
import {
  ExecutionError,
  type ExecutionService,
} from "../services/execution.js";
import { istDayRange, istToday, type PnlService } from "../services/pnl.js";
import { PreviewError } from "../services/preview.js";
import type { UnrealisedPnlEstimator } from "../services/unrealised-pnl.js";
import type { RuntimeHealthProvider, StreamHealth } from "../streams/health.js";
import type { TelegramApi } from "./api.js";
import {
  draftKeyboard,
  editPrompt,
  formatAudit,
  formatDraft,
  formatOrders,
  formatPnl,
  formatPositions,
  formatPreviewHelp,
  formatWallet,
  parseEditReply,
} from "./formatters.js";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

interface ControllerOptions {
  allowedUserId: string;
  allowedChatId: string;
  tradingEnabled: boolean;
}

export class TelegramController {
  public constructor(
    private readonly telegram: TelegramApi,
    private readonly exchange: SharkExchangePort,
    private readonly store: Store,
    private readonly drafts: DraftService,
    private readonly execution: ExecutionService,
    private readonly pnl: PnlService,
    private readonly logger: Logger,
    private readonly options: ControllerOptions,
    private readonly runtimeHealth?: RuntimeHealthProvider,
    private readonly unrealisedPnl?: UnrealisedPnlEstimator,
  ) {}

  public async handle(update: TelegramUpdate): Promise<void> {
    const identity = identityFromUpdate(update);
    const authorization = authorizeTelegramIdentity(identity, {
      allowedUserId: this.options.allowedUserId,
      allowedChatId: this.options.allowedChatId,
    });
    if (!authorization.allowed) {
      await this.store
        .recordCommand({
          id: randomUUID(),
          updateId: update.update_id,
          ...(identity.userId ? { userId: identity.userId } : {}),
          ...(identity.chatId ? { chatId: identity.chatId } : {}),
          commandName: "UNAUTHORISED_UPDATE",
          outcome: "REJECTED",
          ...(authorization.reason ? { errorCode: authorization.reason } : {}),
        })
        .catch(() => undefined);
      if (update.callback_query) {
        await this.telegram
          .answerCallbackQuery(update.callback_query.id, "Unauthorised", true)
          .catch(() => undefined);
      }
      this.logger.warn(
        { reason: authorization.reason },
        "Rejected Telegram update",
      );
      return;
    }

    const userId = identity.userId as string;
    const chatId = identity.chatId as string;
    const accepted = await this.store.recordCommand({
      id: randomUUID(),
      updateId: update.update_id,
      userId,
      chatId,
      commandName: update.callback_query
        ? "CALLBACK"
        : commandName(update.message?.text),
      outcome: "RECEIVED",
    });
    if (!accepted) return;

    try {
      let parsedIntent: unknown;
      if (update.callback_query) {
        parsedIntent = await this.handleCallback(
          update.callback_query,
          userId,
          chatId,
        );
      } else if (update.message) {
        parsedIntent = await this.handleMessage(update.message, userId, chatId);
      }
      await this.store.finishCommand(update.update_id, "SUCCESS", parsedIntent);
    } catch (error) {
      const code = appErrorCode(error);
      await this.store
        .finishCommand(update.update_id, "FAILED", undefined, code)
        .catch(() => undefined);
      this.logger.error(
        { error: redact(error), code },
        "Telegram update failed",
      );
      await this.sendText(chatId, `ERROR ${code}\n${safeMessage(error)}`);
    }
  }

  private async handleMessage(
    message: TelegramMessage,
    userId: string,
    chatId: string,
  ): Promise<ParsedCommand | null> {
    const text = message.text?.trim();
    if (!text) return null;
    const editReply = parseEditReply(message);
    const parsed = parseCommand(editReply ?? text);
    const principal = await this.store.getOrCreatePrincipal(userId, chatId);
    await this.dispatch(parsed, userId, chatId, principal.defaultMarket);
    return parsed;
  }

  private async dispatch(
    parsed: ParsedCommand,
    userId: string,
    chatId: string,
    defaultMarket: Currency,
  ): Promise<void> {
    switch (parsed.kind) {
      case "HELP":
        await this.sendText(chatId, HELP_TEXT);
        return;
      case "HEALTH":
        await this.health(chatId);
        return;
      case "WALLET":
        await this.wallet(chatId, parsed.asset ?? "ALL");
        return;
      case "MARKETS":
        await this.markets(chatId, parsed.asset);
        return;
      case "DEFAULT_MARKET": {
        const principal = await this.store.setDefaultMarket(
          userId,
          chatId,
          parsed.market,
        );
        await this.sendText(
          chatId,
          `Default market set to ${principal.defaultMarket}.`,
        );
        return;
      }
      case "OPEN_POSITIONS":
        await this.sendText(
          chatId,
          formatPositions(
            await this.enrichPositions(
              await this.exchange.getPositions("OPEN"),
            ),
          ),
        );
        return;
      case "POSITION":
        await this.position(chatId, parsed.symbol, defaultMarket);
        return;
      case "OPEN_ORDERS":
        await this.sendText(
          chatId,
          formatOrders(await this.exchange.getOpenOrders(parsed.symbol)),
        );
        return;
      case "PNL":
        await this.pnlCommand(chatId, parsed);
        return;
      case "AUDIT":
        await this.sendText(
          chatId,
          formatAudit(await this.store.getAuditEvents(parsed.entityId)),
        );
        return;
      case "EDIT": {
        const envelope = await this.drafts.edit(
          parsed,
          userId,
          chatId,
          defaultMarket,
        );
        await this.sendDraft(
          chatId,
          envelope.draft,
          envelope.confirmationToken,
        );
        return;
      }
      case "CANCEL": {
        if (parsed.targetId.toUpperCase().startsWith("T-")) {
          const cancelled = await this.drafts.cancel(
            parsed.targetId,
            userId,
            chatId,
          );
          await this.sendText(
            chatId,
            cancelled
              ? `Draft ${parsed.targetId.toUpperCase()} cancelled.`
              : "Draft was not found or is no longer editable.",
          );
          return;
        }
        await this.createDraft(
          { kind: "CANCEL_ORDER", clientOrderId: parsed.targetId },
          userId,
          chatId,
          defaultMarket,
        );
        return;
      }
      default:
        await this.createDraft(parsed, userId, chatId, defaultMarket);
    }
  }

  private async createDraft(
    intent: MutatingIntent,
    userId: string,
    chatId: string,
    defaultMarket: Currency,
  ): Promise<void> {
    const envelope = await this.drafts.create(
      intent,
      userId,
      chatId,
      defaultMarket,
    );
    await this.sendDraft(chatId, envelope.draft, envelope.confirmationToken);
  }

  private async sendDraft(
    chatId: string,
    draft: Awaited<ReturnType<DraftService["create"]>>["draft"],
    token: string,
  ): Promise<void> {
    await this.sendText(
      chatId,
      formatDraft(draft),
      draftKeyboard(draft.id, token),
    );
    await this.sendText(chatId, formatPreviewHelp(draft.id));
  }

  private async handleCallback(
    callback: TelegramCallbackQuery,
    userId: string,
    chatId: string,
  ): Promise<Record<string, string>> {
    const data = callback.data ?? "";
    if (data.startsWith("c:")) {
      await this.telegram.answerCallbackQuery(
        callback.id,
        "Processing confirmed draft…",
      );
      const result = await this.execution.confirm(
        data.slice(2),
        userId,
        chatId,
      );
      await this.sendText(chatId, `${result.state}: ${result.message}`);
      if (result.refreshedDraft) {
        await this.sendDraft(
          chatId,
          result.refreshedDraft.draft,
          result.refreshedDraft.confirmationToken,
        );
      }
      return {
        action: "CONFIRM",
        state: result.state,
        draftId: result.draftId,
      };
    }
    if (data.startsWith("x:")) {
      const id = data.slice(2);
      const cancelled = await this.drafts.cancel(id, userId, chatId);
      await this.telegram.answerCallbackQuery(
        callback.id,
        cancelled ? "Draft cancelled" : "Cannot cancel draft",
        !cancelled,
      );
      return {
        action: "CANCEL_DRAFT",
        draftId: id,
        result: String(cancelled),
      };
    }
    const edit = data.match(
      /^e:(T-[A-F0-9]{12}):(margin|leverage|market|order|price|mode)$/,
    );
    if (edit) {
      const draftId = edit[1] as string;
      const field = edit[2] as string;
      const draft = await this.store.getDraft(draftId);
      if (
        !draft ||
        draft.userId !== userId ||
        draft.chatId !== chatId ||
        draft.status !== "DRAFTED"
      ) {
        await this.telegram.answerCallbackQuery(
          callback.id,
          "Draft is no longer editable",
          true,
        );
        return { action: "EDIT_PROMPT_REJECTED", draftId };
      }
      await this.telegram.answerCallbackQuery(callback.id);
      await this.telegram.sendMessage(chatId, editPrompt(draftId, field), {
        force_reply: true,
        selective: true,
        input_field_placeholder: "Enter the new value",
      });
      return { action: "EDIT_PROMPT", draftId, field };
    }
    await this.telegram.answerCallbackQuery(
      callback.id,
      "Unknown action",
      true,
    );
    return { action: "UNKNOWN_CALLBACK" };
  }

  private async wallet(chatId: string, asset: Currency | "ALL"): Promise<void> {
    // Shark accounts hold INR balances only (USDT deposits are not
    // supported), so "all" resolves to the INR wallet. An explicit
    // `/wallet USDT` is still passed through to the exchange.
    const target = asset === "ALL" ? "INR" : asset;
    await this.sendText(
      chatId,
      formatWallet(await this.exchange.getWallet(target)),
    );
  }

  private async health(chatId: string): Promise<void> {
    const status = await this.store.getReconciliationStatus("ACCOUNT_LEDGER");
    const reconciliation = !status
      ? "NOT RUN"
      : status.lastErrorCode
        ? `FAILED (${status.lastErrorCode}) at ${status.updatedAt.toISOString()}`
        : status.lastSuccessAt
          ? `OK at ${status.lastSuccessAt.toISOString()}`
          : "NOT YET SUCCESSFUL";
    const runtime = this.runtimeHealth?.getHealth();
    await this.sendText(
      chatId,
      [
        "Service running",
        `Mode: ${this.options.tradingEnabled ? "TRADING ENABLED" : "READ ONLY"}`,
        `Reconciliation: ${reconciliation}`,
        ...(runtime
          ? [
              formatStreamHealth("Public market stream", runtime.publicMarket),
              `Market subscriptions: ${runtime.publicMarket.subscriptions} | sequence gaps: ${runtime.publicMarket.sequenceGaps}`,
              `Market invalid/stale: ${runtime.publicMarket.invalidMessages}/${runtime.publicMarket.staleDetections}`,
              formatStreamHealth(
                "Authenticated account stream",
                runtime.authenticatedAccount,
              ),
              `Account resyncs: ${runtime.authenticatedAccount.accountResyncs} | queue overflows: ${runtime.authenticatedAccount.queueOverflows}`,
              `Account duplicate/out-of-order: ${runtime.authenticatedAccount.duplicateEvents}/${runtime.authenticatedAccount.outOfOrderEvents} | invalid/stale: ${runtime.authenticatedAccount.invalidMessages}/${runtime.authenticatedAccount.staleDetections}`,
              `REST fallback: ${runtime.restFallback.state} | used ${runtime.restFallback.fallbacks} times`,
            ]
          : []),
        `Time: ${new Date().toISOString()}`,
      ].join("\n"),
    );
  }

  private async markets(chatId: string, asset: string): Promise<void> {
    const contracts = (await this.exchange.getContracts()).filter(
      (contract) => contract.baseAsset === asset || contract.symbol === asset,
    );
    if (contracts.length === 0) {
      await this.sendText(chatId, `No perpetual markets found for ${asset}.`);
      return;
    }
    await this.sendText(
      chatId,
      [
        `${asset} perpetual markets:`,
        ...contracts.map(
          (contract) =>
            `${contract.symbol} | quote ${contract.quoteAsset} | margin ${contract.marginAssetsSupported.join("/")} | max ${contract.maxLeverage}x`,
        ),
      ].join("\n"),
    );
  }

  private async position(
    chatId: string,
    input: string,
    defaultMarket: Currency,
  ): Promise<void> {
    const positions = await this.enrichPositions(
      await this.exchange.getPositions("OPEN"),
    );
    const exact = positions.filter((position) => position.symbol === input);
    const resolved = positions.filter(
      (position) => position.symbol === `${input}${defaultMarket}`,
    );
    const base = positions.filter((position) => position.baseAsset === input);
    const candidates = exact.length ? exact : resolved.length ? resolved : base;
    if (candidates.length > 1) {
      await this.sendText(
        chatId,
        "Multiple positions match; specify the full contract symbol.",
      );
      return;
    }
    await this.sendText(chatId, formatPositions(candidates as Position[]));
  }

  private async pnlCommand(
    chatId: string,
    command: Extract<ParsedCommand, { kind: "PNL" }>,
  ): Promise<void> {
    if (command.range === "OPEN") {
      const open = await this.pnl.open();
      await this.sendText(
        chatId,
        `${formatPositions(await this.enrichPositions(open.positions))}\n\nAggregate unrealised: ${open.totals.INR} INR | ${open.totals.USDT} USDT`,
      );
      return;
    }
    if (command.range === "ALL") {
      await this.sendText(chatId, formatPnl(await this.pnl.summary(null)));
      return;
    }
    if (command.range === "TODAY") {
      const range = istToday();
      await this.sendText(
        chatId,
        formatPnl(await this.pnl.summary(range.start, range.end)),
      );
      return;
    }
    const startRange = istDayRange(command.start as string);
    const endRange = istDayRange(command.end as string);
    await this.sendText(
      chatId,
      formatPnl(await this.pnl.summary(startRange.start, endRange.end)),
    );
  }

  private async enrichPositions(positions: Position[]): Promise<Position[]> {
    if (!this.unrealisedPnl || positions.length === 0) return positions;
    try {
      return await this.unrealisedPnl.enrich(positions);
    } catch (error) {
      this.logger.warn(
        { error: redact(error) },
        "Unrealised P&L estimation failed; showing exchange values only",
      );
      return positions;
    }
  }

  private async sendText(
    chatId: string,
    text: string,
    replyMarkup?: Parameters<TelegramApi["sendMessage"]>[2],
  ): Promise<void> {
    const chunks = chunkMessage(text, 4000);
    for (const [index, chunk] of chunks.entries()) {
      await this.telegram.sendMessage(
        chatId,
        chunk,
        index === chunks.length - 1 ? replyMarkup : undefined,
      );
    }
  }
}

function formatStreamHealth(label: string, health: StreamHealth): string {
  const activity = health.lastValidEventAt ?? health.lastHeartbeatAt;
  return `${label}: ${health.state} | connected ${health.connected ? "yes" : "no"} | last activity ${activity?.toISOString() ?? "never"} | reconnects ${health.reconnects}`;
}

function identityFromUpdate(update: TelegramUpdate) {
  const message = update.message ?? update.callback_query?.message;
  const from = update.message?.from ?? update.callback_query?.from;
  return {
    ...(from ? { userId: String(from.id) } : {}),
    ...(message
      ? { chatId: String(message.chat.id), chatType: message.chat.type }
      : {}),
    isForwarded: Boolean(
      update.message?.forward_date || update.message?.forward_origin,
    ),
  };
}

function commandName(text: string | undefined): string {
  return text?.trim().split(/\s+/)[0]?.slice(0, 64) || "NON_TEXT_MESSAGE";
}

function appErrorCode(error: unknown): string {
  if (
    error instanceof CommandParseError ||
    error instanceof PreviewError ||
    error instanceof DraftError ||
    error instanceof ExecutionError ||
    error instanceof ConfirmationRejectedError ||
    error instanceof SharkApiError
  ) {
    return error.code;
  }
  return "UNEXPECTED_ERROR";
}

function safeMessage(error: unknown): string {
  if (error instanceof SharkApiError)
    return `Shark request failed (${error.code}).`;
  if (error instanceof Error) return String(redact(error.message));
  return "The operation could not be completed.";
}

function chunkMessage(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    const split = remaining.lastIndexOf("\n", size);
    const index = split > 0 ? split : size;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

const HELP_TEXT = helpText();
