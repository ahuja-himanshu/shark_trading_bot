/**
 * Single source of truth for the bot's command surface.
 *
 * The catalog feeds both the Telegram command menu (setMyCommands) and the
 * /help text, so the two never drift apart. Field constraints mirror the
 * Telegram Bot API: `command` must be 1-32 chars of lowercase a-z, 0-9 and
 * underscores; `description` must be 1-256 chars.
 */
export interface BotCommandEntry {
  /** Command name without the leading slash, e.g. "wallet". */
  readonly command: string;
  /** Short description shown in the Telegram command menu. */
  readonly description: string;
  /** Full usage line shown in /help, e.g. "/wallet [INR|USDT|all]". */
  readonly usage: string;
  /** Help grouping: read-only commands vs confirmed (mutating) actions. */
  readonly section: "read" | "action";
}

export const BOT_COMMANDS: readonly BotCommandEntry[] = [
  {
    command: "help",
    description: "Show all commands and usage",
    usage: "/help",
    section: "read",
  },
  {
    command: "health",
    description: "Service, stream, and reconciliation status",
    usage: "/health",
    section: "read",
  },
  {
    command: "wallet",
    description: "Wallet balance: /wallet [INR|all]",
    usage: "/wallet [INR|all]",
    section: "read",
  },
  {
    command: "markets",
    description: "Perpetual markets for an asset: /markets ASSET",
    usage: "/markets <ASSET>",
    section: "read",
  },
  {
    command: "default_market",
    description: "Set default market: /default_market INR|USDT",
    usage: "/default_market <INR|USDT>",
    section: "read",
  },
  {
    command: "open_positions",
    description: "List open positions",
    usage: "/open_positions",
    section: "read",
  },
  {
    command: "position",
    description: "Show one position: /position SYMBOL",
    usage: "/position <SYMBOL>",
    section: "read",
  },
  {
    command: "open_orders",
    description: "List open orders: /open_orders [SYMBOL]",
    usage: "/open_orders [SYMBOL]",
    section: "read",
  },
  {
    command: "pnl",
    description: "PnL: /pnl open|today|all or /pnl YYYY-MM-DD YYYY-MM-DD",
    usage: "/pnl open|today|all\n/pnl YYYY-MM-DD YYYY-MM-DD",
    section: "read",
  },
  {
    command: "audit",
    description: "Audit trail: /audit DRAFT_OR_EXECUTION_ID",
    usage: "/audit <DRAFT_OR_EXECUTION_ID>",
    section: "read",
  },
  {
    command: "trade",
    description:
      "New trade draft: /trade SYMBOL long|short market|limit PRICE margin AMOUNT INR|USDT leverage N [isolated|cross]",
    usage:
      "/trade <SYMBOL> <long|short> <market|limit PRICE> margin <AMOUNT> <INR|USDT> leverage <N> [isolated|cross]",
    section: "action",
  },
  {
    command: "close",
    description: "Close: /close SYMBOL market|limit PRICE or /close all",
    usage: "/close <SYMBOL> market\n/close <SYMBOL> limit <PRICE>\n/close all",
    section: "action",
  },
  {
    command: "cancel_orders",
    description: "Cancel open orders: /cancel_orders [SYMBOL]",
    usage: "/cancel_orders [SYMBOL]",
    section: "action",
  },
  {
    command: "sl",
    description: "Set stop-loss: /sl SYMBOL PRICE",
    usage: "/sl <SYMBOL> <PRICE>",
    section: "action",
  },
  {
    command: "tp",
    description: "Set take-profit: /tp SYMBOL PRICE",
    usage: "/tp <SYMBOL> <PRICE>",
    section: "action",
  },
  {
    command: "edit",
    description: "Edit a draft: /edit DRAFT_ID FIELD VALUE",
    usage: "/edit <DRAFT_ID> <margin|leverage|market|order|price|mode> <VALUE>",
    section: "action",
  },
  {
    command: "cancel",
    description: "Cancel a draft or order: /cancel ID",
    usage: "/cancel <DRAFT_OR_ORDER_ID>",
    section: "action",
  },
];

/** Commands registered with Telegram's command menu. */
export const TELEGRAM_COMMAND_MENU: ReadonlyArray<{
  command: string;
  description: string;
}> = BOT_COMMANDS.map(({ command, description }) => ({ command, description }));

/** /help text built from the same catalog as the command menu. */
export function helpText(): string {
  const sectionLines = (section: BotCommandEntry["section"]): string[] =>
    BOT_COMMANDS.filter((entry) => entry.section === section).map(
      (entry) => entry.usage,
    );
  return [
    "Shark Telegram Trading Manager",
    "",
    "Read-only:",
    ...sectionLines("read"),
    "",
    "Confirmed actions:",
    ...sectionLines("action"),
  ].join("\n");
}
