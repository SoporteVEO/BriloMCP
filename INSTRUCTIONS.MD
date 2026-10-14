# Cursor Task: Build a Read-Only SQL Server MCP Server for the Brilo ERP Database

Build a custom MCP server that helps Cursor understand and work with a large, complex SQL Server database used by Brilo ERP.

The goal is to create a safe read-only MCP server that can inspect database metadata, search ERP documentation tables, understand table and column meanings, discover relationships, review existing ERP query examples, generate SQL Server query drafts, and validate generated queries before they are used.

This MCP server will be used inside Cursor while developing a web app that depends on this database.

## Main Goal

I want to be able to ask questions like:

```text
search_schema("ventas este mes")
get_table_info("Facturas")
get_relationships("Facturas")
get_column_meaning("fecha_factura")
generate_query("ventas de este mes por cliente")
validate_query(sql)
```

The MCP server should always have access to the database schema context through tools, so I do not have to explain the database structure manually every time.

## Important Database Context

The SQL Server instance contains data distributed across multiple databases.

The main known databases and tables are:

### Products

```text
olComun.dbo.Productos
```

This is the products table.

### Clients

```text
olComun.dbo.Clientes
```

This is the clients table.

It is related to:

```text
olComun.dbo.TiposActividadesEconomicas
```

Through the field:

```text
Clientes.tactecoId
```

### Invoice Headers

```text
olVentas.dbo.maeFacturas
```

This is the invoice header table.

It is related to clients through:

```text
maeFacturas.cliIdInvoiceTo = Clientes.cliId
```

### Invoice Details / Items

```text
olVentas.dbo.detFacturas
```

This is the invoice detail/items table.

It is related to invoice headers through:

```text
detFacturas.mfaId = maeFacturas.mfaId
```

It is related to products through:

```text
detFacturas.proId = Productos.proId
```

### Invoice Payments

```text
olVentas.dbo.AbonosCXC
```

This is the invoice payments table.

It is related to `maeFacturas` through the intermediate table:

```text
olVentas.dbo.detCXC
```

The relationship is:

```text
detCXC.mfaId = maeFacturas.mfaId
detCXC.dccId = AbonosCXC.dccId
```

### Existing ERP Query Examples

```text
olComun.dbo.maeConsultas
```

This table contains existing queries created by the ERP team. The MCP server should use this table to learn how the ERP team relates data efficiently and in a standardized way.

### Table Documentation

```text
olAdmin.dbo.NombresTablas
```

This table contains names and information about tables.

### Column Documentation

```text
olAdmin.dbo.CamposTablas
```

This table contains names and information about fields/columns.

## Critical SQL Rules

The MCP server must follow these rules when generating SQL:

1. Always use fully qualified table names.

Correct:

```sql
olVentas.dbo.maeFacturas
olVentas.dbo.detFacturas
olComun.dbo.Clientes
olComun.dbo.Productos
```

Incorrect:

```sql
maeFacturas
detFacturas
Clientes
Productos
```

2. Every query that reads ERP tables must use `WITH (NOLOCK)`.

Correct:

```sql
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK)
INNER JOIN olComun.dbo.Clientes c WITH (NOLOCK)
    ON mf.cliIdInvoiceTo = c.cliId
```

Incorrect:

```sql
FROM olVentas.dbo.maeFacturas mf
INNER JOIN olComun.dbo.Clientes c
    ON mf.cliIdInvoiceTo = c.cliId
```

3. Only read-only SQL is allowed.

Allowed:

```sql
SELECT
WITH ... SELECT
```

Not allowed:

```sql
INSERT
UPDATE
DELETE
MERGE
DROP
ALTER
CREATE
TRUNCATE
EXEC
EXECUTE
GRANT
REVOKE
DENY
BACKUP
RESTORE
DBCC
```

4. Queries must be SARGABLE whenever possible.

Correct:

```sql
WHERE mf.fechaFactura >= @StartDate
  AND mf.fechaFactura < @EndDate
```

