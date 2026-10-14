import { z } from "zod";
import { runQuery } from "../db.js";
import { validateQueryWithFix } from "../utils/sqlSafety.js";
import { errorResponse, type ToolTextResponse } from "./toolResponse.js";

const DEFAULT_MAX_ROWS = 100;
const HARD_MAX_ROWS = 1000;

export const runQueryInputShape = {
  sql: z
    .string()
    .min(1, "sql must not be empty")
    .describe(
      "Read-only SQL Server query to execute against the Brilo ERP database. Must start with SELECT / WITH / DECLARE and follow Brilo ERP rules (fully qualified names, WITH (NOLOCK), no destructive keywords). Use validate_query or generate_query first if unsure.",
    ),
  maxRows: z
    .number()
    .int("maxRows must be an integer")
    .min(1, "maxRows must be >= 1")
    .max(HARD_MAX_ROWS, `maxRows must be <= ${HARD_MAX_ROWS}`)
    .optional()
    .describe(
      `Maximum rows to return from the result set (default ${DEFAULT_MAX_ROWS}, hard cap ${HARD_MAX_ROWS}). The query is still executed as written — this only trims the response payload.`,
    ),
  autoFixNoLock: z
    .boolean()
    .optional()
    .describe(
      "If true (default), auto-apply the WITH (NOLOCK) fix suggested by validate_query before running. Set to false to execute the SQL exactly as provided.",
    ),
};

export const runQueryInputSchema = z.object(runQueryInputShape);
export type RunQueryInput = z.infer<typeof runQueryInputSchema>;

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  return value;
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value);
  }
  return out;
}

function formatRowsAsTable(rows: Record<string, unknown>[], limit: number): string {
  if (rows.length === 0) return "(no rows)";
  const columns = Object.keys(rows[0]);
  const shown = rows.slice(0, limit);
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = shown
    .map(
      (row) =>
        `| ${columns
          .map((c) => {
            const v = row[c];
            if (v === null || v === undefined) return "";
            const s = String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
            return s.length > 80 ? `${s.slice(0, 80)}...` : s;
          })
          .join(" | ")} |`,
    )
    .join("\n");
  return [header, sep, body].join("\n");
}

export async function runQueryHandler(
  input: RunQueryInput,
): Promise<ToolTextResponse> {
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
  const autoFixNoLock = input.autoFixNoLock ?? true;

  const validation = validateQueryWithFix(input.sql);

  if (!validation.isValid) {
    return errorResponse(
      "run_query refused to execute: SQL failed safety validation.",
      {
        isValid: false,
        errors: validation.errors,
        warnings: validation.warnings,
        suggestions: validation.suggestions,
        fixedSqlDraft: validation.fixedSqlDraft ?? null,
      },
    );
  }

  const sqlToRun =
    autoFixNoLock && validation.fixedSqlDraft
      ? validation.fixedSqlDraft
      : input.sql;

  const autoFixApplied = sqlToRun !== input.sql;

  const startedAt = Date.now();
  let rawRows: Record<string, unknown>[] = [];
  try {
    rawRows = await runQuery<Record<string, unknown>>(sqlToRun);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(`SQL Server execution failed: ${message}`, {
      sql: sqlToRun,
      autoFixApplied,
      validation,
    });
  }
  const durationMs = Date.now() - startedAt;

  const rows = rawRows.slice(0, maxRows).map(serializeRow);
  const truncated = rawRows.length > maxRows;

  const lines: string[] = [];
  lines.push(
    `Executed query against Brilo (${rawRows.length} row${rawRows.length === 1 ? "" : "s"} returned, ${durationMs} ms).`,
  );
  if (truncated) {
    lines.push(
      `Response truncated to the first ${maxRows} rows. Re-run with a larger maxRows or add a tighter WHERE / TOP clause to see more.`,
    );
  }
  if (autoFixApplied) {
    lines.push(
      "Auto-added WITH (NOLOCK) to one or more ERP table references before executing.",
    );
  }
  if (validation.warnings.length > 0) {
    lines.push("");
    lines.push("Validator warnings:");
    for (const w of validation.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  lines.push("SQL executed:");
  lines.push("```sql");
  lines.push(sqlToRun);
  lines.push("```");
  lines.push("");
  lines.push("Results:");
  lines.push(formatRowsAsTable(rows, maxRows));

  return {
    text: lines.join("\n").trim(),
    data: {
      rowCount: rawRows.length,
      returnedRowCount: rows.length,
      truncated,
      durationMs,
      autoFixApplied,
      sqlExecuted: sqlToRun,
      validation: {
        isValid: validation.isValid,
        warnings: validation.warnings,
        suggestions: validation.suggestions,
      },
      rows,
    },
  };
}

export function runQueryErrorWrap(err: unknown): ToolTextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(`run_query failed: ${message}`);
}
