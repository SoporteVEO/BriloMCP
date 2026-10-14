import { z } from "zod";
import {
  DOCUMENTATION_TABLES,
  KNOWN_RELATIONSHIPS,
  KNOWN_TABLES,
  findKnownTablesByPartial,
} from "../utils/knownSchema.js";
import { expandSynonyms } from "../utils/normalize.js";
import { searchDocumentationTable } from "../utils/documentationSearch.js";
import {
  searchColumnsByName,
  searchTablesByName,
  type MetaColumn,
  type MetaTable,
} from "../utils/metadata.js";
import { errorResponse, type ToolTextResponse } from "./toolResponse.js";

export const searchSchemaInputShape = {
  query: z
    .string()
    .min(1, "query must not be empty")
    .describe(
      "Natural language phrase to search for, e.g. 'ventas este mes', 'clientes con pagos', 'productos sin stock'.",
    ),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of results to return per category."),
};

export const searchSchemaInputSchema = z.object(searchSchemaInputShape);
export type SearchSchemaInput = z.infer<typeof searchSchemaInputSchema>;

type DocSummaryRow = {
  source: string;
  matchedColumn: string | null;
  preview: string;
  data: Record<string, unknown>;
};

function summarizeRow(
  row: Record<string, unknown>,
  matchedColumn: string | null,
  source: string,
): DocSummaryRow {
  const previewParts: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (k === "__matchedColumn") continue;
    if (v == null) continue;
    const str = String(v);
    if (str.length > 200) {
      previewParts.push(`${k}: ${str.slice(0, 200)}...`);
    } else {
      previewParts.push(`${k}: ${str}`);
    }
    if (previewParts.length >= 4) break;
  }
  return {
    source,
    matchedColumn,
    preview: previewParts.join(" | "),
    data: row,
  };
}

