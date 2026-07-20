import { Decimal } from "decimal.js";
import type { ExchangeOrder, Position, TradeDraft } from "../domain/types.js";
import { SharkApiError } from "../exchange/shark-client.js";
import type { PlaceOrderRequest, SharkExchangePort } from "../exchange/port.js";
import type { Store } from "../repositories/store.js";
import { sha256 } from "../security/crypto.js";
import type { CalculatedDraft, DraftEnvelope, DraftService } from "./drafts.js";
import {
  type PreviewService,
  PreviewError,
  validateOrderPrice,
  validateOrderQuantity,
} from "./preview.js";

export interface ExecutionResult {
  draftId: string;
  state: "SUBMITTED" | "RECONCILED" | "FAILED" | "UNKNOWN";
  message: string;
  order?: ExchangeOrder;
  refreshedDraft?: DraftEnvelope;
}

export interface ExecutionServiceOptions {
  now?: () => Date;
  authoritativePreview?: PreviewService;
  draftService?: DraftService;
  materialChangeBps?: number;
}

export class ExecutionService {
  public constructor(
    private readonly store: Store,
    private readonly exchange: SharkExchangePort,
    private readonly tradingEnabled: boolean,
    private readonly options: ExecutionServiceOptions = {},
  ) {}

  public async confirm(
    rawToken: string,
    userId: string,
    chatId: string,
  ): Promise<ExecutionResult> {
    if (!this.tradingEnabled) {
      throw new ExecutionError(
        "TRADING_DISABLED",
        "Trading is disabled. Set TRADING_ENABLED=true only after read-only validation.",
      );
    }
    const claim = await this.store.consumeConfirmationAndClaim(
      sha256(rawToken),
      userId,
      chatId,
      this.now(),
    );
    const { draft, execution } = claim;
    await this.store.appendAudit({
      actorUserId: userId,
      actorChatId: chatId,
      action: "DRAFT_CONFIRMED",
      entityType: "TRADE_DRAFT",
      entityId: draft.id,
      outcome: "SUCCESS",
      metadata: { version: draft.version, executionId: execution.id },
    });

    try {
      const result = await this.executeDraft(draft);
      const state = result.state;
      await this.store.updateExecution(execution.id, {
        state,
        ...(result.order ? { clientOrderId: result.order.clientOrderId } : {}),
        result: result.result,
      });
      await this.store.updateDraftStatus(draft.id, state);
      if (result.order) await this.store.saveOrders([result.order]);
      await this.store.appendAudit({
        actorUserId: userId,
        actorChatId: chatId,
        action: "EXECUTION_COMPLETED",
        entityType: "EXECUTION",
        entityId: execution.id,
        outcome: state,
        metadata: {
          draftId: draft.id,
          ...(result.order
            ? { clientOrderId: result.order.clientOrderId }
            : {}),
        },
      });
      return {
        draftId: draft.id,
        state,
        message: result.message,
        ...(result.order ? { order: result.order } : {}),
      };
    } catch (error) {
      const materialChange =
        error instanceof MaterialDraftChangeError ? error : null;
      const ambiguous =
        error instanceof SharkApiError && error.code === "AMBIGUOUS_MUTATION";
      const state = ambiguous ? "UNKNOWN" : "FAILED";
      const errorCode = errorCodeOf(error);
      let refreshedDraft: DraftEnvelope | undefined;
      if (materialChange && this.options.draftService) {
        refreshedDraft = await this.options.draftService
          .create(draft.intent, userId, chatId, defaultMarketFor(draft))
          .catch(() => undefined);
      }
      await this.store.updateExecution(execution.id, { state, errorCode });
      await this.store.updateDraftStatus(draft.id, state);
      await this.store.appendAudit({
        actorUserId: userId,
        actorChatId: chatId,
        action: "EXECUTION_FAILED",
        entityType: "EXECUTION",
        entityId: execution.id,
        outcome: state,
        metadata: {
          draftId: draft.id,
          errorCode,
          ...(refreshedDraft
            ? { refreshedDraftId: refreshedDraft.draft.id }
            : {}),
        },
      });
      return {
        draftId: draft.id,
        state,
        message: refreshedDraft
          ? `The confirmed preview changed materially (${materialChange?.fields.join(", ")}). Nothing was executed. Review and confirm the refreshed draft.`
          : materialChange
            ? "The confirmed preview changed materially. Nothing was executed; create the command again for a fresh preview."
            : ambiguous
              ? "Exchange outcome is unknown after a network interruption. Do not repeat the command; verify open orders/positions."
              : error instanceof SharkApiError
                ? `Shark rejected the request (${error.code}). Nothing was automatically retried.`
                : error instanceof Error
                  ? error.message
                  : "Execution failed.",
        ...(refreshedDraft ? { refreshedDraft } : {}),
      };
    }
  }

