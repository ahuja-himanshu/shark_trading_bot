import { Decimal } from "decimal.js";
import type {
  CancelOrdersIntent,
  CloseAllIntent,
  CloseIntent,
  Currency,
  MarginMode,
  MutatingIntent,
  ProtectionIntent,
  TradeIntent,
} from "../domain/types.js";

export type ReadCommand =
  | { kind: "HELP" }
  | { kind: "HEALTH" }
  | { kind: "WALLET"; asset?: Currency | "ALL" }
  | { kind: "MARKETS"; asset: string }
  | { kind: "DEFAULT_MARKET"; market: Currency }
  | { kind: "OPEN_POSITIONS" }
  | { kind: "POSITION"; symbol: string }
  | { kind: "OPEN_ORDERS"; symbol?: string }
  | {
      kind: "PNL";
      range: "OPEN" | "TODAY" | "ALL" | "CUSTOM";
      start?: string;
      end?: string;
    }
  | { kind: "AUDIT"; entityId: string };

export interface EditCommand {
  kind: "EDIT";
  draftId: string;
  field: "margin" | "leverage" | "market" | "order" | "price" | "mode";
  values: string[];
}

export interface CancelCommand {
  kind: "CANCEL";
  targetId: string;
}

export type ParsedCommand =
  | ReadCommand
  | MutatingIntent
  | EditCommand
  | CancelCommand;

export class CommandParseError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandParseError";
  }
}

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    throw syntax("Commands must start with /");
  }
  const tokens = trimmed.split(/\s+/);
  const command = tokens.shift()?.split("@")[0]?.toLowerCase();
  const args = tokens;

  switch (command) {
    case "/help":
      exactArgs(args, 0);
      return { kind: "HELP" };
    case "/health":
      exactArgs(args, 0);
      return { kind: "HEALTH" };
    case "/wallet":
      return parseWallet(args);
    case "/markets":
      exactArgs(args, 1);
      return { kind: "MARKETS", asset: symbol(args[0]) };
    case "/default_market":
      exactArgs(args, 1);
      return { kind: "DEFAULT_MARKET", market: currency(args[0]) };
    case "/open_positions":
      exactArgs(args, 0);
      return { kind: "OPEN_POSITIONS" };
    case "/position":
      exactArgs(args, 1);
      return { kind: "POSITION", symbol: symbol(args[0]) };
    case "/open_orders":
      if (args.length > 1) throw syntax("Usage: /open_orders [SYMBOL]");
      return args[0]
        ? { kind: "OPEN_ORDERS", symbol: symbol(args[0]) }
        : { kind: "OPEN_ORDERS" };
    case "/pnl":
      return parsePnl(args);
    case "/audit":
      exactArgs(args, 1);
      return { kind: "AUDIT", entityId: required(args[0], "entity ID") };
    case "/trade":
      return parseTrade(args);
    case "/close":
      return parseClose(args);
    case "/cancel_orders":
      return parseCancelOrders(args);
    case "/sl":
      return parseProtection("STOP_LOSS", args);
    case "/tp":
      return parseProtection("TAKE_PROFIT", args);
    case "/edit":
      return parseEdit(args);
    case "/cancel":
      exactArgs(args, 1);
      return { kind: "CANCEL", targetId: required(args[0], "target ID") };
    default:
      throw new CommandParseError(
        "UNKNOWN_COMMAND",
        "Unknown command. Use /help.",
      );
  }
}

function parseWallet(args: string[]): ReadCommand {
  if (args.length > 1) throw syntax("Usage: /wallet [INR|USDT|all]");
  if (!args[0]) return { kind: "WALLET", asset: "ALL" };
  if (args[0].toLowerCase() === "all") return { kind: "WALLET", asset: "ALL" };
  return { kind: "WALLET", asset: currency(args[0]) };
}

function parsePnl(args: string[]): ReadCommand {
  if (args.length === 1) {
    const range = args[0]?.toUpperCase();
    if (range === "OPEN" || range === "TODAY" || range === "ALL") {
      return { kind: "PNL", range };
    }
  }
  if (args.length === 2 && isIsoDate(args[0]) && isIsoDate(args[1])) {
    if (required(args[0], "start date") > required(args[1], "end date")) {
      throw new CommandParseError(
        "INVALID_DATE_RANGE",
        "Start date must not be after end date.",
      );
    }
    return {
      kind: "PNL",
      range: "CUSTOM",
      start: required(args[0], "start date"),
      end: required(args[1], "end date"),
    };
  }
  throw syntax("Usage: /pnl open|today|all or /pnl YYYY-MM-DD YYYY-MM-DD");
}

