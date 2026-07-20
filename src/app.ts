import type { Logger } from "pino";
import { TELEGRAM_COMMAND_MENU } from "./commands/catalog.js";
import type { AppConfig } from "./config.js";
import { redact } from "./security/redaction.js";
import { SharkApiError, SharkClient } from "./exchange/shark-client.js";
import { PostgresStore } from "./repositories/postgres-store.js";
import { DraftService } from "./services/drafts.js";
import { ExecutionService } from "./services/execution.js";
import { PnlService } from "./services/pnl.js";
import { HybridMarketData } from "./services/market-data.js";
import { PreviewService } from "./services/preview.js";
import { ReconciliationService } from "./services/reconciliation.js";
import { UnrealisedPnlEstimator } from "./services/unrealised-pnl.js";
import { AuthenticatedAccountStream } from "./streams/authenticated-account-stream.js";
import { PublicMarketStream } from "./streams/public-market-stream.js";
import { TelegramApi } from "./telegram/api.js";
import { TelegramController } from "./telegram/controller.js";
import { TelegramPoller } from "./telegram/poller.js";

export interface RunningApp {
  run(): Promise<void>;
  stop(): Promise<void>;
}

export async function createApp(
  config: AppConfig,
  logger: Logger,
): Promise<RunningApp> {
  const store = new PostgresStore(config.databaseUrl);
  await store.migrate();
  const exchange = new SharkClient({
    baseUrl: config.sharkApiBaseUrl,
    apiKey: config.sharkApiKey,
    apiSecret: config.sharkApiSecret,
  });
  const publicMarket = new PublicMarketStream(
    {
      url: config.sharkPublicStreamUrl,
      maxQuoteAgeMs: config.marketQuoteMaxAgeMs,
      staleAfterMs: config.websocketStaleAfterSeconds * 1_000,
      subscriptionLeaseMs: config.marketSubscriptionLeaseSeconds * 1_000,
      maxMessageBytes: config.websocketMaxMessageBytes,
    },
    logger,
  );
  const marketData = new HybridMarketData(publicMarket, exchange);
  const preview = new PreviewService(exchange, undefined, marketData);
  const authoritativePreview = new PreviewService(exchange);
  const drafts = new DraftService(store, preview, config.draftTtlSeconds);
  const execution = new ExecutionService(
    store,
    exchange,
    config.tradingEnabled,
    {
      authoritativePreview,
      draftService: drafts,
      materialChangeBps: config.confirmationMaterialChangeBps,
    },
  );
  const pnl = new PnlService(exchange, logger);
  const telegram = new TelegramApi(config.telegramBotToken);
  let depthGroupings = new Map<string, string>();
  let depthGroupingsLoadedAt = 0;
  const reconciliation = new ReconciliationService(
    store,
    exchange,
    config.reconciliationIntervalSeconds,
    (error) =>
      logger.error(
        {
          errorCode:
            error instanceof SharkApiError
              ? error.code
              : "RECONCILIATION_FAILED",
          error: redact(error instanceof Error ? error.message : String(error)),
        },
        "Account reconciliation failed",
      ),
    undefined,
    async (positions) => {
      if (Date.now() - depthGroupingsLoadedAt > 60 * 60 * 1_000) {
        try {
          const contracts = await exchange.getContracts();
          const refreshed = new Map<string, string>();
          for (const contract of contracts) {
            const grouping = contract.depthGroupings?.[0];
            if (grouping) refreshed.set(contract.symbol, grouping);
          }
          depthGroupings = refreshed;
          depthGroupingsLoadedAt = Date.now();
        } catch {
          logger.warn(
            { errorCode: "DEPTH_GROUPING_REFRESH_FAILED" },
            "Using cached/default market depth grouping",
          );
        }
      }
      publicMarket.setHeldSymbols(
        positions.map((position) => {
          const depthGrouping = depthGroupings.get(position.symbol);
          return depthGrouping
            ? { symbol: position.symbol, depthGrouping }
            : { symbol: position.symbol };
        }),
      );
    },
  );
  const accountStream = new AuthenticatedAccountStream(
    {
      url: config.sharkAccountStreamUrl,
      renewalMs: config.sharkListenKeyRenewalSeconds * 1_000,
      staleAfterMs: config.websocketStaleAfterSeconds * 1_000,
      maxMessageBytes: config.websocketMaxMessageBytes,
    },
    exchange,
    store,
    () => reconciliation.runOnce(),
    logger,
  );
  const runtimeHealth = {
    getHealth: () => ({
      publicMarket: publicMarket.getHealth(),
      authenticatedAccount: accountStream.getHealth(),
      restFallback: marketData.getHealth(),
    }),
  };
  const controller = new TelegramController(
    telegram,
    exchange,
    store,
    drafts,
    execution,
    pnl,
    logger,
    {
      allowedUserId: config.telegramAllowedUserId,
      allowedChatId: config.telegramAllowedChatId,
      tradingEnabled: config.tradingEnabled,
    },
    runtimeHealth,
    new UnrealisedPnlEstimator(exchange, marketData),
  );
  const poller = new TelegramPoller(telegram, controller, logger);

  return {
    async run() {
      publicMarket.start();
      reconciliation.start();
      accountStream.start();
      try {
        await telegram.setMyCommands(TELEGRAM_COMMAND_MENU);
      } catch {
        logger.warn(
          { errorCode: "COMMAND_MENU_REGISTRATION_FAILED" },
          "Telegram command menu was not updated",
        );
      }
      logger.info(
        { tradingEnabled: config.tradingEnabled },
        "Shark Telegram Trading Manager started",
      );
      await poller.run();
    },
    async stop() {
      poller.stop();
      publicMarket.stop();
      await accountStream.stop();
      reconciliation.stop();
      await store.close();
      logger.info("Shark Telegram Trading Manager stopped");
    },
  };
}
