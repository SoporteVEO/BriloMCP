import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, SERVER_NAME } from "./mcpServer.js";

const AUTH_HEADER_PREFIX = "Bearer ";

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export function getAuthToken(): string {
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  if (!token) {
    throw new AuthConfigError(
      "MCP_AUTH_TOKEN is not set. Refusing to start the HTTP MCP endpoint without authentication. " +
        "Set MCP_AUTH_TOKEN in your Vercel project environment (and in your local .env for `npm run dev:http`).",
    );
  }
  if (token.length < 16) {
    throw new AuthConfigError(
      "MCP_AUTH_TOKEN is too short. Use at least 16 random characters (e.g. `openssl rand -hex 32`).",
    );
  }
  return token;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString());
  res.end(payload);
}

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  if (!header.startsWith(AUTH_HEADER_PREFIX)) return null;
  const token = header.slice(AUTH_HEADER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function authenticate(req: IncomingMessage): {
  ok: boolean;
  status?: number;
  error?: string;
} {
  let expected: string;
  try {
    expected = getAuthToken();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }

  const provided = extractBearerToken(req);
  if (!provided) {
    return {
      ok: false,
      status: 401,
      error:
        "Missing bearer token. Send `Authorization: Bearer <MCP_AUTH_TOKEN>` on every MCP request.",
    };
  }

  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, error: "Invalid bearer token." };
  }

  return { ok: true };
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;

  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Request body is not valid JSON: ${message}`);
  }
}

export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    sendJson(res, 200, {
      ok: true,
      name: SERVER_NAME,
      transport: "streamable-http",
      authentication: "bearer",
    });
    return;
  }

  const auth = authenticate(req);
  if (!auth.ok) {
    if (auth.status === 401) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="brilo-mcp"');
    }
    sendJson(res, auth.status ?? 500, {
      error: auth.error ?? "Unauthorized",
    });
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = await readRequestBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVER_NAME}] HTTP handler error:`, message);
    if (!res.headersSent) {
      sendJson(res, 500, { error: `Internal MCP server error: ${message}` });
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  }
}
