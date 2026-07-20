import { Decimal } from "decimal.js";
import type { Logger } from "pino";
import type { Currency, PnlSummary, Position } from "../domain/types.js";
import type { SharkExchangePort } from "../exchange/port.js";
import { readAllTransactionHistory } from "./history.js";

const CURRENCIES: Currency[] = ["INR", "USDT"];

/** Transaction-history posting types that make up trading fees. */
const FEE_TYPES = new Set([
  "COMMISSION",
  "GST_ON_COMMISSION",
  "CLEARANCE_FEE",
  "GST_ON_CLEARANCE_FEE",
  "FEE_DISCOUNT",
]);

/**
 * Explicit lower bound for "all history" reads. Shark futures launched in
 * 2024, so no account activity predates this; an explicit start is required
 * because history endpoints only return their default recent window when it
 * is omitted.
 */
const HISTORY_FLOOR = new Date("2024-01-01T00:00:00Z");

export class PnlService {
  public constructor(
    private readonly exchange: SharkExchangePort,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async open(): Promise<{
    positions: Position[];
    totals: Record<Currency, string>;
  }> {
    const positions = await this.exchange.getPositions("OPEN");
    const totals = decimals();
    const marginAssets = [
      ...new Set(positions.map((position) => position.marginAsset)),
    ];
    const wallets = await Promise.all(
      marginAssets.map((marginAsset) => this.exchange.getWallet(marginAsset)),
    );
    for (const wallet of wallets) {
      totals[wallet.marginAsset] = new Decimal(wallet.unrealisedPnlCross).plus(
        wallet.unrealisedPnlIsolated,
      );
    }
    return { positions, totals: strings(totals) };
  }

  public async summary(
    start: Date | null,
    end = this.now(),
  ): Promise<PnlSummary> {
    // Read through to Shark for the requested range: the local ledger only
    // covers history reconciled since this bot first ran, so it cannot
    // answer arbitrary historical ranges correctly. Realised P&L, fees, and
    // funding are computed from Shark's transaction-history account postings
    // (the same source as the exchange UI's P&L report); the per-fill
    // realizedProfit/fee fields in trade-history are incomplete.
    const historyStart = start ?? HISTORY_FLOOR;
    const [transactions, open] = await Promise.all([
      readAllTransactionHistory(this.exchange, historyStart, end),
      this.open(),
    ]);
    this.logger?.info(
      {
        rangeStart: historyStart.toISOString(),
        rangeEnd: end.toISOString(),
        transactions: transactions.length,
        firstTransactionAt: transactions[0]?.occurredAt.toISOString() ?? null,
        lastTransactionAt:
          transactions.at(-1)?.occurredAt.toISOString() ?? null,
        transactionTypes: countTransactionTypes(transactions),
      },
      "P&L history source",
    );
    const realised = decimals();
    const fees = decimals();
    const funding = decimals();
    for (const event of transactions) {
      if (event.type === "REALIZED_PNL") {
        realised[event.asset] = realised[event.asset].plus(event.amount);
      } else if (FEE_TYPES.has(event.type)) {
        // Ledger amounts are signed wallet movements (charges negative,
        // rebates positive); fees are reported as a positive magnitude.
        fees[event.asset] = fees[event.asset].minus(event.amount);
      } else if (event.type.includes("FUNDING")) {
        funding[event.asset] = funding[event.asset].plus(event.amount);
      }
    }
    const net = decimals();
    for (const currency of CURRENCIES) {
      net[currency] = realised[currency]
        .minus(fees[currency])
        .plus(funding[currency]);
    }
    return {
      start,
      end,
      realisedProfit: strings(realised),
      fees: strings(fees),
      funding: strings(funding),
      netRealised: strings(net),
      unrealised: open.totals,
    };
  }
}

export function istDayRange(dateText: string): { start: Date; end: Date } {
  const start = new Date(`${dateText}T00:00:00+05:30`);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid IST date");
  return { start, end: new Date(start.getTime() + 86_400_000 - 1) };
}

export function istToday(now = new Date()): {
  dateText: string;
  start: Date;
  end: Date;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const dateText = `${value("year")}-${value("month")}-${value("day")}`;
  const range = istDayRange(dateText);
  return { dateText, ...range, end: now };
}

function countTransactionTypes(
  transactions: Array<{ type: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const transaction of transactions) {
    counts[transaction.type] = (counts[transaction.type] ?? 0) + 1;
  }
  return counts;
}

function decimals(): Record<Currency, Decimal> {
  return { INR: new Decimal(0), USDT: new Decimal(0) };
}

function strings(values: Record<Currency, Decimal>): Record<Currency, string> {
  return { INR: values.INR.toString(), USDT: values.USDT.toString() };
}
