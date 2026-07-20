import type { SharkExchangePort } from "../exchange/port.js";
import type { Position } from "../domain/types.js";
import { SharkApiError } from "../exchange/shark-client.js";
import type { Store } from "../repositories/store.js";
import { readAllTradeHistory, readAllTransactionHistory } from "./history.js";

export class ReconciliationService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(
    private readonly store: Store,
    private readonly exchange: SharkExchangePort,
    private readonly intervalSeconds: number,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly onPositions?: (
      positions: Position[],
    ) => void | Promise<void>,
  ) {}

  public start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.intervalSeconds * 1000,
    );
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const end = this.now();
    try {
      const cursor = await this.store.getReconciliationCursor("ACCOUNT_LEDGER");
      const start = cursor ? new Date(cursor.getTime() - 60_000) : undefined;
      const [fills, transactions, positions, orders] = await Promise.all([
        readAllTradeHistory(this.exchange, start, end),
        readAllTransactionHistory(this.exchange, start, end),
        this.exchange.getPositions("OPEN"),
        this.exchange.getOpenOrders(),
      ]);
      await this.store.saveFills(fills);
      await this.store.saveTransactions(transactions);
      await this.store.savePositionSnapshots(positions, end);
      await this.store.saveOrders(orders);
      await this.onPositions?.(positions);
      await this.store.markReconciliation("ACCOUNT_LEDGER", end, true);
      await this.store.appendAudit({
        action: "RECONCILIATION_COMPLETED",
        entityType: "RECONCILIATION",
        entityId: "ACCOUNT_LEDGER",
        outcome: "SUCCESS",
        metadata: {
          fills: fills.length,
          transactions: transactions.length,
          positions: positions.length,
          orders: orders.length,
        },
      });
    } catch (error) {
      const code =
        error instanceof SharkApiError ? error.code : "RECONCILIATION_FAILED";
      await this.store
        .markReconciliation("ACCOUNT_LEDGER", null, false, code)
        .catch(() => undefined);
      await this.store
        .appendAudit({
          action: "RECONCILIATION_FAILED",
          entityType: "RECONCILIATION",
          entityId: "ACCOUNT_LEDGER",
          outcome: "FAILED",
          metadata: { errorCode: code },
        })
        .catch(() => undefined);
      this.onError(error);
    } finally {
      this.running = false;
    }
  }
}