  private async executeDraft(draft: TradeDraft): Promise<{
    state: "SUBMITTED" | "RECONCILED";
    order?: ExchangeOrder;
    result: unknown;
    message: string;
  }> {
    await this.assertPreviewStable(draft);
    switch (draft.intent.kind) {
      case "TRADE": {
        const intent = draft.intent;
        const contract = draft.preview.contract;
        const quantity = draft.preview.estimatedQuantity;
        if (!intent.symbol || !contract || !quantity) throw invalidDraft();
        await this.revalidateTrade(draft);
        await this.exchange.updatePreference(
          intent.symbol,
          intent.leverage,
          intent.marginMode,
        );
        const request: PlaceOrderRequest = {
          placeType: "ORDER_FORM",
          quantity,
          side: intent.direction === "LONG" ? "BUY" : "SELL",
          symbol: intent.symbol,
          reduceOnly: false,
          marginAsset: intent.requestedMarginAsset,
          type: intent.orderType,
        };
        if (intent.limitPrice) request.price = intent.limitPrice;
        const order = await this.exchange.placeOrder(request);
        return {
          state: "SUBMITTED",
          order,
          result: order.raw ?? order,
          message: `Order submitted: ${order.clientOrderId}`,
        };
      }
      case "CLOSE": {
        const position = await this.requiredCurrentPosition(draft);
        await this.revalidatePositionPrice(
          position,
          draft.intent.orderType === "LIMIT"
            ? draft.intent.limitPrice
            : undefined,
        );
        const request: PlaceOrderRequest = {
          placeType: "POSITION",
          positionId: position.positionId,
          quantity: position.quantity,
          side: position.direction === "LONG" ? "SELL" : "BUY",
          symbol: position.symbol,
          reduceOnly: true,
          marginAsset: position.marginAsset,
          type: draft.intent.orderType,
        };
        if (draft.intent.limitPrice) request.price = draft.intent.limitPrice;
        const order = await this.exchange.placeOrder(request);
        if (order.reduceOnly === false) {
          throw new ExecutionError(
            "EXCHANGE_REDUCE_ONLY_MISMATCH",
            "Exchange response did not preserve reduce-only; verify the account immediately.",
          );
        }
        return {
          state: "SUBMITTED",
          order,
          result: order.raw ?? order,
          message: `Close order submitted: ${order.clientOrderId}`,
        };
      }
      case "CLOSE_ALL": {
        const positions = await this.exchange.getPositions("OPEN");
        if (positions.length === 0) {
          return {
            state: "RECONCILED",
            result: { positions: [] },
            message: "No open positions remained at confirmation time.",
          };
        }
        const result = await this.exchange.closeAllPositions();
        const remaining = await this.exchange
          .getPositions("OPEN")
          .catch(() => null);
        const reconciled = remaining?.length === 0;
        return {
          state: reconciled ? "RECONCILED" : "SUBMITTED",
          result,
          message: reconciled
            ? `Close-all verified for ${positions.length} positions.`
            : `Close-all submitted for ${positions.length} positions; verification is pending.`,
        };
      }
      case "CANCEL_ORDERS": {
        if (!draft.intent.symbol) {
          const result = await this.exchange.cancelAllOrders();
          const remaining = await this.exchange
            .getOpenOrders()
            .catch(() => null);
          const reconciled = remaining?.length === 0;
          return {
            state: reconciled ? "RECONCILED" : "SUBMITTED",
            result,
            message: reconciled
              ? "Cancel-all-orders verified."
              : "Cancel-all-orders submitted; verification is pending.",
          };
        }
        const orders = await this.exchange.getOpenOrders(draft.intent.symbol);
        const results: unknown[] = [];
        for (const order of orders)
          results.push(await this.exchange.cancelOrder(order.clientOrderId));
        const remaining = await this.exchange
          .getOpenOrders(draft.intent.symbol)
          .catch(() => null);
        const reconciled = remaining?.length === 0;
        return {
          state: reconciled ? "RECONCILED" : "SUBMITTED",
          result: results,
          message: reconciled
            ? `Verified cancellation of ${orders.length} ${draft.intent.symbol} orders.`
            : `Submitted cancellation of ${orders.length} ${draft.intent.symbol} orders; verification is pending.`,
        };
      }
      case "CANCEL_ORDER": {
        const clientOrderId = draft.intent.clientOrderId;
        const existing = await this.exchange.getOrder(clientOrderId);
        if (!existing)
          return {
            state: "RECONCILED",
            result: null,
            message: "Order was already absent.",
          };
        const result = await this.exchange.cancelOrder(clientOrderId);
        const stillOpen = await this.exchange
          .getOpenOrders(existing.symbol)
          .then((orders) =>
            orders.some((order) => order.clientOrderId === clientOrderId),
          )
          .catch(() => null);
        return {
          state: stillOpen === false ? "RECONCILED" : "SUBMITTED",
          result,
          message:
            stillOpen === false
              ? `Verified cancellation of ${clientOrderId}.`
              : `Cancellation submitted for ${clientOrderId}; verification is pending.`,
        };
      }
      case "PROTECTION": {
        const position = await this.requiredCurrentPosition(draft);
        await this.revalidatePositionPrice(position, draft.intent.price);
        const leg = [
          { quantity: position.quantity, price: draft.intent.price },
        ];
        const result = await this.exchange.setProtection({
          positionId: position.positionId,
          ...(draft.intent.protectionType === "TAKE_PROFIT"
            ? { takeProfits: leg }
            : { stopLosses: leg }),
        });
        return {
          state: "SUBMITTED",
          result,
          message: `${draft.intent.protectionType === "TAKE_PROFIT" ? "Take-profit" : "Stop-loss"} submitted for ${position.symbol}.`,
        };
      }
    }
  }