function parseTrade(args: string[]): TradeIntent {
  if (args.length < 7) {
    throw syntax(
      "Usage: /trade <SYMBOL> <long|short> <market|limit PRICE> margin <AMOUNT> <INR|USDT> leverage <N> [isolated|cross]",
    );
  }
  let index = 0;
  const symbolInput = symbol(args[index++]);
  const directionValue = required(args[index++], "direction").toUpperCase();
  if (directionValue !== "LONG" && directionValue !== "SHORT") {
    throw new CommandParseError(
      "INVALID_DIRECTION",
      "Direction must be long or short.",
    );
  }
  const orderToken = required(args[index++], "order type").toUpperCase();
  if (orderToken !== "MARKET" && orderToken !== "LIMIT") {
    throw new CommandParseError(
      "INVALID_ORDER_TYPE",
      "Order type must be market or limit.",
    );
  }
  let limitPrice: string | undefined;
  if (orderToken === "LIMIT")
    limitPrice = positiveDecimal(args[index++], "limit price");
  keyword(args[index++], "margin");
  const marginAmount = positiveDecimal(args[index++], "margin amount");
  const requestedMarginAsset = currency(args[index++]);
  keyword(args[index++], "leverage");
  const leverage = positiveInteger(args[index++], "leverage");
  let marginMode: MarginMode = "ISOLATED";
  if (args[index]) {
    const mode = args[index]?.toUpperCase();
    if (mode !== "ISOLATED" && mode !== "CROSS") {
      throw new CommandParseError(
        "INVALID_MARGIN_MODE",
        "Margin mode must be isolated or cross.",
      );
    }
    marginMode = mode;
    index += 1;
  }
  if (index !== args.length) throw syntax("Unexpected extra trade arguments.");
  const intent: TradeIntent = {
    kind: "TRADE",
    symbolInput,
    direction: directionValue,
    orderType: orderToken,
    marginAmount,
    requestedMarginAsset,
    leverage,
    marginMode,
  };
  if (limitPrice) intent.limitPrice = limitPrice;
  return intent;
}

function parseClose(args: string[]): CloseIntent | CloseAllIntent {
  if (args.length === 1 && args[0]?.toLowerCase() === "all")
    return { kind: "CLOSE_ALL" };
  if (args.length < 2 || args.length > 3) {
    throw syntax(
      "Usage: /close <SYMBOL> market or /close <SYMBOL> limit <PRICE> or /close all",
    );
  }
  const symbolInput = symbol(args[0]);
  const orderType = required(args[1], "order type").toUpperCase();
  if (orderType === "MARKET" && args.length === 2) {
    return { kind: "CLOSE", symbolInput, orderType };
  }
  if (orderType === "LIMIT" && args.length === 3) {
    return {
      kind: "CLOSE",
      symbolInput,
      orderType,
      limitPrice: positiveDecimal(args[2], "limit price"),
    };
  }
  throw syntax("Market close takes no price; limit close requires one price.");
}

function parseCancelOrders(args: string[]): CancelOrdersIntent {
  if (args.length > 1) throw syntax("Usage: /cancel_orders [SYMBOL]");
  return args[0]
    ? { kind: "CANCEL_ORDERS", symbolInput: symbol(args[0]) }
    : { kind: "CANCEL_ORDERS" };
}

function parseProtection(
  protectionType: ProtectionIntent["protectionType"],
  args: string[],
): ProtectionIntent {
  exactArgs(args, 2);
  return {
    kind: "PROTECTION",
    protectionType,
    symbolInput: symbol(args[0]),
    price: positiveDecimal(args[1], "protection price"),
  };
}

function parseEdit(args: string[]): EditCommand {
  if (args.length < 3) {
    throw syntax(
      "Usage: /edit <DRAFT_ID> <margin|leverage|market|order|price|mode> <VALUE>",
    );
  }
  const draftId = required(args.shift(), "draft ID").toUpperCase();
  const field = required(args.shift(), "edit field").toLowerCase();
  if (
    !["margin", "leverage", "market", "order", "price", "mode"].includes(field)
  ) {
    throw new CommandParseError(
      "INVALID_EDIT_FIELD",
      `Unsupported edit field: ${field}`,
    );
  }
  return {
    kind: "EDIT",
    draftId,
    field: field as EditCommand["field"],
    values: args,
  };
}

function currency(value: string | undefined): Currency {
  const parsed = required(value, "currency").toUpperCase();
  if (parsed !== "INR" && parsed !== "USDT") {
    throw new CommandParseError(
      "INVALID_CURRENCY",
      "Currency must be INR or USDT.",
    );
  }
  return parsed;
}

function symbol(value: string | undefined): string {
  const parsed = required(value, "symbol").toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(parsed)) {
    throw new CommandParseError(
      "INVALID_SYMBOL",
      "Symbol contains invalid characters.",
    );
  }
  return parsed;
}

function positiveDecimal(value: string | undefined, field: string): string {
  const raw = required(value, field);
  let parsed: Decimal;
  try {
    parsed = new Decimal(raw);
  } catch {
    throw new CommandParseError(
      "INVALID_NUMBER",
      `${field} must be a valid number.`,
    );
  }
  if (!parsed.isFinite() || !parsed.isPositive()) {
    throw new CommandParseError(
      "INVALID_NUMBER",
      `${field} must be greater than zero.`,
    );
  }
  return parsed.toString();
}

function positiveInteger(value: string | undefined, field: string): number {
  const raw = required(value, field);
  if (!/^\d+$/.test(raw)) {
    throw new CommandParseError(
      "INVALID_INTEGER",
      `${field} must be a positive whole number.`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandParseError(
      "INVALID_INTEGER",
      `${field} must be a positive whole number.`,
    );
  }
  return parsed;
}

function keyword(actual: string | undefined, expected: string): void {
  if (actual?.toLowerCase() !== expected)
    throw syntax(`Expected '${expected}'.`);
}

function required(value: string | undefined, field: string): string {
  if (!value) throw syntax(`Missing ${field}.`);
  return value;
}

function exactArgs(args: string[], count: number): void {
  if (args.length !== count)
    throw syntax("Unexpected or missing command arguments.");
}

function isIsoDate(value: string | undefined): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function syntax(message: string): CommandParseError {
  return new CommandParseError("INVALID_COMMAND_SYNTAX", message);
}
