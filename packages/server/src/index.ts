import { createApp } from "./app";
import { loadConfig } from "./config";
import { getLogger } from "./logger";

const config = loadConfig();
const { app } = createApp(config);
const logger = getLogger();

logger.info("server starting", {
  port: config.port,
  dbPath: config.dbPath,
  publicDir: config.publicDir,
  publicDashboard: config.publicDashboard,
  logFile: config.logFile,
  apiKeyConfigured: config.apiKey !== "dev-key-change-me",
});

const server = Bun.serve({
  fetch: app.fetch,
  port: config.port,
});
server.ref();

logger.info("server listening", { url: server.url.toString() });
console.log(`Runmark listening on ${server.url}`);