  private async assertPreviewStable(draft: TradeDraft): Promise<void> {
    if (
      !this.options.authoritativePreview ||
      (draft.intent.kind !== "TRADE" && draft.intent.kind !== "CLOSE")
    ) {
      return;
    }
    const calculated = await this.options.authoritativePreview.calculate(
      draft.intent,
      defaultMarketFor(draft),
    );
    const fields = materialChanges(
      draft.preview,
      calculated.preview,
      this.options.materialChangeBps ?? 25,
    );
    if (fields.length > 0) {
      throw new MaterialDraftChangeError(fields, calculated);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async revalidateTrade(draft: TradeDraft): Promise<void> {
    if (
      draft.intent.kind !== "TRADE" ||
      !draft.intent.symbol ||
      !draft.preview.contract
    )
      throw invalidDraft();
    const intent = draft.intent;
    const symbol = intent.symbol;
    if (!symbol) throw invalidDraft();
    const [contracts, wallet] = await Promise.all([
      this.exchange.getContracts(),
      this.exchange.getWallet(intent.requestedMarginAsset),
    ]);
    const contract = contracts.find((item) => item.symbol === symbol);
    if (!contract?.tradeable)
      throw new ExecutionError(
        "CONTRACT_NOT_TRADEABLE",
        "Contract is no longer tradeable.",
      );
    if (intent.leverage > contract.maxLeverage) {
      throw new ExecutionError(
        "LEVERAGE_NOT_SUPPORTED",
        "Leverage is no longer supported.",
      );
    }
    if (!contract.orderTypes.includes(intent.orderType)) {
      throw new ExecutionError(
        "ORDER_TYPE_NOT_SUPPORTED",
        "Order type is no longer supported.",
      );
    }
    if (!contract.marginAssetsSupported.includes(intent.requestedMarginAsset)) {
      throw new ExecutionError(
        "MARGIN_ASSET_NOT_SUPPORTED",
        "Margin asset is no longer supported.",
      );
    }
    if (new Decimal(wallet.withdrawableBalance).lt(intent.marginAmount)) {
      throw new ExecutionError(
        "INSUFFICIENT_MARGIN",
        "Free collateral changed; create a fresh preview.",
      );
    }
    const entryPrice =
      intent.orderType === "MARKET"
        ? await this.exchange
            .getBestBidAsk(symbol)
            .then((book) =>
              intent.direction === "LONG" ? book.bestAsk : book.bestBid,
            )
        : intent.limitPrice;
    if (!entryPrice || !draft.preview.estimatedQuantity) throw invalidDraft();
    if (intent.orderType === "LIMIT") {
      this.translatePreviewError(() =>
        validateOrderPrice(new Decimal(entryPrice), contract),
      );
    }
    const quantity = new Decimal(draft.preview.estimatedQuantity);
    this.translatePreviewError(() =>
      validateOrderQuantity(
        quantity,
        quantity.mul(entryPrice),
        contract,
        intent.orderType,
      ),
    );
  }

  private async revalidatePositionPrice(
    position: Position,
    price: string | undefined,
  ): Promise<void> {
    if (!price) return;
    const contracts = await this.exchange.getContracts();
    const contract = contracts.find((item) => item.symbol === position.symbol);
    if (!contract) {
      throw new ExecutionError(
        "CONTRACT_NOT_FOUND",
        "Contract metadata is no longer available.",
      );
    }
    this.translatePreviewError(() =>
      validateOrderPrice(new Decimal(price), contract),
    );
  }

  private translatePreviewError(operation: () => void): void {
    try {
      operation();
    } catch (error) {
      if (error instanceof PreviewError) {
        throw new ExecutionError(error.code, error.message);
      }
      throw error;
    }
  }

  private async requiredCurrentPosition(draft: TradeDraft): Promise<Position> {
    const expectedId = draft.preview.positionIds?.[0];
    if (!expectedId) throw invalidDraft();
    const position = await this.exchange.getPosition(expectedId);
    if (!position || position.status !== "OPEN") {
      throw new ExecutionError(
        "POSITION_NOT_OPEN",
        "Position is no longer open.",
      );
    }
    if (
      "symbol" in draft.intent &&
      draft.intent.symbol &&
      position.symbol !== draft.intent.symbol
    ) {
      throw new ExecutionError(
        "POSITION_MISMATCH",
        "Live position does not match the confirmed draft.",
      );
    }
    return position;
  }
}

export class ExecutionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

function invalidDraft(): ExecutionError {
  return new ExecutionError(
    "INVALID_DRAFT",
    "Draft lacks required execution data.",
  );
}

function errorCodeOf(error: unknown): string {
  if (error instanceof MaterialDraftChangeError) return error.code;
  if (error instanceof SharkApiError || error instanceof ExecutionError)
    return error.code;
  return "UNEXPECTED_EXECUTION_ERROR";
}

class MaterialDraftChangeError extends Error {
  public readonly code = "MATERIAL_PREVIEW_CHANGE";

  public constructor(
    public readonly fields: string[],
    public readonly calculated: CalculatedDraft,
  ) {
    super("The confirmed preview changed materially.");
    this.name = "MaterialDraftChangeError";
  }
}

function defaultMarketFor(draft: TradeDraft): "INR" | "USDT" {
  if (draft.intent.kind === "TRADE") return draft.intent.requestedMarginAsset;
  const symbol = "symbol" in draft.intent ? draft.intent.symbol : undefined;
  return symbol?.endsWith("INR") ? "INR" : "USDT";
}

function materialChanges(
  previous: TradeDraft["preview"],
  current: TradeDraft["preview"],
  toleranceBps: number,
): string[] {
  const changed: string[] = [];
  if (
    JSON.stringify(previous.positionIds ?? []) !==
    JSON.stringify(current.positionIds ?? [])
  )
    changed.push("position");
  for (const [label, left, right] of [
    ["entry price", previous.estimatedEntryPrice, current.estimatedEntryPrice],
    ["quantity", previous.estimatedQuantity, current.estimatedQuantity],
    ["notional", previous.estimatedNotional, current.estimatedNotional],
    [
      "liquidation estimate",
      previous.estimatedLiquidationPrice,
      current.estimatedLiquidationPrice,
    ],
    [
      "free collateral",
      previous.freeCollateralAfter,
      current.freeCollateralAfter,
    ],
  ] as const) {
    if (materialNumericChange(left, right, toleranceBps)) changed.push(label);
  }
  return changed;
}

function materialNumericChange(
  left: string | undefined,
  right: string | undefined,
  toleranceBps: number,
): boolean {
  if (left === undefined || right === undefined) return left !== right;
  const previous = new Decimal(left);
  const current = new Decimal(right);
  if (previous.eq(current)) return false;
  const denominator = Decimal.max(
    previous.abs(),
    current.abs(),
    "0.000000000001",
  );
  return previous
    .minus(current)
    .abs()
    .div(denominator)
    .mul(10_000)
    .gt(toleranceBps);
}
