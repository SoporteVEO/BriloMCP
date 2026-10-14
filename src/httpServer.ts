import "./loadEnv.js";
import { createServer } from "node:http";
import { AuthConfigError, getAuthToken, handleMcpHttpRequest } from "./httpHandler.js";
import { SERVER_NAME } from "./mcpServer.js";
import { closePool } from "./db.js";

const DEFAULT_PORT = 3333;

async function main(): Promise<void> {
  try {
    getAuthToken();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      console.error(`[${SERVER_NAME}] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const port = Number.parseInt(process.env.PORT ?? "", 10) || DEFAULT_PORT;
  const server = createServer((req, res) => {
    void handleMcpHttpRequest(req, res);
  });

  server.listen(port, () => {
    console.error(
      `[${SERVER_NAME}] HTTP MCP endpoint listening on http://127.0.0.1:${port}/mcp`,
    );
    console.error(
      `[${SERVER_NAME}] Health check: GET http://127.0.0.1:${port}/health`,
    );
  });

  const shutdown = async (code: number) => {
    server.close();
    try {
      await closePool();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (err) => {
    console.error(`[${SERVER_NAME}] uncaughtException:`, err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[${SERVER_NAME}] unhandledRejection:`, reason);
  });
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] Fatal error during startup:`, err);
  process.exit(1);
});