export async function searchSchemaHandler(
  input: SearchSchemaInput,
): Promise<ToolTextResponse> {
  const topN = input.topN ?? 10;
  const expandedTerms = expandSynonyms(input.query);
  const searchTerms = expandedTerms.length > 0 ? expandedTerms : [input.query.trim().toLowerCase()];

  const matchedKnownTables = new Map<string, (typeof KNOWN_TABLES)[number]>();
  for (const term of searchTerms) {
    for (const t of findKnownTablesByPartial(term)) {
      matchedKnownTables.set(t.fullName, t);
    }
  }

  const matchedKnownRelationships = KNOWN_RELATIONSHIPS.filter((rel) =>
    searchTerms.some(
      (term) =>
        rel.from.toLowerCase().includes(term) ||
        rel.to.toLowerCase().includes(term) ||
        rel.description.toLowerCase().includes(term),
    ),
  );

  const tableNameMatches: MetaTable[] = [];
  const columnNameMatches: MetaColumn[] = [];

  const seenTables = new Set<string>();
  const seenColumns = new Set<string>();
  for (const term of searchTerms) {
    if (term.length < 2) continue;
    try {
      const tableHits = await searchTablesByName(term);
      for (const t of tableHits) {
        if (!seenTables.has(t.fullName)) {
          seenTables.add(t.fullName);
          tableNameMatches.push(t);
        }
      }
    } catch {
      /* skip */
    }
    try {
      const colHits = await searchColumnsByName(term, undefined, 50);
      for (const c of colHits) {
        const k = `${c.database}.${c.schema}.${c.table}.${c.column}`;
        if (!seenColumns.has(k)) {
          seenColumns.add(k);
          columnNameMatches.push(c);
        }
      }
    } catch {
      /* skip */
    }
  }

  const tableDocMatches: DocSummaryRow[] = [];
  const columnDocMatches: DocSummaryRow[] = [];
  const savedQueryMatches: DocSummaryRow[] = [];

  try {
    const rows = await searchDocumentationTable({
      fullTableName: DOCUMENTATION_TABLES.tableNames,
      patterns: searchTerms,
      topN,
    });
    for (const r of rows) {
      const matched = (r.__matchedColumn as string | undefined) ?? null;
      delete r.__matchedColumn;
      tableDocMatches.push(summarizeRow(r, matched, DOCUMENTATION_TABLES.tableNames));
    }
  } catch (err) {
    tableDocMatches.push({
      source: DOCUMENTATION_TABLES.tableNames,
      matchedColumn: null,
      preview: `(could not search: ${err instanceof Error ? err.message : String(err)})`,
      data: {},
    });
  }

  try {
    const rows = await searchDocumentationTable({
      fullTableName: DOCUMENTATION_TABLES.columnNames,
      patterns: searchTerms,
      topN,
    });
    for (const r of rows) {
      const matched = (r.__matchedColumn as string | undefined) ?? null;
      delete r.__matchedColumn;
      columnDocMatches.push(summarizeRow(r, matched, DOCUMENTATION_TABLES.columnNames));
    }
  } catch (err) {
    columnDocMatches.push({
      source: DOCUMENTATION_TABLES.columnNames,
      matchedColumn: null,
      preview: `(could not search: ${err instanceof Error ? err.message : String(err)})`,
      data: {},
    });
  }

  try {
    const rows = await searchDocumentationTable({
      fullTableName: DOCUMENTATION_TABLES.savedQueries,
      patterns: searchTerms,
      topN,
    });
    for (const r of rows) {
      const matched = (r.__matchedColumn as string | undefined) ?? null;
      delete r.__matchedColumn;
      savedQueryMatches.push(summarizeRow(r, matched, DOCUMENTATION_TABLES.savedQueries));
    }
  } catch (err) {
    savedQueryMatches.push({
      source: DOCUMENTATION_TABLES.savedQueries,
      matchedColumn: null,
      preview: `(could not search: ${err instanceof Error ? err.message : String(err)})`,
      data: {},
    });
  }

  const recommendedNextCalls: string[] = [];
  const knownTableArr = Array.from(matchedKnownTables.values());
  for (const t of knownTableArr.slice(0, 4)) {
    recommendedNextCalls.push(`get_table_info("${t.fullName}")`);
  }
  for (const t of knownTableArr.slice(0, 2)) {
    recommendedNextCalls.push(`get_relationships("${t.fullName}")`);
  }
  if (columnNameMatches.length > 0) {
    const sample = columnNameMatches.slice(0, 2);
    for (const c of sample) {
      recommendedNextCalls.push(`get_column_meaning("${c.column}")`);
    }
  }
  recommendedNextCalls.push(`generate_query("${input.query}")`);

  const lines: string[] = [];
  lines.push(`Search query: "${input.query}"`);
  lines.push(`Expanded search terms: ${searchTerms.join(", ")}`);
  lines.push("");

  lines.push("Relevant known tables:");
  if (knownTableArr.length === 0) {
    lines.push("- (none directly matched)");
  } else {
    for (const t of knownTableArr) {
      lines.push(`- ${t.fullName}: ${t.description}`);
    }
  }
  lines.push("");

  lines.push("Known joins:");
  if (matchedKnownRelationships.length === 0) {
    lines.push("- (none directly matched)");
  } else {
    for (const r of matchedKnownRelationships) {
      lines.push(`- ${r.from} = ${r.to} (${r.description})`);
    }
  }
  lines.push("");

  lines.push("Tables matched in SQL Server metadata:");
  if (tableNameMatches.length === 0) {
    lines.push("- (none)");
  } else {
    for (const t of tableNameMatches.slice(0, topN)) {
      lines.push(`- ${t.fullName}`);
    }
  }
  lines.push("");

  lines.push("Columns matched in SQL Server metadata:");
  if (columnNameMatches.length === 0) {
    lines.push("- (none)");
  } else {
    for (const c of columnNameMatches.slice(0, topN)) {
      lines.push(
        `- ${c.database}.${c.schema}.${c.table}.${c.column} (${c.dataType})`,
      );
    }
  }
  lines.push("");

  lines.push("Documentation matches in olAdmin.dbo.NombresTablas:");
  if (tableDocMatches.length === 0) {
    lines.push("- (none)");
  } else {
    for (const r of tableDocMatches.slice(0, topN)) {
      lines.push(`- [${r.matchedColumn ?? "?"}] ${r.preview}`);
    }
  }
  lines.push("");

  lines.push("Documentation matches in olAdmin.dbo.CamposTablas:");
  if (columnDocMatches.length === 0) {
    lines.push("- (none)");
  } else {
    for (const r of columnDocMatches.slice(0, topN)) {
      lines.push(`- [${r.matchedColumn ?? "?"}] ${r.preview}`);
    }
  }
  lines.push("");

  lines.push("Saved ERP query examples in olComun.dbo.maeConsultas:");
  if (savedQueryMatches.length === 0) {
    lines.push("- (none)");
  } else {
    for (const r of savedQueryMatches.slice(0, topN)) {
      lines.push(`- [${r.matchedColumn ?? "?"}] ${r.preview}`);
    }
  }
  lines.push("");

  lines.push("Recommended next calls:");
  for (const r of recommendedNextCalls) {
    lines.push(`- ${r}`);
  }

  return {
    text: lines.join("\n").trim(),
    data: {
      query: input.query,
      expandedTerms: searchTerms,
      knownTables: knownTableArr,
      knownRelationships: matchedKnownRelationships,
      tableNameMatches: tableNameMatches.slice(0, topN),
      columnNameMatches: columnNameMatches.slice(0, topN),
      tableDocumentationMatches: tableDocMatches.slice(0, topN),
      columnDocumentationMatches: columnDocMatches.slice(0, topN),
      savedQueryMatches: savedQueryMatches.slice(0, topN),
      recommendedNextCalls,
    },
  };
}

export function searchSchemaErrorWrap(
  err: unknown,
): ToolTextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(`search_schema failed: ${message}`);
}
