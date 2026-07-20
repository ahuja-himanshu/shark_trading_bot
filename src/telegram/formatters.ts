import type {
  AuditEvent,
  DraftPreview,
  ExchangeOrder,
  FuturesWallet,
  PnlSummary,
  Position,
  TradeDraft,
} from "../domain/types.js";

export function formatDraft(draft: TradeDraft): string {
  const preview = draft.preview;
  const lines = [
    `DRAFT ${draft.id} v${draft.version} — NOT EXECUTED`,
    "",
    preview.title,
    preview.summary,
    ...preview.lines.map((line) => `${line.label}: ${line.value}`),
  ];
  if (preview.warnings.length > 0) {
    lines.push("", ...preview.warnings.map((warning) => `WARNING: ${warning}`));
  }
  lines.push("", `Expires: ${formatIst(draft.expiresAt)}`);
  return lines.join("\n");
}

export function formatPreviewHelp(draftId: string): string {
  return [
    `Edit ${draftId}:`,
    `/edit ${draftId} margin <AMOUNT> <INR|USDT>`,
    `/edit ${draftId} leverage <N>`,
    `/edit ${draftId} market <SYMBOL>`,
    `/edit ${draftId} order <market|limit> [PRICE]`,
    `/edit ${draftId} price <PRICE>`,
    `/edit ${draftId} mode <isolated|cross>`,
  ].join("\n");
}

export function formatPositions(positions: Position[]): string {
  if (positions.length === 0) return "No open positions.";
  return [
    `Open positions: ${positions.length}`,
    ...positions.flatMap((position) => [
      "",
      `${position.symbol} ${position.direction} | ${position.marginMode} ${position.leverage}x`,
      `Quantity: ${position.quantity} ${position.baseAsset}`,
      `Entry: ${position.entryPrice} ${position.quoteAsset}`,
      `Liquidation: ${position.liquidationPrice} ${position.quoteAsset}`,
      `Margin: ${position.marginInMarginAsset} ${position.marginAsset}`,
      `${position.unrealisedProfitEstimated ? "Unrealised P&L (est.)" : "Unrealised P&L"}: ${position.unrealisedProfit ?? "not supplied"} ${position.marginAsset}`,
      `Position ID: ${position.positionId}`,
    ]),
  ].join("\n");
}

export function formatOrders(orders: ExchangeOrder[]): string {
  if (orders.length === 0) return "No open orders.";
  return [
    `Open orders: ${orders.length}`,
    ...orders.flatMap((order) => [
      "",
      `${order.symbol} ${order.side} ${order.type}`,
      `Quantity: ${order.orderAmount} | Filled: ${order.filledAmount}`,
      `Price: ${order.price}`,
      `Order ID: ${order.clientOrderId}`,
    ]),
  ].join("\n");
}

export function formatWallet(wallet: FuturesWallet): string {
  return [
    `${wallet.marginAsset} Futures wallet`,
    `Wallet balance: ${wallet.walletBalance}`,
    `Free/withdrawable: ${wallet.withdrawableBalance}`,
    `Locked: ${wallet.lockedBalance}`,
    `Maintenance margin: ${wallet.maintenanceMargin}`,
    `Unrealised isolated: ${wallet.unrealisedPnlIsolated}`,
    `Unrealised cross: ${wallet.unrealisedPnlCross}`,
  ].join("\n");
}

export function formatPnl(summary: PnlSummary): string {
  const period = summary.start
    ? `${formatIst(summary.start)} to ${formatIst(summary.end)}`
    : `All reconciled history to ${formatIst(summary.end)}`;
  return [
    `P&L — ${period}`,
    "",
    ...(["INR", "USDT"] as const).flatMap((asset) => [
      `${asset}:`,
      `  Realised: ${summary.realisedProfit[asset]}`,
      `  Fees: -${summary.fees[asset]}`,
      `  Funding: ${summary.funding[asset]}`,
      `  Net realised: ${summary.netRealised[asset]}`,
      `  Current unrealised: ${summary.unrealised[asset]}`,
    ]),
    "",
    "Deposits, withdrawals, and transfers are excluded from trading P&L.",
  ].join("\n");
}

export function formatAudit(events: AuditEvent[]): string {
  if (events.length === 0) return "No audit events found for that ID.";
  return events
    .map(
      (event) =>
        `${formatIst(event.createdAt)} | ${event.action} | ${event.outcome} | hash ${event.eventHash.slice(0, 12)}`,
    )
    .join("\n");
}

export function editPrompt(draftId: string, field: string): string {
  const examples: Record<string, string> = {
    margin: "Reply with: <AMOUNT> <INR|USDT>",
    leverage: "Reply with: <WHOLE_NUMBER>",
    market: "Reply with: <ASSET_OR_FULL_SYMBOL>",
    order: "Reply with: market OR limit <PRICE>",
    price: "Reply with: <LIMIT_PRICE>",
    mode: "Reply with: isolated OR cross",
  };
  return `EDIT ${draftId} ${field}\n${examples[field] ?? "Reply with the new value."}`;
}

export function parseEditReply(reply: {
  text?: string;
  reply_to_message?: { text?: string };
}): string | null {
  const marker = reply.reply_to_message?.text?.split("\n")[0];
  const match = marker?.match(
    /^EDIT (T-[A-F0-9]{12}) (margin|leverage|market|order|price|mode)$/,
  );
  if (!match || !reply.text?.trim()) return null;
  return `/edit ${match[1]} ${match[2]} ${reply.text.trim()}`;
}

export function draftKeyboard(draftId: string, token: string) {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: `c:${token}` },
        { text: "Cancel", callback_data: `x:${draftId}` },
      ],
      [
        { text: "Change margin", callback_data: `e:${draftId}:margin` },
        { text: "Change leverage", callback_data: `e:${draftId}:leverage` },
      ],
      [
        { text: "Change market", callback_data: `e:${draftId}:market` },
        { text: "Change order", callback_data: `e:${draftId}:order` },
      ],
      [
        { text: "Change price", callback_data: `e:${draftId}:price` },
        { text: "Change mode", callback_data: `e:${draftId}:mode` },
      ],
    ],
  };
}

export function formatIst(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

export function previewLine(
  preview: DraftPreview,
  label: string,
): string | undefined {
  return preview.lines.find((line) => line.label === label)?.value;
}
