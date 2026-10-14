import { z } from "zod";
import {
  ALLOWED_DATABASES,
  DOCUMENTATION_TABLES,
  KNOWN_RELATIONSHIPS,
  KNOWN_TABLES,
  findKnownRelationshipsForTable,
  findKnownTableByAnyName,
  type AllowedDatabase,
  type KnownRelationship,
} from "../utils/knownSchema.js";
import { parseTableName } from "../utils/normalize.js";
import {
  findTablesAcrossDatabases,
  getInverseForeignKeys,
  getTableColumns,
  getTableForeignKeys,
  searchColumnsByName,
  searchTablesByName,
  type MetaTable,
} from "../utils/metadata.js";
import { searchDocumentationTable } from "../utils/documentationSearch.js";
import { errorResponse, type ToolTextResponse } from "./toolResponse.js";

export const getRelationshipsInputShape = {
  table: z
    .string()
    .min(1, "table must not be empty")
    .describe(
      "Table name. Supports fully qualified, schema.table, partial business name, or short name.",
    ),
};

export const getRelationshipsInputSchema = z.object(getRelationshipsInputShape);
export type GetRelationshipsInput = z.infer<typeof getRelationshipsInputSchema>;

function isAllowedDb(name: string): name is AllowedDatabase {
  return (ALLOWED_DATABASES as readonly string[]).includes(name);
}

async function resolveCandidate(input: string): Promise<MetaTable | null> {
  const known = findKnownTableByAnyName(input);
  if (known) {
    const parts = known.fullName.split(".");
    return {
      database: parts[0],
      schema: parts[1],
      table: parts[2],
      fullName: known.fullName,
    };
  }

  const parsed = parseTableName(input);
  if (parsed?.database && parsed.schema && isAllowedDb(parsed.database)) {
    return {
      database: parsed.database,
      schema: parsed.schema,
      table: parsed.table,
      fullName: parsed.fullName,
    };
  }

  if (parsed?.schema && parsed.table) {
    const exact = await findTablesAcrossDatabases(parsed.schema, parsed.table);
    if (exact.length > 0) return exact[0];
  }

  if (parsed?.table) {
    const exact = await findTablesAcrossDatabases("dbo", parsed.table);
    if (exact.length > 0) return exact[0];
  }

  const fuzzy = await searchTablesByName(input);
  if (fuzzy.length > 0) return fuzzy[0];

  return null;
}

function aliasFor(fullName: string): string {
  const short = fullName.split(".").pop() ?? "t";
  let initials = "";
  for (const ch of short) {
    if (/[A-Z]/.test(ch)) initials += ch.toLowerCase();
  }
  if (initials.length < 2) initials = short.slice(0, 2).toLowerCase();
  return initials.slice(0, 4);
}

function buildJoinExample(rel: KnownRelationship): string {
  const fromParts = rel.from.split(".");
  const toParts = rel.to.split(".");
  if (fromParts.length < 4 || toParts.length < 4) {
    return `-- relationship: ${rel.from} = ${rel.to}`;
  }
  const fromTable = fromParts.slice(0, 3).join(".");
  const toTable = toParts.slice(0, 3).join(".");
  const fromCol = fromParts[3];
  const toCol = toParts[3];
  const a = aliasFor(fromTable);
  const b = aliasFor(toTable);
  return [
    `FROM ${fromTable} ${a} WITH (NOLOCK)`,
    `INNER JOIN ${toTable} ${b} WITH (NOLOCK)`,
    `    ON ${a}.${fromCol} = ${b}.${toCol}`,
  ].join("\n");
}

type InferredRelationship = {
  from: string;
  to: string;
  source: "metadata-fk" | "inferred-by-name";
  description: string;
};

