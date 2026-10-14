import { z } from "zod";
import {
  DOCUMENTATION_TABLES,
  KNOWN_RELATIONSHIPS,
} from "../utils/knownSchema.js";
import { searchColumnsByName, type MetaColumn } from "../utils/metadata.js";
import { searchDocumentationTable } from "../utils/documentationSearch.js";
import { errorResponse, type ToolTextResponse } from "./toolResponse.js";

export const getColumnMeaningInputShape = {
  column: z
    .string()
    .min(1, "column must not be empty")
    .describe(
      "Column name. Supports fully qualified (db.schema.table.col), table.col, partial, or short name.",
    ),
};

export const getColumnMeaningInputSchema = z.object(getColumnMeaningInputShape);
export type GetColumnMeaningInput = z.infer<typeof getColumnMeaningInputSchema>;

type ConfidenceLevel = "high" | "medium" | "low";

type Possibility = {
  fullyQualifiedColumn: string;
  database: string;
  schema: string;
  table: string;
  column: string;
  dataType: string;
  isNullable: boolean;
  maxLength: number | null;
  documentation: Record<string, unknown>[];
  inferredRelatedTable: string | null;
  knownRelationships: typeof KNOWN_RELATIONSHIPS;
  savedQueryExamples: Record<string, unknown>[];
  confidence: ConfidenceLevel;
  reasoning: string[];
};

function parseColumnInput(input: string): {
  database?: string;
  schema?: string;
  table?: string;
  column: string;
} {
  const parts = input
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(".")
    .map((p) => p.trim().replace(/^\[|\]$/g, ""));

  if (parts.length === 4) {
    return {
      database: parts[0],
      schema: parts[1],
      table: parts[2],
      column: parts[3],
    };
  }
  if (parts.length === 3) {
    return { schema: parts[0], table: parts[1], column: parts[2] };
  }
  if (parts.length === 2) {
    return { table: parts[0], column: parts[1] };
  }
  return { column: parts[0] };
}

function inferRelatedTableFromColumnName(column: string): string | null {
  const map: Record<string, string> = {
    cliid: "olComun.dbo.Clientes",
    cliidinvoiceto: "olComun.dbo.Clientes",
    proid: "olComun.dbo.Productos",
    mfaid: "olVentas.dbo.maeFacturas",
    tactecoid: "olComun.dbo.TiposActividadesEconomicas",
    dccid: "olVentas.dbo.AbonosCXC",
  };
  const key = column.toLowerCase();
  if (map[key]) return map[key];
  return null;
}

function findKnownRelationshipsForColumn(
  fullyQualifiedColumn: string,
  shortColumn: string,
): typeof KNOWN_RELATIONSHIPS {
  const fq = fullyQualifiedColumn.toLowerCase();
  const sc = shortColumn.toLowerCase();
  return KNOWN_RELATIONSHIPS.filter(
    (r) =>
      r.from.toLowerCase() === fq ||
      r.to.toLowerCase() === fq ||
      r.from.toLowerCase().endsWith(`.${sc}`) ||
      r.to.toLowerCase().endsWith(`.${sc}`),
  );
}

function calcConfidence(possibility: {
  documentation: Record<string, unknown>[];
  inferredRelatedTable: string | null;
  knownRelationships: typeof KNOWN_RELATIONSHIPS;
  exactColumnInputProvided: boolean;
}): { confidence: ConfidenceLevel; reasoning: string[] } {
  const reasoning: string[] = [];
  let score = 0;

  if (possibility.exactColumnInputProvided) {
    score += 1;
    reasoning.push("User provided fully qualified column.");
  }
  if (possibility.documentation.length > 0) {
    score += 2;
    reasoning.push("Has documentation in olAdmin.dbo.CamposTablas.");
  }
  if (possibility.knownRelationships.length > 0) {
    score += 2;
    reasoning.push("Appears in curated KNOWN_RELATIONSHIPS.");
  }
  if (possibility.inferredRelatedTable) {
    score += 1;
    reasoning.push(`Name pattern suggests link to ${possibility.inferredRelatedTable}.`);
  }

  let confidence: ConfidenceLevel = "low";
  if (score >= 4) confidence = "high";
  else if (score >= 2) confidence = "medium";
  return { confidence, reasoning };
}