Avoid:

```sql
WHERE CAST(mf.fechaFactura AS DATE) = @Date
WHERE CONVERT(DATE, mf.fechaFactura) = @Date
WHERE YEAR(mf.fechaFactura) = 2026
WHERE MONTH(mf.fechaFactura) = 5
```

5. Avoid `SELECT *`.

Correct:

```sql
SELECT TOP (100)
    mf.mfaId,
    mf.cliIdInvoiceTo
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK);
```

Incorrect:

```sql
SELECT *
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK);
```

6. Add `TOP` when previewing data.

Correct:

```sql
SELECT TOP (100)
    mf.mfaId,
    mf.cliIdInvoiceTo
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK);
```

7. For date ranges, use safe SARGABLE logic.

For “this month”, use:

```sql
DECLARE @StartDate DATE = DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1);
DECLARE @EndDate DATE = DATEADD(MONTH, 1, @StartDate);
```

Then:

```sql
WHERE mf.SomeDateColumn >= @StartDate
  AND mf.SomeDateColumn < @EndDate
```

8. The MCP server should never execute destructive SQL.

9. The MCP server should not assume unknown business meanings.

If the meaning of a table or column is unclear, search:

```text
olAdmin.dbo.CamposTablas
olAdmin.dbo.NombresTablas
olComun.dbo.maeConsultas
SQL Server catalog metadata
```

10. The MCP server should prioritize ERP-provided query examples from:

```text
olComun.dbo.maeConsultas
```

11. The MCP server should help Cursor produce queries, but the final SQL should include a short explanation of assumptions.

## Environment Variables

The project must read database credentials from a `.env` file.

Use these exact environment variables:

```env
SQLSERVER_HOST=
SQLSERVER_PORT=
SQLSERVER_USERNAME=
SQLSERVER_PASSWORD=
```

The SQL Server instance contains multiple databases, so the MCP server must use fully qualified table names in all queries.

If the SQL Server driver requires a database name, default to:

```text
master
```

Do not require an additional database environment variable.

## Project Requirements

Create a Node.js + TypeScript MCP server.

Use these dependencies:

```text
typescript
tsx
dotenv
mssql
zod
@modelcontextprotocol/sdk
```

The project should have this structure:

```text
brilo-sqlserver-mcp/
  package.json
  tsconfig.json
  .env.example
  .gitignore
  README.md
  src/
    index.ts
    db.ts
    tools/
      searchSchema.ts
      getTableInfo.ts
      getRelationships.ts
      getColumnMeaning.ts
      generateQuery.ts
      validateQuery.ts
    utils/
      sqlSafety.ts
      normalize.ts
      knownSchema.ts
```

## package.json Requirements

Create a `package.json` with these scripts:

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

The server should be runnable with:

```bash
npm run dev
```

And buildable with:

```bash
npm run build
npm run start
```

## .env.example

Create `.env.example`:

```env
SQLSERVER_HOST=your-sql-server-host
SQLSERVER_PORT=1433
SQLSERVER_USERNAME=readonly_user
SQLSERVER_PASSWORD=your_password
```

Create `.gitignore` and include:

```text
node_modules
dist
.env
```

Do not commit the real `.env`.

## Database Connection

Create `src/db.ts`.

Use the `mssql` package.

The connection must:

- Read credentials from `.env`
- Use `SQLSERVER_HOST`
- Use `SQLSERVER_PORT`
- Use `SQLSERVER_USERNAME`
- Use `SQLSERVER_PASSWORD`
- Default database to `master`
- Use a connection pool
- Reuse the pool instead of reconnecting on every tool call
- Set `encrypt: true`
- Set `trustServerCertificate: true`
- Set a reasonable query timeout

The file should expose:

```ts
getPool();
```

Expected behavior:

- If the pool is already connected, reuse it.
- If not connected, create a new connection pool.
- Never log the database password.

## Known Schema Hints

Create `src/utils/knownSchema.ts`.

Include hardcoded known ERP relationships and tables based on the access email.

