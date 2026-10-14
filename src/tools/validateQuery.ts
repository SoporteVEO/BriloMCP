import { z } from "zod";
import { validateQueryWithFix } from "../utils/sqlSafety.js";
import { type ToolTextResponse } from "./toolResponse.js";

export const validateQueryInputShape = {
  sql: z
    .string()
    .min(1, "sql must not be empty")
    .describe(
      "The SQL Server query to validate. Must be a read-only SELECT/WITH/DECLARE query.",
    ),
};

export const validateQueryInputSchema = z.object(validateQueryInputShape);

export type ValidateQueryInput = z.infer<typeof validateQueryInputSchema>;

export async function validateQueryHandler(
  input: ValidateQueryInput,
): Promise<ToolTextResponse> {
  const result = validateQueryWithFix(input.sql);

  const lines: string[] = [];
  lines.push(`isValid: ${result.isValid}`);
  lines.push("");

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const err of result.errors) lines.push(`- ${err}`);
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warn of result.warnings) lines.push(`- ${warn}`);
    lines.push("");
  }

  if (result.suggestions.length > 0) {
    lines.push("Suggestions:");
    for (const s of result.suggestions) lines.push(`- ${s}`);
    lines.push("");
  }

  if (result.fixedSqlDraft) {
    lines.push("Suggested fix (auto-added WITH (NOLOCK) where missing):");
    lines.push("```sql");
    lines.push(result.fixedSqlDraft);
    lines.push("```");
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    lines.push("No issues detected. Query passes Brilo ERP read-only rules.");
  }

  return {
    text: lines.join("\n").trim(),
    data: {
      isValid: result.isValid,
      errors: result.errors,
      warnings: result.warnings,
      suggestions: result.suggestions,
      fixedSqlDraft: result.fixedSqlDraft ?? null,
    },
  };
}