async function inferByColumnName(
  source: MetaTable,
  sourceColumns: { column: string; dataType: string }[],
): Promise<InferredRelationship[]> {
  const idColumns = sourceColumns.filter((c) => /Id$/i.test(c.column));
  if (idColumns.length === 0) return [];

  const inferred: InferredRelationship[] = [];
  for (const col of idColumns) {
    try {
      const matches = await searchColumnsByName(col.column, undefined, 20);
      for (const m of matches) {
        if (
          m.database.toLowerCase() === source.database.toLowerCase() &&
          m.schema.toLowerCase() === source.schema.toLowerCase() &&
          m.table.toLowerCase() === source.table.toLowerCase()
        ) {
          continue;
        }
        if (m.dataType !== col.dataType) continue;
        inferred.push({
          from: `${source.fullName}.${col.column}`,
          to: `${m.database}.${m.schema}.${m.table}.${m.column}`,
          source: "inferred-by-name",
          description: `Inferred by matching column name and data type (${col.dataType}).`,
        });
      }
    } catch {
      /* ignore */
    }
  }

  const seen = new Set<string>();
  return inferred.filter((rel) => {
    const k = `${rel.from}->${rel.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function getRelationshipsHandler(
  input: GetRelationshipsInput,
): Promise<ToolTextResponse> {
  const candidate = await resolveCandidate(input.table);

  if (!candidate) {
    return {
      text: `No table matched "${input.table}". Try search_schema("${input.table}") first.`,
      data: { input: input.table, suggestion: `search_schema("${input.table}")` },
    };
  }

  if (!isAllowedDb(candidate.database)) {
    return {
      text: `Table ${candidate.fullName} is in a database not in the allowlist (${ALLOWED_DATABASES.join(", ")}).`,
      data: { input: input.table, table: candidate, allowedDatabases: ALLOWED_DATABASES },
    };
  }

  const knownRels = findKnownRelationshipsForTable(candidate.fullName);
  let knownByShort: typeof KNOWN_RELATIONSHIPS = [];
  const knownTable = KNOWN_TABLES.find(
    (t) => t.fullName.toLowerCase() === candidate.fullName.toLowerCase(),
  );
  if (knownTable) {
    knownByShort = findKnownRelationshipsForTable(
      knownTable.fullName.split(".").pop() ?? "",
    );
  }
  const allKnown = Array.from(
    new Map(
      [...knownRels, ...knownByShort].map((r) => [`${r.from}->${r.to}`, r]),
    ).values(),
  );

  let metadataFks: Awaited<ReturnType<typeof getTableForeignKeys>> = [];
  let inverseFks: Awaited<ReturnType<typeof getInverseForeignKeys>> = [];
  let columns: Awaited<ReturnType<typeof getTableColumns>> = [];
  const fetchErrors: string[] = [];

  try {
    metadataFks = await getTableForeignKeys(
      candidate.database,
      candidate.schema,
      candidate.table,
    );
  } catch (err) {
    fetchErrors.push(`fk: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    inverseFks = await getInverseForeignKeys(
      candidate.database,
      candidate.schema,
      candidate.table,
    );
  } catch (err) {
    fetchErrors.push(
      `inverse_fk: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    columns = await getTableColumns(
      candidate.database,
      candidate.schema,
      candidate.table,
    );
  } catch (err) {
    fetchErrors.push(
      `columns: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let inferred: InferredRelationship[] = [];
  if (metadataFks.length === 0 && columns.length > 0) {
    try {
      inferred = await inferByColumnName(candidate, columns);
    } catch (err) {
      fetchErrors.push(
        `inferred: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const tableShort = candidate.table;
  let savedQueryExamples: Record<string, unknown>[] = [];
  try {
    savedQueryExamples = await searchDocumentationTable({
      fullTableName: DOCUMENTATION_TABLES.savedQueries,
      patterns: [tableShort, candidate.fullName],
      topN: 5,
    });
    for (const r of savedQueryExamples) delete r.__matchedColumn;
  } catch (err) {
    fetchErrors.push(
      `saved_queries: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines: string[] = [];
  lines.push(`Relationships for ${candidate.fullName}:`);
  lines.push("");

  lines.push("Known ERP relationships (curated):");
  if (allKnown.length === 0) {
    lines.push("- (none)");
  } else {
    for (const rel of allKnown) {
      lines.push(`- ${rel.from} = ${rel.to} (${rel.description})`);
    }
  }
  lines.push("");

  lines.push("Foreign keys from SQL Server metadata (this table -> other):");
  if (metadataFks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const fk of metadataFks) {
      lines.push(
        `- ${fk.fkName}: ${candidate.fullName}.${fk.fromColumns.join("+")} -> ${fk.referencedDatabase}.${fk.referencedSchema}.${fk.referencedTable}.${fk.referencedColumns.join("+")}`,
      );
    }
  }
  lines.push("");

  lines.push("Foreign keys from SQL Server metadata (other -> this table):");
  if (inverseFks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const fk of inverseFks) {
      lines.push(
        `- ${fk.fkName}: ${fk.database}.${fk.schema}.${fk.table}.${fk.fromColumns.join("+")} -> ${candidate.fullName}.${fk.referencedColumns.join("+")}`,
      );
    }
  }
  lines.push("");

  if (inferred.length > 0) {
    lines.push("Inferred relationships (by column name and data type, low confidence):");
    for (const rel of inferred.slice(0, 20)) {
      lines.push(`- ${rel.from} -> ${rel.to} (${rel.description})`);
    }
    lines.push("");
  }

  if (allKnown.length > 0) {
    lines.push("Safe join examples with WITH (NOLOCK):");
    for (const rel of allKnown.slice(0, 5)) {
      lines.push("");
      lines.push("```sql");
      lines.push(buildJoinExample(rel));
      lines.push("```");
    }
    lines.push("");
  }

  if (savedQueryExamples.length > 0) {
    lines.push(
      `Saved ERP query examples (olComun.dbo.maeConsultas) referencing this table [${savedQueryExamples.length}]:`,
    );
    for (const r of savedQueryExamples.slice(0, 3)) {
      const preview = Object.entries(r)
        .filter(([, v]) => v != null)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${shorten(String(v), 100)}`)
        .join(" | ");
      lines.push(`- ${preview}`);
    }
    lines.push("");
  }

  if (fetchErrors.length > 0) {
    lines.push("Notes:");
    for (const e of fetchErrors) lines.push(`- ${e}`);
  }

  return {
    text: lines.join("\n").trim(),
    data: {
      input: input.table,
      table: candidate,
      knownRelationships: allKnown,
      foreignKeysOut: metadataFks,
      foreignKeysIn: inverseFks,
      inferredRelationships: inferred,
      savedQueryExamples,
      fetchErrors,
    },
  };
}

function shorten(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

export function getRelationshipsErrorWrap(err: unknown): ToolTextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(`get_relationships failed: ${message}`);
}
