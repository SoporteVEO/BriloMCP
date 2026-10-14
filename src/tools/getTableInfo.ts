import { z } from "zod";
import {
  ALLOWED_DATABASES,
  DOCUMENTATION_TABLES,
  KNOWN_RELATIONSHIPS,
  findKnownTableByAnyName,
  type AllowedDatabase,
} from "../utils/knownSchema.js";
import { parseTableName } from "../utils/normalize.js";
import {
  findTablesAcrossDatabases,
  getTableColumns,
  getTableForeignKeys,
  getTableIndexes,
  searchTablesByName,
  type MetaTable,
} from "../utils/metadata.js";
import { searchDocumentationTable } from "../utils/documentationSearch.js";
import { errorResponse, type ToolTextResponse } from "./toolResponse.js";

export const getTableInfoInputShape = {
  table: z
    .string()
    .min(1, "table must not be empty")
    .describe(
      "Table name. Supports fully qualified (database.schema.table), schema.table, partial business name, or short name.",
    ),
};

export const getTableInfoInputSchema = z.object(getTableInfoInputShape);
export type GetTableInfoInput = z.infer<typeof getTableInfoInputSchema>;

function isAllowedDb(name: string): name is AllowedDatabase {
  return (ALLOWED_DATABASES as readonly string[]).includes(name);
}

async function resolveCandidateTables(input: string): Promise<MetaTable[]> {
  const known = findKnownTableByAnyName(input);
  const parsed = parseTableName(input);
  const candidates: MetaTable[] = [];
  const seen = new Set<string>();

  function add(t: MetaTable) {
    const k = t.fullName.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      candidates.push(t);
    }
  }

  if (known) {
    const parts = known.fullName.split(".");
    add({
      database: parts[0],
      schema: parts[1],
      table: parts[2],
      fullName: known.fullName,
    });
  }

  if (parsed) {
    if (parsed.database && parsed.schema && isAllowedDb(parsed.database)) {
      add({
        database: parsed.database,
        schema: parsed.schema,
        table: parsed.table,
        fullName: parsed.fullName,
      });
    } else if (parsed.schema && parsed.table) {
      try {
        const exact = await findTablesAcrossDatabases(parsed.schema, parsed.table);
        for (const t of exact) add(t);
      } catch {
        /* ignore */
      }
    } else if (parsed.table) {
      try {
        const exact = await findTablesAcrossDatabases("dbo", parsed.table);
        for (const t of exact) add(t);
      } catch {
        /* ignore */
      }
    }
  }

  if (candidates.length === 0) {
    try {
      const fuzzy = await searchTablesByName(input);
      for (const t of fuzzy.slice(0, 10)) add(t);
    } catch {
      /* ignore */
    }
  }

  return candidates;
}

async function getDocumentationForTable(
  fullName: string,
): Promise<{ tableDoc: Record<string, unknown>[]; columnDocs: Record<string, unknown>[] }> {
  const parts = fullName.split(".");
  const tableShort = parts[parts.length - 1];

  const tableDoc: Record<string, unknown>[] = [];
  const columnDocs: Record<string, unknown>[] = [];

  try {
    const rows = await searchDocumentationTable({
      fullTableName: DOCUMENTATION_TABLES.tableNames,
      patterns: [tableShort],
      topN: 5,
    });
    for (const r of rows) {
      delete r.__matchedColumn;
      tableDoc.push(r);
    }
  } catch {
    /* ignore */
  }

  try {
    const rows = await searchDocumentationTable({
      fullTableName: DOCUMENTATION_TABLES.columnNames,
      patterns: [tableShort],
      topN: 50,
    });
    for (const r of rows) {
      delete r.__matchedColumn;
      columnDocs.push(r);
    }
  } catch {
    /* ignore */
  }

  return { tableDoc, columnDocs };
}

async function getRelatedSavedQueries(
  fullName: string,
): Promise<Record<string, unknown>[]> {
  const parts = fullName.split(".");
  const tableShort = parts[parts.length - 1];
  try {
    const rows = await searchDocumentationTable({
      fullTableName: DOCUMENTATION_TABLES.savedQueries,
      patterns: [tableShort, fullName],
      topN: 5,
    });
    for (const r of rows) delete r.__matchedColumn;
    return rows;
  } catch {
    return [];
  }
}

