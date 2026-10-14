import type { IncomingMessage, ServerResponse } from "node:http";
import "../src/loadEnv.js";
import { handleMcpHttpRequest } from "../src/httpHandler.js";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await handleMcpHttpRequest(req, res);
}
