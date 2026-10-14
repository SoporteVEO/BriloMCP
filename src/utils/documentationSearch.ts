import { runQuery, sqlTypes } from "../db.js";
import { ALLOWED_DATABASES, type AllowedDatabase } from "./knownSchema.js";

const LIKELY_TEXT_COLUMN_KEYWORDS = [
  "name",
  "nombre",
  "description",
  "descripcion",
  "tabla",
  "table",
  "campo",
  "field",
  "column",
  "columna",
  "query",
  "consulta",
  "sql",
  "texto",
  "observacion",
  "comentario",
  "titulo",
  "title",
  "label",
  "etiqueta",
  "abrev",
];

const TEXT_TYPE_NAMES = new Set([
  "varchar",
  "nvarchar",
  "char",
  "nchar",
  "text",
  "ntext",
  "sysname",
  "xml",
]);

const KEY_TYPE_NAMES = new Set([
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "uniqueidentifier",
]);

export type DocColumnInfo = {
  database: string;
  schema: string;
  table: string;
  column: string;
  dataType: string;
  isText: boolean;
  isLikelyTextSearchable: boolean;
  isLikelyKey: boolean;
  maxLength: number | null;
};

const columnCache = new Map<string, DocColumnInfo[]>();

function isAllowedDatabase(name: string): name is AllowedDatabase {
  return (ALLOWED_DATABASES as readonly string[]).includes(name);
}

function nameMatchesLikelyText(columnName: string): boolean {
  const lc = columnName.toLowerCase();
  return LIKELY_TEXT_COLUMN_KEYWORDS.some((kw) => lc.includes(kw));
}

function buildColumnsQuery(database: AllowedDatabase): string {
  return `
    SELECT
      '${database}' AS database_name,
      s.name AS schema_name,
      t.name AS table_name,
      c.name AS column_name,
      ty.name AS data_type,
      c.max_length AS max_length
    FROM ${database}.sys.tables t
    INNER JOIN ${database}.sys.schemas s ON t.schema_id = s.schema_id
    INNER JOIN ${database}.sys.columns c ON t.object_id = c.object_id
    INNER JOIN ${database}.sys.types ty
      ON c.user_type_id = ty.user_type_id
    WHERE s.name = @Schema
      AND t.name = @Table
    ORDER BY c.column_id;
  `;
}

export async function getDocumentationTableColumns(
  fullName: string,
): Promise<DocColumnInfo[]> {
  const parts = fullName.split(".");
  if (parts.length !== 3) return [];
  const [database, schema, table] = parts;

  if (!isAllowedDatabase(database)) return [];

  const cacheKey = fullName.toLowerCase();
  const cached = columnCache.get(cacheKey);
  if (cached) return cached;

  const rows = await runQuery<{
    database_name: string;
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    max_length: number;
  }>(buildColumnsQuery(database), [
    { name: "Schema", type: sqlTypes.NVarChar(128), value: schema },
    { name: "Table", type: sqlTypes.NVarChar(128), value: table },
  ]);

  const cols: DocColumnInfo[] = rows.map((r) => {
    const isText = TEXT_TYPE_NAMES.has(r.data_type.toLowerCase());
    return {
      database: r.database_name,
      schema: r.schema_name,
      table: r.table_name,
      column: r.column_name,
      dataType: r.data_type,
      isText,
      isLikelyTextSearchable: isText && nameMatchesLikelyText(r.column_name),
      isLikelyKey: KEY_TYPE_NAMES.has(r.data_type.toLowerCase()),
      maxLength: r.max_length ?? null,
    };
  });

  columnCache.set(cacheKey, cols);
  return cols;
}

export type DocSearchOptions = {
  fullTableName: string;
  patterns: string[];
  topN?: number;
  preferKeyColumns?: string[];
};

export type DocSearchRow = Record<string, unknown> & {
  __matchedColumn?: string;
};

function quoteIdent(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

export async function searchDocumentationTable(
  options: DocSearchOptions,
): Promise<DocSearchRow[]> {
  const { fullTableName, patterns, topN = 25 } = options;
  if (patterns.length === 0) return [];

  const cols = await getDocumentationTableColumns(fullTableName);
  const textCols = cols.filter((c) => c.isLikelyTextSearchable);
  const fallbackTextCols = cols.filter(
    (c) => c.isText && c.maxLength !== 0 && (c.maxLength ?? 0) <= 4000,
  );

  const searchCols = textCols.length > 0 ? textCols : fallbackTextCols;
  if (searchCols.length === 0) return [];

  const selectCols = cols.slice(0, 30);
  const selectList = selectCols
    .map((c) => quoteIdent(c.column))
    .join(",\n      ");

  const whereClauses: string[] = [];
  const params: { name: string; type: ReturnType<typeof sqlTypes.NVarChar>; value: unknown }[] = [];

  patterns.forEach((p, idx) => {
    const paramName = `p${idx}`;
    params.push({
      name: paramName,
      type: sqlTypes.NVarChar(4000),
      value: `%${p}%`,
    });
    const colsClause = searchCols
      .map((c) => `${quoteIdent(c.column)} LIKE @${paramName}`)
      .join(" OR ");
    whereClauses.push(`(${colsClause})`);
  });

  const whereSql = whereClauses.join(" OR ");
  const query = `
    SELECT TOP (${Math.max(1, Math.min(topN, 200))})
      ${selectList}
    FROM ${fullTableName} WITH (NOLOCK)
    WHERE ${whereSql};
  `;

  const rows = await runQuery<DocSearchRow>(query, params);

  const matchedColCache: { col: string; param: RegExp }[] = [];
  for (let i = 0; i < patterns.length; i++) {
    matchedColCache.push({
      col: `p${i}`,
      param: new RegExp(escapeRegex(patterns[i]), "i"),
    });
  }

  for (const row of rows) {
    let matched: string | undefined;
    for (const c of searchCols) {
      const value = row[c.column];
      if (value == null) continue;
      const text = String(value);
      if (matchedColCache.some((m) => m.param.test(text))) {
        matched = c.column;
        break;
      }
    }
    if (matched) row.__matchedColumn = matched;
  }

  return rows;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
