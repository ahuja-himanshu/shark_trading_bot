import type { Logger } from "pino";
import { TelegramApiError, type TelegramApi } from "./api.js";
import type { TelegramController } from "./controller.js";

export class TelegramPoller {
  private offset: number | undefined;
  private stopped = false;
  private controller = new AbortController();

  public constructor(
    private readonly telegram: TelegramApi,
    private readonly handler: TelegramController,
    private readonly logger: Logger,
  ) {}

  public async run(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        const updates = await this.telegram.getUpdates(
          this.offset,
          this.controller.signal,
        );
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handler.handle(update);
        }
      } catch (error) {
        if (this.stopped) return;
        this.logger.error(
          {
            code:
              error instanceof TelegramApiError ? error.code : "POLLING_FAILED",
          },
          "Telegram polling failed",
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  public stop(): void {
    this.stopped = true;
    this.controller.abort();
  }
}