export async function getTableInfoHandler(
  input: GetTableInfoInput,
): Promise<ToolTextResponse> {
  const candidates = await resolveCandidateTables(input.table);

  if (candidates.length === 0) {
    return {
      text: `No tables matched "${input.table}". Try search_schema("${input.table}") first to discover tables.`,
      data: {
        input: input.table,
        candidates: [],
        suggestion: `search_schema("${input.table}")`,
      },
    };
  }

  const tablesData: Record<string, unknown>[] = [];
  const lines: string[] = [];
  lines.push(`Resolved ${candidates.length} table(s) for "${input.table}".`);
  lines.push("");

  const limit = Math.min(candidates.length, 5);
  for (let i = 0; i < limit; i++) {
    const t = candidates[i];
    if (!isAllowedDb(t.database)) {
      lines.push(`Skipping ${t.fullName}: database not in allowlist.`);
      continue;
    }

    let columns: Awaited<ReturnType<typeof getTableColumns>> = [];
    let indexes: Awaited<ReturnType<typeof getTableIndexes>> = [];
    let foreignKeys: Awaited<ReturnType<typeof getTableForeignKeys>> = [];
    let inverseFks: Awaited<ReturnType<typeof getTableForeignKeys>> = [];
    let tableDoc: Record<string, unknown>[] = [];
    let columnDocs: Record<string, unknown>[] = [];
    let savedQueries: Record<string, unknown>[] = [];
    const fetchErrors: string[] = [];

    try {
      columns = await getTableColumns(t.database, t.schema, t.table);
    } catch (err) {
      fetchErrors.push(
        `columns: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      indexes = await getTableIndexes(t.database, t.schema, t.table);
    } catch (err) {
      fetchErrors.push(
        `indexes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      foreignKeys = await getTableForeignKeys(t.database, t.schema, t.table);
    } catch (err) {
      fetchErrors.push(
        `foreign_keys: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const { getInverseForeignKeys } = await import("../utils/metadata.js");
      inverseFks = await getInverseForeignKeys(t.database, t.schema, t.table);
    } catch (err) {
      fetchErrors.push(
        `inverse_fks: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const docs = await getDocumentationForTable(t.fullName);
      tableDoc = docs.tableDoc;
      columnDocs = docs.columnDocs;
    } catch (err) {
      fetchErrors.push(
        `documentation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      savedQueries = await getRelatedSavedQueries(t.fullName);
    } catch (err) {
      fetchErrors.push(
        `saved_queries: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const knownRels = KNOWN_RELATIONSHIPS.filter((rel) => {
      const fromTable = rel.from.split(".").slice(0, 3).join(".").toLowerCase();
      const toTable = rel.to.split(".").slice(0, 3).join(".").toLowerCase();
      return (
        fromTable === t.fullName.toLowerCase() ||
        toTable === t.fullName.toLowerCase()
      );
    });

    const pkIndex = indexes.find((idx) => idx.isPrimaryKey);

    lines.push(`### ${t.fullName}`);
    lines.push(`Database: ${t.database}`);
    lines.push(`Schema: ${t.schema}`);
    lines.push(`Table: ${t.table}`);
    if (pkIndex) {
      lines.push(`Primary key: ${pkIndex.indexName} (${pkIndex.columns.join(", ")})`);
    } else {
      lines.push(`Primary key: (none detected)`);
    }
    lines.push("");

    lines.push(`Columns (${columns.length}):`);
    for (const c of columns) {
      const len = c.maxLength != null && c.maxLength >= 0 ? `(${c.maxLength})` : "";
      lines.push(
        `- ${c.column} ${c.dataType}${len}${c.isNullable ? " NULL" : " NOT NULL"}${c.isIdentity ? " IDENTITY" : ""}`,
      );
    }
    lines.push("");

    if (indexes.length > 0) {
      lines.push("Indexes:");
      for (const idx of indexes) {
        const labels: string[] = [];
        if (idx.isPrimaryKey) labels.push("PK");
        if (idx.isUnique) labels.push("UNIQUE");
        const tags = labels.length ? ` [${labels.join(", ")}]` : "";
        lines.push(`- ${idx.indexName}${tags}: ${idx.columns.join(", ")}`);
      }
      lines.push("");
    }

    if (foreignKeys.length > 0) {
      lines.push("Foreign keys (this table -> other):");
      for (const fk of foreignKeys) {
        lines.push(
          `- ${fk.fkName}: ${fk.table}.${fk.fromColumns.join("+")} -> ${fk.referencedSchema}.${fk.referencedTable}.${fk.referencedColumns.join("+")}`,
        );
      }
      lines.push("");
    }

    if (inverseFks.length > 0) {
      lines.push("Foreign keys (other -> this table):");
      for (const fk of inverseFks) {
        lines.push(
          `- ${fk.fkName}: ${fk.schema}.${fk.table}.${fk.fromColumns.join("+")} -> this.${fk.referencedColumns.join("+")}`,
        );
      }
      lines.push("");
    }

    if (knownRels.length > 0) {
      lines.push("Known ERP relationships:");
      for (const rel of knownRels) {
        lines.push(`- ${rel.from} = ${rel.to} (${rel.description})`);
      }
      lines.push("");
    }

    if (tableDoc.length > 0) {
      lines.push("Table documentation rows (olAdmin.dbo.NombresTablas):");
      for (const r of tableDoc.slice(0, 3)) {
        lines.push(`- ${shortPreview(r)}`);
      }
      lines.push("");
    }

    if (columnDocs.length > 0) {
      lines.push(`Column documentation rows (olAdmin.dbo.CamposTablas) [${columnDocs.length}]:`);
      for (const r of columnDocs.slice(0, 8)) {
        lines.push(`- ${shortPreview(r)}`);
      }
      lines.push("");
    }

    if (savedQueries.length > 0) {
      lines.push(`Related saved queries (olComun.dbo.maeConsultas) [${savedQueries.length}]:`);
      for (const r of savedQueries.slice(0, 3)) {
        lines.push(`- ${shortPreview(r)}`);
      }
      lines.push("");
    }

    if (fetchErrors.length > 0) {
      lines.push("Notes:");
      for (const e of fetchErrors) lines.push(`- ${e}`);
      lines.push("");
    }

    tablesData.push({
      fullName: t.fullName,
      database: t.database,
      schema: t.schema,
      table: t.table,
      primaryKey: pkIndex
        ? { name: pkIndex.indexName, columns: pkIndex.columns }
        : null,
      columns,
      indexes,
      foreignKeys,
      inverseForeignKeys: inverseFks,
      knownRelationships: knownRels,
      tableDocumentation: tableDoc,
      columnDocumentation: columnDocs,
      savedQueryExamples: savedQueries,
      fetchErrors,
    });
  }

  if (candidates.length > limit) {
    lines.push(
      `(${candidates.length - limit} additional candidate table(s) not detailed; refine your input.)`,
    );
  }

  return {
    text: lines.join("\n").trim(),
    data: {
      input: input.table,
      candidatesCount: candidates.length,
      tables: tablesData,
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

export function getTableInfoErrorWrap(err: unknown): ToolTextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(`get_table_info failed: ${message}`);
}
