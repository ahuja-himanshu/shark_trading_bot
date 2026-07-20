import type { TradeFill, TransactionEvent } from "../domain/types.js";
import type { SharkExchangePort } from "../exchange/port.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/**
 * Reads every trade fill in [start, end] from Shark. History endpoints return
 * at most one page per request, so the reader walks forward from `start`
 * (when omitted, the exchange's default window applies) until a short page.
 */
export async function readAllTradeHistory(
  exchange: SharkExchangePort,
  start: Date | undefined,
  end: Date,
): Promise<TradeFill[]> {
  const all: TradeFill[] = [];
  let pageStart = start;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await exchange.getTradeHistory({
      ...(pageStart ? { start: pageStart } : {}),
      end,
      pageSize: PAGE_SIZE,
      sortOrder: "asc",
    });
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
    const last = batch.at(-1);
    if (!last) return all;
    pageStart = new Date(last.occurredAt.getTime() + 1);
  }
  throw new Error("Trade history pagination exceeded safety limit");
}

/** Transaction-history twin of readAllTradeHistory. */
export async function readAllTransactionHistory(
  exchange: SharkExchangePort,
  start: Date | undefined,
  end: Date,
): Promise<TransactionEvent[]> {
  const all: TransactionEvent[] = [];
  let pageStart = start;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await exchange.getTransactionHistory({
      ...(pageStart ? { start: pageStart } : {}),
      end,
      pageSize: PAGE_SIZE,
      sortOrder: "asc",
    });
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
    const last = batch.at(-1);
    if (!last) return all;
    pageStart = new Date(last.occurredAt.getTime() + 1);
  }
  throw new Error("Transaction history pagination exceeded safety limit");
}