Include at least:

```ts
export const KNOWN_TABLES = [
  {
    name: "Products",
    fullName: "olComun.dbo.Productos",
    description: "Product master table.",
  },
  {
    name: "Clients",
    fullName: "olComun.dbo.Clientes",
    description: "Client master table.",
  },
  {
    name: "Economic activity types",
    fullName: "olComun.dbo.TiposActividadesEconomicas",
    description:
      "Economic activity type catalog related to Clients through tactecoId.",
  },
  {
    name: "Invoice headers",
    fullName: "olVentas.dbo.maeFacturas",
    description: "Invoice header table.",
  },
  {
    name: "Invoice details",
    fullName: "olVentas.dbo.detFacturas",
    description: "Invoice detail/items table.",
  },
  {
    name: "Invoice payments",
    fullName: "olVentas.dbo.AbonosCXC",
    description: "Accounts receivable payment table.",
  },
  {
    name: "Accounts receivable detail",
    fullName: "olVentas.dbo.detCXC",
    description: "Intermediate table between invoices and payments.",
  },
  {
    name: "ERP query examples",
    fullName: "olComun.dbo.maeConsultas",
    description:
      "ERP-provided saved queries. Use this table to learn standardized query patterns.",
  },
  {
    name: "Table documentation",
    fullName: "olAdmin.dbo.NombresTablas",
    description: "ERP table names and descriptions.",
  },
  {
    name: "Column documentation",
    fullName: "olAdmin.dbo.CamposTablas",
    description: "ERP field/column names and descriptions.",
  },
];
```

Also include:

```ts
export const KNOWN_RELATIONSHIPS = [
  {
    from: "olVentas.dbo.maeFacturas.cliIdInvoiceTo",
    to: "olComun.dbo.Clientes.cliId",
    description: "Invoice header to client.",
  },
  {
    from: "olVentas.dbo.detFacturas.mfaId",
    to: "olVentas.dbo.maeFacturas.mfaId",
    description: "Invoice detail to invoice header.",
  },
  {
    from: "olVentas.dbo.detFacturas.proId",
    to: "olComun.dbo.Productos.proId",
    description: "Invoice detail to product.",
  },
  {
    from: "olComun.dbo.Clientes.tactecoId",
    to: "olComun.dbo.TiposActividadesEconomicas.tactecoId",
    description: "Client to economic activity type.",
  },
  {
    from: "olVentas.dbo.detCXC.mfaId",
    to: "olVentas.dbo.maeFacturas.mfaId",
    description: "Accounts receivable detail to invoice header.",
  },
  {
    from: "olVentas.dbo.detCXC.dccId",
    to: "olVentas.dbo.AbonosCXC.dccId",
    description: "Accounts receivable detail to payment.",
  },
];
```

Also include:

```ts
export const ALLOWED_DATABASES = ["olComun", "olVentas", "olAdmin"];
```

## SQL Safety Utility

Create `src/utils/sqlSafety.ts`.

Implement:

```ts
export function validateReadOnlySql(sql: string): {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
};
```

Validation rules:

Reject SQL if it contains any of these keywords:

```text
INSERT
UPDATE
DELETE
MERGE
DROP
ALTER
CREATE
TRUNCATE
EXEC
EXECUTE
GRANT
REVOKE
DENY
BACKUP
RESTORE
DBCC
sp_
xp_
OPENROWSET
OPENDATASOURCE
BULK
INTO
```

Only allow queries that start with:

```text
SELECT
WITH
DECLARE
```

Allow `DECLARE` only when it is followed by a read-only `SELECT` query.

Warnings:

- Warn if query uses ERP tables without `WITH (NOLOCK)`.
- Warn if query contains `SELECT *`.
- Warn if query contains non-SARGABLE date patterns:
  - `CAST(`
  - `CONVERT(`
  - `YEAR(`
  - `MONTH(`
  - `DAY(`
