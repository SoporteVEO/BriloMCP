import { runQuery, sqlTypes } from "../db.js";
import { ALLOWED_DATABASES, type AllowedDatabase } from "./knownSchema.js";

export type MetaTable = {
  database: string;
  schema: string;
  table: string;
  fullName: string;
};

export type MetaColumn = {
  database: string;
  schema: string;
  table: string;
  column: string;
  dataType: string;
  maxLength: number | null;
  isNullable: boolean;
  isIdentity: boolean;
  precision: number | null;
  scale: number | null;
  ordinalPosition: number;
};

export type MetaIndex = {
  database: string;
  schema: string;
  table: string;
  indexName: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
  columns: string[];
};

export type MetaForeignKey = {
  database: string;
  schema: string;
  table: string;
  fkName: string;
  fromColumns: string[];
  referencedDatabase: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
};

function isAllowedDb(name: string): name is AllowedDatabase {
  return (ALLOWED_DATABASES as readonly string[]).includes(name);
}

export async function searchTablesByName(
  pattern: string,
  databases: AllowedDatabase[] = [...ALLOWED_DATABASES],
): Promise<MetaTable[]> {
  const safeDbs = databases.filter(isAllowedDb);
  if (safeDbs.length === 0) return [];

  const unionParts = safeDbs.map((db) => {
    return `
      SELECT
        '${db}' AS database_name,
        s.name AS schema_name,
        t.name AS table_name
      FROM ${db}.sys.tables t
      INNER JOIN ${db}.sys.schemas s ON t.schema_id = s.schema_id
      WHERE t.name LIKE @Pattern
    `;
  });

  const query = `
    ${unionParts.join("\n      UNION ALL\n")}
    ORDER BY database_name, schema_name, table_name;
  `;

  const rows = await runQuery<{
    database_name: string;
    schema_name: string;
    table_name: string;
  }>(query, [
    { name: "Pattern", type: sqlTypes.NVarChar(128), value: `%${pattern}%` },
  ]);

  return rows.map((r) => ({
    database: r.database_name,
    schema: r.schema_name,
    table: r.table_name,
    fullName: `${r.database_name}.${r.schema_name}.${r.table_name}`,
  }));
}

export async function searchColumnsByName(
  pattern: string,
  databases: AllowedDatabase[] = [...ALLOWED_DATABASES],
  topN = 100,
): Promise<MetaColumn[]> {
  const safeDbs = databases.filter(isAllowedDb);
  if (safeDbs.length === 0) return [];

  const unionParts = safeDbs.map((db) => {
    return `
      SELECT TOP (${Math.max(1, Math.min(topN, 500))})
        '${db}' AS database_name,
        s.name AS schema_name,
        t.name AS table_name,
        c.name AS column_name,
        ty.name AS data_type,
        c.max_length AS max_length,
        c.is_nullable AS is_nullable,
        c.is_identity AS is_identity,
        c.precision AS [precision],
        c.scale AS [scale],
        c.column_id AS ordinal_position
      FROM ${db}.sys.tables t
      INNER JOIN ${db}.sys.schemas s ON t.schema_id = s.schema_id
      INNER JOIN ${db}.sys.columns c ON t.object_id = c.object_id
      INNER JOIN ${db}.sys.types ty ON c.user_type_id = ty.user_type_id
      WHERE c.name LIKE @Pattern
    `;
  });

  const query = `
    ${unionParts.join("\n      UNION ALL\n")}
    ORDER BY database_name, schema_name, table_name, column_name;
  `;

  const rows = await runQuery<{
    database_name: string;
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    max_length: number;
    is_nullable: boolean;
    is_identity: boolean;
    precision: number;
    scale: number;
    ordinal_position: number;
  }>(query, [
    { name: "Pattern", type: sqlTypes.NVarChar(128), value: `%${pattern}%` },
  ]);

  return rows.map((r) => ({
    database: r.database_name,
    schema: r.schema_name,
    table: r.table_name,
    column: r.column_name,
    dataType: r.data_type,
    maxLength: r.max_length ?? null,
    isNullable: !!r.is_nullable,
    isIdentity: !!r.is_identity,
    precision: r.precision ?? null,
    scale: r.scale ?? null,
    ordinalPosition: r.ordinal_position,
  }));
}

