import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { redact } from "./security/redaction.js";
import { loadRuntimeEnvironment } from "./secrets.js";

async function main(): Promise<void> {
  const environment = await loadRuntimeEnvironment();
  const config = loadConfig(environment);
  const logger = createLogger(config);
  const app = await createApp(config, logger);
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Shutdown requested");
    await app.stop();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  await app.run();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", message: "Startup failed", error: redact(error instanceof Error ? error.message : error) })}\n`,
  );
  process.exitCode = 1;
});