- Warn if no `TOP` is present in exploratory queries.
- Warn if query references known ERP tables without fully qualified names.
- Warn if query uses `LIKE '%something'`, because leading wildcards are not SARGABLE.

The validator should return useful messages so Cursor can fix the SQL.

## Required MCP Tools

Implement these six MCP tools exactly with these names:

```text
search_schema
get_table_info
get_relationships
get_column_meaning
generate_query
validate_query
```

## Tool 1: search_schema

Implement `search_schema`.

Purpose:

Search for tables, columns, ERP documentation, and saved ERP query examples related to a natural language phrase.

Example input:

```text
ventas este mes
```

Expected behavior:

Search in:

1. Known hardcoded schema hints.
2. `olAdmin.dbo.NombresTablas`
3. `olAdmin.dbo.CamposTablas`
4. `olComun.dbo.maeConsultas`
5. SQL Server metadata from `sys.tables`, `sys.columns`, and accessible databases.

Because table and column names may be in Spanish, search should handle terms like:

```text
ventas
venta
facturas
factura
cliente
clientes
producto
productos
abono
abonos
pagos
cobranza
cxc
```

Use parameterized queries for search terms.

The tool should return:

- Matching known tables
- Matching known relationships
- Matching documented tables
- Matching documented columns
- Matching saved ERP queries
- Recommended tables to inspect next
- Suggested next tool calls

For example, for:

```text
search_schema("ventas este mes")
```

It should likely recommend:

```text
get_table_info("olVentas.dbo.maeFacturas")
get_table_info("olVentas.dbo.detFacturas")
get_relationships("olVentas.dbo.maeFacturas")
get_column_meaning("fecha")
generate_query("ventas de este mes")
```

## Tool 2: get_table_info

Implement `get_table_info`.

Purpose:

Given a table name, partial table name, business name, or fully qualified table name, return detailed information about the table.

Example inputs:

```text
Facturas
olVentas.dbo.maeFacturas
Clientes
Productos
```

Expected behavior:

If the input is partial, search both documentation and SQL metadata to resolve possible table matches.

For each matching table, return:

- Fully qualified name
- Database
- Schema
- Table name
- Documentation from `olAdmin.dbo.NombresTablas`, if available
- Columns
- Column types
- Nullable information
- Max length
- Primary key info if available
- Index info if available
- Foreign keys if available
- Documentation from `olAdmin.dbo.CamposTablas`, if available
- Known relationships from `knownSchema.ts`
- Example saved queries from `olComun.dbo.maeConsultas` that mention the table

Use SQL Server catalog views such as:

```text
sys.tables
sys.columns
sys.types
sys.indexes
sys.index_columns
sys.foreign_keys
sys.foreign_key_columns
```

Because the SQL instance has multiple databases, the tool should inspect at least:

```text
olComun
olVentas
olAdmin
```

Do not allow user-provided raw SQL execution.

## Tool 3: get_relationships

Implement `get_relationships`.

Purpose:

Given a table name or business concept, return relationships between that table and other tables.

Example inputs:

```text
Facturas
olVentas.dbo.maeFacturas
Clientes
Productos
AbonosCXC
```

Expected behavior:

Return:

1. Known hardcoded relationships from `knownSchema.ts`.
2. SQL Server foreign keys from metadata, if available.
3. Inferred relationships from common column names.
4. Query examples from `olComun.dbo.maeConsultas` that show joins involving the table.

For:

```text
get_relationships("Facturas")
```

Include at minimum:

```text
olVentas.dbo.maeFacturas.cliIdInvoiceTo = olComun.dbo.Clientes.cliId
olVentas.dbo.detFacturas.mfaId = olVentas.dbo.maeFacturas.mfaId
olVentas.dbo.detCXC.mfaId = olVentas.dbo.maeFacturas.mfaId
```

For:

```text
get_relationships("Clientes")
```

Include at minimum:

```text
olVentas.dbo.maeFacturas.cliIdInvoiceTo = olComun.dbo.Clientes.cliId
olComun.dbo.Clientes.tactecoId = olComun.dbo.TiposActividadesEconomicas.tactecoId
```