export async function getTableColumns(
  database: AllowedDatabase,
  schema: string,
  table: string,
): Promise<MetaColumn[]> {
  if (!isAllowedDb(database)) return [];

  const query = `
    SELECT
      '${database}' AS database_name,
      s.name AS schema_name,
      t.name AS table_name,
      c.name AS column_name,
      ty.name AS data_type,
      c.max_length AS max_length,
      c.is_nullable AS is_nullable,
      c.is_identity AS is_identity,
      c.precision AS [precision],
      c.scale AS [scale],
      c.column_id AS ordinal_position
    FROM ${database}.sys.tables t
    INNER JOIN ${database}.sys.schemas s ON t.schema_id = s.schema_id
    INNER JOIN ${database}.sys.columns c ON t.object_id = c.object_id
    INNER JOIN ${database}.sys.types ty ON c.user_type_id = ty.user_type_id
    WHERE s.name = @Schema AND t.name = @Table
    ORDER BY c.column_id;
  `;

  const rows = await runQuery<{
    database_name: string;
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    max_length: number;
    is_nullable: boolean;
    is_identity: boolean;
    precision: number;
    scale: number;
    ordinal_position: number;
  }>(query, [
    { name: "Schema", type: sqlTypes.NVarChar(128), value: schema },
    { name: "Table", type: sqlTypes.NVarChar(128), value: table },
  ]);

  return rows.map((r) => ({
    database: r.database_name,
    schema: r.schema_name,
    table: r.table_name,
    column: r.column_name,
    dataType: r.data_type,
    maxLength: r.max_length ?? null,
    isNullable: !!r.is_nullable,
    isIdentity: !!r.is_identity,
    precision: r.precision ?? null,
    scale: r.scale ?? null,
    ordinalPosition: r.ordinal_position,
  }));
}

export async function getTableIndexes(
  database: AllowedDatabase,
  schema: string,
  table: string,
): Promise<MetaIndex[]> {
  if (!isAllowedDb(database)) return [];

  const query = `
    SELECT
      i.name AS index_name,
      i.is_primary_key AS is_primary_key,
      i.is_unique AS is_unique,
      c.name AS column_name,
      ic.key_ordinal AS key_ordinal,
      ic.is_included_column AS is_included
    FROM ${database}.sys.indexes i
    INNER JOIN ${database}.sys.index_columns ic
      ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    INNER JOIN ${database}.sys.columns c
      ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    INNER JOIN ${database}.sys.tables t ON i.object_id = t.object_id
    INNER JOIN ${database}.sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = @Schema AND t.name = @Table
      AND i.name IS NOT NULL
      AND ic.is_included_column = 0
    ORDER BY i.name, ic.key_ordinal;
  `;

  const rows = await runQuery<{
    index_name: string;
    is_primary_key: boolean;
    is_unique: boolean;
    column_name: string;
    key_ordinal: number;
    is_included: boolean;
  }>(query, [
    { name: "Schema", type: sqlTypes.NVarChar(128), value: schema },
    { name: "Table", type: sqlTypes.NVarChar(128), value: table },
  ]);

  const grouped = new Map<string, MetaIndex>();
  for (const r of rows) {
    const existing = grouped.get(r.index_name);
    if (existing) {
      existing.columns.push(r.column_name);
    } else {
      grouped.set(r.index_name, {
        database,
        schema,
        table,
        indexName: r.index_name,
        isPrimaryKey: !!r.is_primary_key,
        isUnique: !!r.is_unique,
        columns: [r.column_name],
      });
    }
  }
  return Array.from(grouped.values());
}

export async function getTableForeignKeys(
  database: AllowedDatabase,
  schema: string,
  table: string,
): Promise<MetaForeignKey[]> {
  if (!isAllowedDb(database)) return [];

  const query = `
    SELECT
      fk.name AS fk_name,
      ps.name AS parent_schema,
      pt.name AS parent_table,
      pc.name AS parent_column,
      rs.name AS ref_schema,
      rt.name AS ref_table,
      rc.name AS ref_column,
      fkc.constraint_column_id AS ord
    FROM ${database}.sys.foreign_keys fk
    INNER JOIN ${database}.sys.foreign_key_columns fkc
      ON fk.object_id = fkc.constraint_object_id
    INNER JOIN ${database}.sys.tables pt
      ON fk.parent_object_id = pt.object_id
    INNER JOIN ${database}.sys.schemas ps
      ON pt.schema_id = ps.schema_id
    INNER JOIN ${database}.sys.columns pc
      ON fkc.parent_object_id = pc.object_id
      AND fkc.parent_column_id = pc.column_id
    INNER JOIN ${database}.sys.tables rt
      ON fk.referenced_object_id = rt.object_id
    INNER JOIN ${database}.sys.schemas rs
      ON rt.schema_id = rs.schema_id
    INNER JOIN ${database}.sys.columns rc
      ON fkc.referenced_object_id = rc.object_id
      AND fkc.referenced_column_id = rc.column_id
    WHERE ps.name = @Schema AND pt.name = @Table
    ORDER BY fk.name, fkc.constraint_column_id;
  `;

  const rows = await runQuery<{
    fk_name: string;
    parent_schema: string;
    parent_table: string;
    parent_column: string;
    ref_schema: string;
    ref_table: string;
    ref_column: string;
    ord: number;
  }>(query, [
    { name: "Schema", type: sqlTypes.NVarChar(128), value: schema },
    { name: "Table", type: sqlTypes.NVarChar(128), value: table },
  ]);

  const grouped = new Map<string, MetaForeignKey>();
  for (const r of rows) {
    const key = r.fk_name;
    const existing = grouped.get(key);
    if (existing) {
      existing.fromColumns.push(r.parent_column);
      existing.referencedColumns.push(r.ref_column);
    } else {
      grouped.set(key, {
        database,
        schema: r.parent_schema,
        table: r.parent_table,
        fkName: r.fk_name,
        fromColumns: [r.parent_column],
        referencedDatabase: database,
        referencedSchema: r.ref_schema,
        referencedTable: r.ref_table,
        referencedColumns: [r.ref_column],
      });
    }
  }
  return Array.from(grouped.values());
}

