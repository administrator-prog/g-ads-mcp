import { loadConfig } from "./config.js";
import { errorFields, logger, setLogLevel } from "./logger.js";
import { SERVER_NAME, SERVER_VERSION } from "./mcp.js";
import { createApp } from "./server.js";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Fail fast and loudly: a misconfigured deploy should not serve traffic.
    logger.error("Startup failed", errorFields(error));
    process.exit(1);
    return;
  }

  setLogLevel(config.logLevel);

  if (!config.google.developerToken || !config.google.refreshToken) {
    logger.warn(
      "Google Ads credentials incomplete — MCP tools will return a configuration error until they are set.",
      {
        developerToken: Boolean(config.google.developerToken),
        refreshToken: Boolean(config.google.refreshToken),
        next: "Visit /auth?token=<MCP_AUTH_TOKEN> to complete OAuth consent.",
      },
    );
  }

  // Railway assigns the port; bind 0.0.0.0 so the container is reachable.
  const server = createApp(config).listen(config.port, "0.0.0.0", () => {
    logger.info("Server listening", {
      service: SERVER_NAME,
      version: SERVER_VERSION,
      port: config.port,
      nodeEnv: config.nodeEnv,
    });
  });

  const shutdown = (signal: string) => {
    logger.info("Shutting down", { signal });
    server.close(() => process.exit(0));
    // Railway sends SIGTERM and waits before SIGKILL; do not hang on it.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", errorFields(reason));
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", errorFields(error));
    process.exit(1);
  });
}

main();