The result should also include safe join examples using `WITH (NOLOCK)`.

Example:

```sql
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK)
INNER JOIN olComun.dbo.Clientes c WITH (NOLOCK)
    ON mf.cliIdInvoiceTo = c.cliId
```

## Tool 4: get_column_meaning

Implement `get_column_meaning`.

Purpose:

Given a column name, partial column name, or fully qualified column name, explain what it likely means.

Example inputs:

```text
fecha_factura
cliIdInvoiceTo
mfaId
proId
tactecoId
```

Expected behavior:

Search in:

1. `olAdmin.dbo.CamposTablas`
2. `olAdmin.dbo.NombresTablas`
3. SQL Server metadata
4. Known schema hints
5. Saved query examples in `olComun.dbo.maeConsultas`

Return:

- Matching columns
- Fully qualified table name
- Data type
- Documentation if available
- Related table if it appears to be a key
- Known relationships where the column appears
- Query examples where the column is used
- Confidence level:
  - high
  - medium
  - low

If the column is ambiguous, return multiple possibilities instead of guessing.

Examples:

- `cliIdInvoiceTo` should explain that it likely points from invoice headers to the client being invoiced.
- `mfaId` should explain that it identifies invoice headers and links invoice detail rows to invoice headers.
- `proId` should explain that it links invoice detail rows to products.
- `tactecoId` should explain that it links clients to economic activity types.

## Tool 5: generate_query

Implement `generate_query`.

Purpose:

Given a natural language request, produce a safe SQL Server query draft and the relevant schema context.

Example input:

```text
ventas de este mes por cliente
```

Important:

This MCP server does not need to call an external LLM. Cursor already has the LLM.

This tool should gather the best available schema context, relationships, documentation, and example queries, then produce either:

1. A best-effort SQL draft when the intent is clear.
2. A structured context package Cursor can use to improve the final SQL.

For common sales/invoice questions, generate a SQL draft using the known Brilo ERP relationships.

For “sales this month by client”, use:

```text
olVentas.dbo.maeFacturas
olComun.dbo.Clientes
```

Optional, if line-level detail is needed:

```text
olVentas.dbo.detFacturas
```

Known join:

```text
maeFacturas.cliIdInvoiceTo = Clientes.cliId
```

The generated query must:

- Use `WITH (NOLOCK)` on every table.
- Use fully qualified table names.
- Avoid `SELECT *`.
- Use SARGABLE date filters.
- Use declared variables for date ranges when useful.
- Include assumptions.
- Include warnings if the correct date, amount, status, or cancellation columns are uncertain.

Because exact column names may vary, the tool should inspect `maeFacturas` columns first and identify likely date and amount columns from metadata/documentation.

The generated query should be clearly marked as a draft if there is uncertainty.

Example query shape:

```sql
DECLARE @StartDate DATE = DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1);
DECLARE @EndDate DATE = DATEADD(MONTH, 1, @StartDate);

SELECT
    c.cliId AS ClientId,
    c.cliNombres AS ClientName,
    COUNT(DISTINCT mf.mfaId) AS InvoiceCount,
    SUM(mf.[LIKELY_AMOUNT_COLUMN]) AS TotalSales
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK)
INNER JOIN olComun.dbo.Clientes c WITH (NOLOCK)
    ON mf.cliIdInvoiceTo = c.cliId
WHERE mf.[LIKELY_DATE_COLUMN] >= @StartDate
  AND mf.[LIKELY_DATE_COLUMN] < @EndDate
GROUP BY
    c.cliId,
    c.cliNombres
ORDER BY
    TotalSales DESC;
```

If the exact amount/date columns are known from metadata or documentation, replace the placeholder columns.

If they are unknown, keep placeholders and clearly explain that the user must confirm them.

The response should include:

- Generated SQL
- Tables used
- Joins used
- Date filter logic
- Assumptions
- Potential columns considered
- Suggested validation steps
- Suggested next tool calls
- Result from `validate_query(sql)`

