import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  resolve(here, "..", ".env"),
  resolve(here, "..", "..", ".env"),
  resolve(process.cwd(), ".env"),
];

const REQUIRED_VARS = [
  "SQLSERVER_HOST",
  "SQLSERVER_USERNAME",
  "SQLSERVER_PASSWORD",
];

function isServerless(): boolean {
  return (
    process.env.VERCEL === "1" ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
    process.env.LAMBDA_TASK_ROOT !== undefined
  );
}

function hasRequiredEnvVars(): boolean {
  return REQUIRED_VARS.every(
    (name) => (process.env[name] ?? "").trim().length > 0,
  );
}

let loadedFrom: string | null = null;

if (!isServerless()) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const result = dotenv.config({ path: candidate, override: false });
      if (!result.error) {
        loadedFrom = candidate;
        break;
      }
    }
  }
}

if (loadedFrom) {
  console.error(`[brilo-sqlserver-mcp] Loaded .env from ${loadedFrom}`);
} else if (isServerless() || hasRequiredEnvVars()) {
  // Vercel / Lambda inject env vars directly into process.env — no .env file
  // is expected, and emitting a WARNING here just makes production logs noisy.
  console.error(
    "[brilo-sqlserver-mcp] Using environment variables from process.env (no .env file loaded).",
  );
} else {
  console.error(
    `[brilo-sqlserver-mcp] WARNING: no .env file found and required variables are not set in process.env. ` +
      `Tried: ${candidates.join(", ")}. ` +
      `Set credentials in .env, the MCP "env" block, or your hosting provider.`,
  );
}

export const envLoadedFrom = loadedFrom;
export const envCandidatesTried = candidates;