export async function getColumnMeaningHandler(
  input: GetColumnMeaningInput,
): Promise<ToolTextResponse> {
  const parsed = parseColumnInput(input.column);
  const exactColumnInputProvided = Boolean(
    parsed.database && parsed.schema && parsed.table,
  );

  let candidates: MetaColumn[] = [];
  try {
    candidates = await searchColumnsByName(parsed.column, undefined, 100);
  } catch (err) {
    return errorResponse(
      `Failed to read SQL Server metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed.table) {
    const tLower = parsed.table.toLowerCase();
    candidates = candidates.filter(
      (c) =>
        c.table.toLowerCase() === tLower ||
        c.table.toLowerCase().includes(tLower),
    );
  }
  if (parsed.schema) {
    const sLower = parsed.schema.toLowerCase();
    candidates = candidates.filter((c) => c.schema.toLowerCase() === sLower);
  }
  if (parsed.database) {
    const dLower = parsed.database.toLowerCase();
    candidates = candidates.filter((c) => c.database.toLowerCase() === dLower);
  }

  if (candidates.length === 0) {
    const docHits: Record<string, unknown>[] = [];
    try {
      const rows = await searchDocumentationTable({
        fullTableName: DOCUMENTATION_TABLES.columnNames,
        patterns: [parsed.column],
        topN: 10,
      });
      for (const r of rows) {
        delete r.__matchedColumn;
        docHits.push(r);
      }
    } catch {
      /* ignore */
    }

    const lines: string[] = [];
    lines.push(
      `No SQL Server columns matched "${input.column}" in the allowed databases.`,
    );
    if (docHits.length > 0) {
      lines.push("");
      lines.push("Documentation hints from olAdmin.dbo.CamposTablas:");
      for (const r of docHits.slice(0, 5)) {
        lines.push(`- ${shortPreview(r)}`);
      }
    }
    lines.push("");
    lines.push(`Suggestion: search_schema("${parsed.column}") to discover related context.`);

    return {
      text: lines.join("\n"),
      data: {
        input: input.column,
        candidates: [],
        documentationHits: docHits,
      },
    };
  }

  const topCandidates = candidates.slice(0, 12);
  const possibilities: Possibility[] = [];

  for (const cand of topCandidates) {
    const fullyQualifiedColumn = `${cand.database}.${cand.schema}.${cand.table}.${cand.column}`;

    let documentation: Record<string, unknown>[] = [];
    let savedQueryExamples: Record<string, unknown>[] = [];
    try {
      const docs = await searchDocumentationTable({
        fullTableName: DOCUMENTATION_TABLES.columnNames,
        patterns: [cand.column, cand.table],
        topN: 3,
      });
      for (const r of docs) {
        delete r.__matchedColumn;
        documentation.push(r);
      }
    } catch {
      /* ignore */
    }
    try {
      const sq = await searchDocumentationTable({
        fullTableName: DOCUMENTATION_TABLES.savedQueries,
        patterns: [cand.column],
        topN: 3,
      });
      for (const r of sq) {
        delete r.__matchedColumn;
        savedQueryExamples.push(r);
      }
    } catch {
      /* ignore */
    }

    const inferredRelatedTable = inferRelatedTableFromColumnName(cand.column);
    const knownRelationships = findKnownRelationshipsForColumn(
      fullyQualifiedColumn,
      cand.column,
    );

    const { confidence, reasoning } = calcConfidence({
      documentation,
      inferredRelatedTable,
      knownRelationships,
      exactColumnInputProvided,
    });

    possibilities.push({
      fullyQualifiedColumn,
      database: cand.database,
      schema: cand.schema,
      table: cand.table,
      column: cand.column,
      dataType: cand.dataType,
      isNullable: cand.isNullable,
      maxLength: cand.maxLength,
      documentation,
      inferredRelatedTable,
      knownRelationships,
      savedQueryExamples,
      confidence,
      reasoning,
    });
  }

  possibilities.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.confidence] - order[b.confidence];
  });

  const lines: string[] = [];
  lines.push(`Column "${input.column}" — found ${candidates.length} candidate(s).`);
  lines.push("");

  for (const p of possibilities.slice(0, 8)) {
    lines.push(`### ${p.fullyQualifiedColumn} (${p.dataType}${p.maxLength != null && p.maxLength >= 0 ? `(${p.maxLength})` : ""}, ${p.isNullable ? "NULL" : "NOT NULL"})`);
    lines.push(`Confidence: ${p.confidence}`);
    if (p.reasoning.length > 0) {
      lines.push(`Reasoning: ${p.reasoning.join("; ")}`);
    }
    if (p.inferredRelatedTable) {
      lines.push(`Likely related table: ${p.inferredRelatedTable}`);
    }
    if (p.knownRelationships.length > 0) {
      lines.push("Known relationships:");
      for (const r of p.knownRelationships) {
        lines.push(`- ${r.from} = ${r.to} (${r.description})`);
      }
    }
    if (p.documentation.length > 0) {
      lines.push("Documentation rows (olAdmin.dbo.CamposTablas):");
      for (const d of p.documentation.slice(0, 3)) {
        lines.push(`- ${shortPreview(d)}`);
      }
    }
    if (p.savedQueryExamples.length > 0) {
      lines.push("Saved ERP queries that mention this column:");
      for (const q of p.savedQueryExamples.slice(0, 2)) {
        lines.push(`- ${shortPreview(q)}`);
      }
    }
    lines.push("");
  }

  if (possibilities.length > 8) {
    lines.push(`(${possibilities.length - 8} additional candidate(s) returned in structured data.)`);
  }

  if (possibilities.length > 1 && possibilities[0].confidence !== "high") {
    lines.push("");
    lines.push(
      "Multiple candidates were found. Consider providing a fully qualified column name (database.schema.table.column) to disambiguate.",
    );
  }

  return {
    text: lines.join("\n").trim(),
    data: {
      input: input.column,
      totalCandidates: candidates.length,
      possibilities,
    },
  };
}

function shortPreview(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    let str = String(v).replace(/\s+/g, " ").trim();
    if (str.length > 120) str = `${str.slice(0, 120)}...`;
    parts.push(`${k}=${str}`);
    if (parts.length >= 4) break;
  }
  return parts.join(" | ");
}

export function getColumnMeaningErrorWrap(err: unknown): ToolTextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(`get_column_meaning failed: ${message}`);
}