## Tool 6: validate_query

Implement `validate_query`.

Purpose:

Given a SQL query, validate that it is safe and follows the ERP rules.

Example input:

```sql
SELECT TOP (100)
    mf.mfaId
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK);
```

Expected behavior:

Return:

- `isValid`
- `errors`
- `warnings`
- `suggestions`
- `fixedSqlDraft`, if simple fixes are possible

Validation rules:

Reject if destructive keywords are found.

Reject if query does not start with:

```text
SELECT
WITH
DECLARE
```

Warn if:

- Missing `WITH (NOLOCK)` on ERP tables
- Uses `SELECT *`
- Uses non-SARGABLE date logic
- Uses `YEAR()`, `MONTH()`, `CAST()`, or `CONVERT()` in `WHERE`
- Does not use `TOP` for exploratory queries
- Uses unqualified table names
- Uses leading wildcard `LIKE '%...'`

For simple missing `WITH (NOLOCK)` cases, provide a suggested fixed version if it can be done safely.

Do not execute the query.

## MCP Server Behavior

Create `src/index.ts`.

Use the official MCP SDK pattern.

The MCP server should register all six tools:

```text
search_schema
get_table_info
get_relationships
get_column_meaning
generate_query
validate_query
```

The server should communicate over stdio so Cursor can run it locally.

Each tool should return clean text and structured JSON-like output that Cursor can read easily.

## Cursor MCP Configuration

After building the MCP server, provide an example Cursor MCP config.

Use a config similar to:

```json
{
  "mcpServers": {
    "brilo-sqlserver": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/absolute/path/to/brilo-sqlserver-mcp"
    }
  }
}
```

The actual path must be replaced with the local absolute path.

## Metadata Query Rules

When inspecting metadata across databases, use a safe allowlist.

Use:

```ts
const ALLOWED_DATABASES = ["olComun", "olVentas", "olAdmin"];
```

Since database names cannot be parameterized normally in SQL Server, never inject raw user input into database names.

Only use database names from the allowlist.

A metadata query can follow this pattern:

```sql
SELECT
    'olVentas' AS database_name,
    s.name AS schema_name,
    t.name AS table_name,
    c.name AS column_name,
    ty.name AS data_type,
    c.max_length,
    c.is_nullable
FROM olVentas.sys.tables t
INNER JOIN olVentas.sys.schemas s
    ON t.schema_id = s.schema_id
INNER JOIN olVentas.sys.columns c
    ON t.object_id = c.object_id
INNER JOIN olVentas.sys.types ty
    ON c.user_type_id = ty.user_type_id
WHERE t.name LIKE @Search
   OR c.name LIKE @Search;
```

Do not allow user-provided raw SQL execution.

## Documentation Table Strategy

Because the exact column names of these documentation tables are not guaranteed:

```text
olAdmin.dbo.NombresTablas
olAdmin.dbo.CamposTablas
olComun.dbo.maeConsultas
```

First inspect their metadata using `get_table_info`.

Then search likely text columns.

The server should be resilient and should not assume exact documentation column names until metadata is inspected.

Search likely fields containing:

```text
name
nombre
description
descripcion
tabla
table
campo
field
column
columna
query
consulta
sql
texto
observacion
comentario
```

## Search Strategy

For a phrase like:

```text
ventas este mes
```

The MCP server should expand search terms internally.

Use synonyms like:

```ts
const SYNONYMS = {
  ventas: [
    "ventas",
    "venta",
    "factura",
    "facturas",
    "maeFacturas",
    "detFacturas",
  ],
  clientes: ["cliente", "clientes", "cliId", "cliNombres", "cliIdInvoiceTo"],
  productos: ["producto", "productos", "proId", "Productos"],
  pagos: ["pago", "pagos", "abono", "abonos", "AbonosCXC", "CXC", "detCXC"],
  fechas: ["fecha", "date", "emision", "creacion", "factura"],
};
```