export async function getInverseForeignKeys(
  database: AllowedDatabase,
  schema: string,
  table: string,
): Promise<MetaForeignKey[]> {
  if (!isAllowedDb(database)) return [];

  const query = `
    SELECT
      fk.name AS fk_name,
      ps.name AS parent_schema,
      pt.name AS parent_table,
      pc.name AS parent_column,
      rs.name AS ref_schema,
      rt.name AS ref_table,
      rc.name AS ref_column,
      fkc.constraint_column_id AS ord
    FROM ${database}.sys.foreign_keys fk
    INNER JOIN ${database}.sys.foreign_key_columns fkc
      ON fk.object_id = fkc.constraint_object_id
    INNER JOIN ${database}.sys.tables pt
      ON fk.parent_object_id = pt.object_id
    INNER JOIN ${database}.sys.schemas ps
      ON pt.schema_id = ps.schema_id
    INNER JOIN ${database}.sys.columns pc
      ON fkc.parent_object_id = pc.object_id
      AND fkc.parent_column_id = pc.column_id
    INNER JOIN ${database}.sys.tables rt
      ON fk.referenced_object_id = rt.object_id
    INNER JOIN ${database}.sys.schemas rs
      ON rt.schema_id = rs.schema_id
    INNER JOIN ${database}.sys.columns rc
      ON fkc.referenced_object_id = rc.object_id
      AND fkc.referenced_column_id = rc.column_id
    WHERE rs.name = @Schema AND rt.name = @Table
    ORDER BY fk.name, fkc.constraint_column_id;
  `;

  const rows = await runQuery<{
    fk_name: string;
    parent_schema: string;
    parent_table: string;
    parent_column: string;
    ref_schema: string;
    ref_table: string;
    ref_column: string;
    ord: number;
  }>(query, [
    { name: "Schema", type: sqlTypes.NVarChar(128), value: schema },
    { name: "Table", type: sqlTypes.NVarChar(128), value: table },
  ]);

  const grouped = new Map<string, MetaForeignKey>();
  for (const r of rows) {
    const key = r.fk_name;
    const existing = grouped.get(key);
    if (existing) {
      existing.fromColumns.push(r.parent_column);
      existing.referencedColumns.push(r.ref_column);
    } else {
      grouped.set(key, {
        database,
        schema: r.parent_schema,
        table: r.parent_table,
        fkName: r.fk_name,
        fromColumns: [r.parent_column],
        referencedDatabase: database,
        referencedSchema: r.ref_schema,
        referencedTable: r.ref_table,
        referencedColumns: [r.ref_column],
      });
    }
  }
  return Array.from(grouped.values());
}

export async function findTablesAcrossDatabases(
  schema: string,
  table: string,
): Promise<MetaTable[]> {
  const results: MetaTable[] = [];
  for (const db of ALLOWED_DATABASES) {
    const query = `
      SELECT
        '${db}' AS database_name,
        s.name AS schema_name,
        t.name AS table_name
      FROM ${db}.sys.tables t
      INNER JOIN ${db}.sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = @Schema AND t.name = @Table;
    `;
    try {
      const rows = await runQuery<{
        database_name: string;
        schema_name: string;
        table_name: string;
      }>(query, [
        { name: "Schema", type: sqlTypes.NVarChar(128), value: schema },
        { name: "Table", type: sqlTypes.NVarChar(128), value: table },
      ]);
      for (const r of rows) {
        results.push({
          database: r.database_name,
          schema: r.schema_name,
          table: r.table_name,
          fullName: `${r.database_name}.${r.schema_name}.${r.table_name}`,
        });
      }
    } catch {
      /* swallow per-db errors */
    }
  }
  return results;
}
