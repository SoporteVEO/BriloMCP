import "./loadEnv.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, SERVER_NAME } from "./mcpServer.js";
import { closePool } from "./db.js";

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  process.on("SIGINT", () => {
    void shutdown(server, 0);
  });
  process.on("SIGTERM", () => {
    void shutdown(server, 0);
  });

  process.on("uncaughtException", (err) => {
    console.error(`[${SERVER_NAME}] uncaughtException:`, err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[${SERVER_NAME}] unhandledRejection:`, reason);
  });

  await server.connect(transport);
  console.error(`[${SERVER_NAME}] Server listening on stdio.`);
}

async function shutdown(server: McpServer, code: number): Promise<void> {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  try {
    await closePool();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] Fatal error during startup:`, err);
  process.exit(1);
});
