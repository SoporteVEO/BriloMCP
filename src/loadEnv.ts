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

let loadedFrom: string | null = null;
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    const result = dotenv.config({ path: candidate, override: false });
    if (!result.error) {
      loadedFrom = candidate;
      break;
    }
  }
}

if (loadedFrom) {
  console.error(`[brilo-sqlserver-mcp] Loaded .env from ${loadedFrom}`);
} else {
  console.error(
    `[brilo-sqlserver-mcp] WARNING: no .env file found. Tried: ${candidates.join(
      ", ",
    )}. Falling back to process.env / MCP env block.`,
  );
}

export const envLoadedFrom = loadedFrom;
export const envCandidatesTried = candidates;