Use these expanded terms for searching documentation and metadata.

## Output Style

All MCP tool outputs should be clear and useful for a developer.

For example, `search_schema("ventas este mes")` should return something like:

```text
Relevant known tables:
- olVentas.dbo.maeFacturas: invoice headers
- olVentas.dbo.detFacturas: invoice detail/items
- olComun.dbo.Clientes: clients

Known joins:
- maeFacturas.cliIdInvoiceTo = Clientes.cliId
- detFacturas.mfaId = maeFacturas.mfaId

Documentation matches:
...

Saved ERP query examples:
...

Recommended next calls:
- get_table_info("olVentas.dbo.maeFacturas")
- get_table_info("olVentas.dbo.detFacturas")
- get_relationships("Facturas")
- generate_query("ventas de este mes por cliente")
```

## README Requirements

Create a `README.md` explaining:

1. What this MCP server does.
2. How to configure `.env`.
3. How to run it locally.
4. How to connect it to Cursor.
5. The six available tools.
6. The Brilo ERP SQL rules:
   - Fully qualified names
   - `WITH (NOLOCK)`
   - Read-only queries
   - SARGABLE filters
   - Avoid `SELECT *`
7. Example prompts to use in Cursor:

```text
Use the brilo-sqlserver MCP. Search the schema for ventas este mes.
```

```text
Use get_table_info for olVentas.dbo.maeFacturas and explain the most important columns.
```

```text
Use get_relationships for Facturas and generate a query for monthly sales by client.
```

```text
Generate a SQL Server query for sales this month by client. Validate it before showing it to me.
```

```text
Look at olComun.dbo.maeConsultas and find existing examples related to invoices.
```

## Security Requirements

The MCP server must be safe by default.

- Use a read-only SQL Server user.
- Never execute user-provided SQL except metadata-safe queries created by the server itself.
- The `validate_query` tool should not execute SQL.
- The `generate_query` tool should not execute SQL.
- Do not log database passwords.
- Do not expose `.env`.
- Do not commit `.env`.
- Add `.env` to `.gitignore`.
- Use query timeouts.
- Limit large metadata results.
- Use `TOP` in exploratory queries.
- Do not run heavy analytical queries from the MCP server.
- Do not execute destructive SQL under any circumstance.

## Performance Requirements

Because this is an ERP production database:

- Always use `WITH (NOLOCK)` when reading ERP tables.
- Use SARGABLE filters.
- Avoid full scans where possible.
- Limit result sizes.
- Use metadata queries first before touching large business tables.
- Prefer searching documentation tables and saved query examples before generating complex queries.
- Do not execute heavy reports from the MCP server.
- The MCP server is for schema understanding and SQL generation, not for running expensive production reports.

## Development Steps

Build the project in this order:

1. Initialize the Node.js TypeScript project.
2. Install dependencies.
3. Create `.env.example`.
4. Create `.gitignore`.
5. Create `src/db.ts`.
6. Create `src/utils/knownSchema.ts`.
7. Create `src/utils/normalize.ts`.
8. Create `src/utils/sqlSafety.ts`.
9. Implement `validate_query`.
10. Implement `search_schema`.
11. Implement `get_table_info`.
12. Implement `get_relationships`.
13. Implement `get_column_meaning`.
14. Implement `generate_query`.
15. Register all tools in `src/index.ts`.
16. Add local test commands.
17. Add Cursor MCP config example to the README.

## Final Expected Result

At the end, I should have a local MCP server that Cursor can use with these tools:

```text
search_schema("ventas este mes")
get_table_info("Facturas")
get_relationships("Facturas")
get_column_meaning("fecha_factura")
generate_query("ventas de este mes por cliente")
validate_query(sql)
```

The server should help Cursor understand the Brilo ERP database, generate safer SQL Server queries, follow the required `WITH (NOLOCK)` rule, use fully qualified table names, produce SARGABLE SQL, and use the ERP documentation/query tables as persistent database context.
