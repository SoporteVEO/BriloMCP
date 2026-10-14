# brilo-sqlserver-mcp

Read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the **Brilo ERP** SQL Server database. It gives Cursor (and remote agents) a persistent, structured understanding of the database so you do not have to explain the schema manually every time.

Runs in two modes from the same codebase:

- **stdio** — for Cursor local (`npm run dev`).
- **Streamable HTTP** — for remote agents, deployable to **Vercel** in one command, protected by a `Bearer` token.

The server is **safe by default**:

- The only tool that actually executes SQL is `run_query`, and every query it runs is first checked by the same Brilo ERP safety validator used by `validate_query`.
- All built-in metadata and documentation queries are built by the server itself and parameterized.
- It enforces fully qualified table names, `WITH (NOLOCK)`, SARGABLE filters, and read-only SQL.
- It refuses any destructive keyword (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `EXEC`, `EXECUTE`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `DBCC`, `sp_`, `xp_`, `OPENROWSET`, `OPENDATASOURCE`, `BULK`, `INTO`).
- Use a **read-only SQL login** on the SQL Server side as a second line of defense.

---

## What this server does

It exposes seven MCP tools that Cursor and remote agents can call while you write code or chat:

| Tool                  | Purpose                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_schema`       | Search known tables, SQL Server metadata, ERP documentation tables, and saved ERP queries for a natural language phrase.                               |
| `get_table_info`      | Return columns, types, primary key, indexes, foreign keys, ERP documentation, related saved queries, and known relationships for a table.              |
| `get_relationships`   | Return curated Brilo relationships, SQL Server foreign keys (in/out), inferred relationships by column name/type, and ready-to-use `WITH (NOLOCK)` joins. |
| `get_column_meaning`  | Return the most likely meaning of a column with confidence level, related table if it appears to be a key, ERP documentation, and saved query usage.   |
| `generate_query`      | Generate a safe SQL Server query draft following Brilo ERP rules; includes assumptions, warnings, and a `validate_query` result.                       |
| `validate_query`      | Validate a SQL string against Brilo ERP rules. Provides a `fixedSqlDraft` when a safe auto-fix is possible. Does not execute the query.                |
| `run_query`           | Validate a SQL string with the same safety rules and then **execute** it against the Brilo DB. Returns row data, with row cap and auto `WITH (NOLOCK)` fix. |

---

## Configure `.env`

Copy `.env.example` to `.env` and fill in the credentials of a **read-only** SQL Server user:

```env
SQLSERVER_HOST=your-sql-server-host
SQLSERVER_PORT=1433
SQLSERVER_USERNAME=readonly_user
SQLSERVER_PASSWORD=your_password

# Required for the HTTP transport (Vercel + `npm run dev:http`).
# Not used by stdio.
MCP_AUTH_TOKEN=change-me-to-a-long-random-string
```

Notes:

- The default database is `master`. The server uses fully qualified names (`olComun.dbo.X`, `olVentas.dbo.X`, `olAdmin.dbo.X`) for everything else, so you do not need a `SQLSERVER_DATABASE` variable.
- The connection uses `encrypt: true` and `trustServerCertificate: true`. Adjust `src/db.ts` if your server requires a different TLS configuration.
- `MCP_AUTH_TOKEN` must be at least 16 characters. Generate one with `openssl rand -hex 32`.
- `.env` is in `.gitignore`. **Never commit it.**

---

## Run it locally

Install dependencies (already done if you cloned the project after `npm install`):

```bash
npm install
```

### stdio (for Cursor local)

```bash
npm run dev          # tsx src/index.ts
# or:
npm run build && npm run start
```

The server speaks JSON-RPC over **stdio**. It is meant to be launched by an MCP client such as Cursor. `MCP_AUTH_TOKEN` is **not** required in this mode (Cursor spawns the process locally).

### Streamable HTTP (for remote agents)

```bash
# Requires MCP_AUTH_TOKEN in your .env (>= 16 chars)
npm run dev:http     # tsx src/httpServer.ts, listens on http://127.0.0.1:3333/mcp
# or compiled:
npm run build && npm run start:http
```

Health check:

```bash
curl http://127.0.0.1:3333/health
```

Call MCP:

```bash
curl -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

---

## Connect it to Cursor

Cursor reads MCP server definitions from `mcp.json`. Open Cursor → Settings → MCP, and add this server. The minimum config is:

```json
{
  "mcpServers": {
    "brilo-sqlserver": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "D:/absolute/path/to/brilo_mcp"
    }
  }
}
```

Replace `D:/absolute/path/to/brilo_mcp` with the absolute path to this folder on your machine.

If you prefer the compiled output (faster cold start), build first (`npm run build`) and use:

```json
{
  "mcpServers": {
    "brilo-sqlserver": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "D:/absolute/path/to/brilo_mcp"
    }
  }
}
```

You can also pass credentials inline via the `env` field instead of an `.env` file:

```json
{
  "mcpServers": {
    "brilo-sqlserver": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "D:/absolute/path/to/brilo_mcp",
      "env": {
        "SQLSERVER_HOST": "your-sql-server-host",
        "SQLSERVER_PORT": "1433",
        "SQLSERVER_USERNAME": "readonly_user",
        "SQLSERVER_PASSWORD": "your_password"
      }
    }
  }
}
```

After saving, restart Cursor (or toggle the server off/on) and confirm that the seven tools appear under **brilo-sqlserver** in the MCP panel.

---

## Deploy to Vercel

The repo is pre-wired for Vercel: `api/mcp.ts` is a Node serverless function that mounts the MCP Streamable HTTP transport in **stateless** mode, and `vercel.json` rewrites `/mcp` and `/health` onto it.

### 1. Install the CLI once

```bash
npm i -g vercel
vercel login
```

### 2. Link and configure environment variables

From the project root:

```bash
vercel link
vercel env add SQLSERVER_HOST
vercel env add SQLSERVER_PORT
vercel env add SQLSERVER_USERNAME
vercel env add SQLSERVER_PASSWORD
vercel env add MCP_AUTH_TOKEN      # Use `openssl rand -hex 32`, at least 16 chars
```

Add each one to **Production**, **Preview**, and **Development** as prompted.

### 3. Deploy

```bash
vercel          # preview deploy
vercel --prod   # production deploy
# or:
npm run deploy
```

That produces a URL like `https://brilo-mcp.vercel.app`. The MCP endpoint is at `/mcp`:

```bash
curl https://brilo-mcp.vercel.app/health
# {"ok":true,"name":"brilo-sqlserver-mcp","transport":"streamable-http","authentication":"bearer"}

curl -X POST https://brilo-mcp.vercel.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

### 4. Connect a remote agent

Point your MCP-capable agent at the Vercel URL as a Streamable HTTP server and set the auth header. In Cursor:

```json
{
  "mcpServers": {
    "brilo-sqlserver-remote": {
      "url": "https://brilo-mcp.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

Notes on the deployment:

- Runtime: **Node.js** (required — `mssql` is a native driver, it will not run on Vercel Edge).
- `maxDuration` is set to 60 s and `memory` to 512 MB in `vercel.json`; raise them if you run heavier queries.
- Transport is **stateless** (`sessionIdGenerator: undefined`), so every request opens a fresh MCP session. This matches the serverless model and keeps cold starts simple.
- A new SQL Server connection pool is created per cold start and reused across warm invocations.
- The agent **must** send `Authorization: Bearer <MCP_AUTH_TOKEN>` on every request. Missing/invalid tokens return `401` with `WWW-Authenticate: Bearer realm="brilo-mcp"`.

---

## Authentication

| Transport      | Auth required? | How                                                                                           |
| -------------- | -------------- | --------------------------------------------------------------------------------------------- |
| stdio          | No             | Cursor spawns the local process; trust boundary is the user's machine.                        |
| Streamable HTTP (local `npm run dev:http` and Vercel) | **Yes** | `Authorization: Bearer $MCP_AUTH_TOKEN` on every request. 401 otherwise.                      |

The HTTP server refuses to start if `MCP_AUTH_TOKEN` is unset or shorter than 16 characters, so the deployed MCP is never accidentally public. The token comparison is constant-time to prevent timing attacks.

To rotate the token: update `MCP_AUTH_TOKEN` in Vercel env (`vercel env rm MCP_AUTH_TOKEN` + `vercel env add MCP_AUTH_TOKEN`), redeploy (`vercel --prod`), and update all agents using the endpoint.

---

## The six tools, one by one

### 1. `search_schema`

Search known tables, SQL Server metadata (`sys.tables`, `sys.columns`), the ERP documentation tables (`olAdmin.dbo.NombresTablas`, `olAdmin.dbo.CamposTablas`), and saved ERP queries (`olComun.dbo.maeConsultas`).

Input:

- `query: string` — natural language phrase, e.g. `"ventas este mes"`.
- `topN?: number` — max results per category (default `10`, max `50`).

The tool also expands Spanish synonyms (`ventas` ↔ `factura` ↔ `maeFacturas` ↔ `detFacturas`, etc.) before searching.

### 2. `get_table_info`

Resolve a table by full name, schema-qualified name, business name, or short name and return:

- Database, schema, table, fully qualified name
- All columns with type, length, nullability, identity flag
- Primary key (from `sys.indexes`)
- Indexes
- Foreign keys (in and out)
- Curated `KNOWN_RELATIONSHIPS` matches
- Documentation rows from `olAdmin.dbo.NombresTablas` and `olAdmin.dbo.CamposTablas`
- Saved query examples from `olComun.dbo.maeConsultas` that mention the table

Input:

- `table: string` — e.g. `"Facturas"`, `"olVentas.dbo.maeFacturas"`.

### 3. `get_relationships`

Return relationships for a table, combining:

1. Curated `KNOWN_RELATIONSHIPS`
2. SQL Server foreign keys (out)
3. SQL Server foreign keys (in — other tables pointing to this one)
4. Inferred relationships by matching `*Id`-style column names and data types
5. Saved ERP queries that reference the table

The tool also prints ready-to-paste join examples with `WITH (NOLOCK)` and aliases.

Input:

- `table: string` — e.g. `"Facturas"`, `"olVentas.dbo.maeFacturas"`.

### 4. `get_column_meaning`

Resolve the meaning of a column. Returns multiple candidates when the name is ambiguous, each with a confidence level (`high` / `medium` / `low`) and reasoning.

Input:

- `column: string` — supports `cliIdInvoiceTo`, `mfaId`, `Facturas.fechaFactura`, or fully qualified `olVentas.dbo.maeFacturas.fechaFactura`.

### 5. `generate_query`

Produce a safe SQL Server query draft based on a natural language request and the schema context this server has gathered. The MCP server **does not call an external LLM** — Cursor’s LLM does that. This tool focuses on:

- Detecting intent (sales by client, sales basic, payments lookup, client lookup, product lookup).
- Building the date range (`this month`, `this year`, `today`).
- Inspecting `olVentas.dbo.maeFacturas` and `olVentas.dbo.AbonosCXC` to pick likely date and amount columns from real metadata.
- Always emitting `WITH (NOLOCK)`, fully qualified names, SARGABLE date filters, no `SELECT *`, and `TOP` for previews.
- Returning assumptions, warnings, the `validate_query` result, and recommended next calls.

Input:

- `request: string` — e.g. `"ventas de este mes por cliente"`.

The query is marked as a **draft** when it contains placeholders like `[LIKELY_DATE_COLUMN]`. Cursor will then know to confirm those columns with `get_column_meaning` or `get_table_info` before running.

### 6. `validate_query`

Static validator. Does **not** execute the query.

Input:

- `sql: string` — e.g. `"SELECT TOP (100) mf.mfaId FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK);"`.

Returns:

- `isValid: boolean`
- `errors: string[]`
- `warnings: string[]`
- `suggestions: string[]`
- `fixedSqlDraft?: string` — only when an auto-fix (e.g. adding missing `WITH (NOLOCK)`) keeps the query valid and clean.

### 7. `run_query`

Executes a read-only SQL query against the Brilo DB **after** the same safety validation as `validate_query`. If the query is destructive, uses unqualified ERP tables, has `INTO`, etc., it is **rejected before any SQL is sent to the server**.

Input:

- `sql: string` — must start with `SELECT` / `WITH` / `DECLARE`.
- `maxRows?: number` — row cap on the response payload (default `100`, hard max `1000`). The underlying query is executed as written; this only trims the response.
- `autoFixNoLock?: boolean` — when `true` (default), auto-apply the `WITH (NOLOCK)` fix suggested by the validator before running. Set to `false` to execute exactly what you sent.

Returns (structured):

- `rowCount: number` — total rows the DB returned
- `returnedRowCount: number` — after `maxRows` trim
- `truncated: boolean`
- `durationMs: number`
- `autoFixApplied: boolean`
- `sqlExecuted: string`
- `validation: { isValid, warnings, suggestions }`
- `rows: Record<string, unknown>[]`

Dates are serialized as ISO strings, `bigint` as string, binary buffers as `<binary N bytes>`.

Example input:

```json
{
  "sql": "SELECT TOP (10) mf.mfaId, mf.cliIdInvoiceTo, mf.fechaFactura FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK) WHERE mf.fechaFactura >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) ORDER BY mf.fechaFactura DESC",
  "maxRows": 10
}
```

---

## Brilo ERP SQL rules

These rules are encoded in `src/utils/sqlSafety.ts` and enforced by `validate_query` and `generate_query`.

1. **Fully qualified names** — every ERP table reference must be `database.schema.table`:

   ```sql
   olVentas.dbo.maeFacturas
   olComun.dbo.Clientes
   ```

2. **Always `WITH (NOLOCK)`** — every read against an ERP table must use `WITH (NOLOCK)`:

   ```sql
   FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK)
   INNER JOIN olComun.dbo.Clientes c WITH (NOLOCK)
       ON mf.cliIdInvoiceTo = c.cliId
   ```

3. **Read-only only** — `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `EXEC`, `EXECUTE`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `DBCC`, `sp_*`, `xp_*`, `OPENROWSET`, `OPENDATASOURCE`, `BULK`, and `INTO` are rejected.

4. **SARGABLE filters** — prefer:

   ```sql
   WHERE mf.fechaFactura >= @StartDate
     AND mf.fechaFactura < @EndDate
   ```

   Avoid `CAST(...)`, `CONVERT(...)`, `YEAR(...)`, `MONTH(...)`, `DAY(...)` in `WHERE`.

5. **Avoid `SELECT *`** — list the columns you actually need.

6. **Add `TOP` for previews**:

   ```sql
   SELECT TOP (100) mf.mfaId, mf.cliIdInvoiceTo
   FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK);
   ```

7. **Date ranges** use this template (`this month`):

   ```sql
   DECLARE @StartDate DATE = DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1);
   DECLARE @EndDate DATE = DATEADD(MONTH, 1, @StartDate);
   ```

---

## Example prompts to use in Cursor

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

---

## Project structure

```text
brilo_mcp/
├── package.json
├── tsconfig.json
├── vercel.json                     # Vercel config (functions, rewrites)
├── .env.example
├── .gitignore
├── README.md
├── api/
│   ├── mcp.ts                      # Vercel serverless function → delegates to src/httpHandler
│   └── tsconfig.json               # IDE-only config so api/ sees src/
└── src/
    ├── index.ts                    # stdio entry point (Cursor local)
    ├── httpServer.ts               # local HTTP dev server (`npm run dev:http`)
    ├── httpHandler.ts              # Streamable HTTP handler + Bearer auth (shared by Vercel + local)
    ├── mcpServer.ts                # createMcpServer() — shared tool registration
    ├── db.ts                       # mssql connection pool (lazy, reused)
    ├── loadEnv.ts                  # dotenv loader
    ├── tools/
    │   ├── searchSchema.ts
    │   ├── getTableInfo.ts
    │   ├── getRelationships.ts
    │   ├── getColumnMeaning.ts
    │   ├── generateQuery.ts
    │   ├── validateQuery.ts
    │   ├── runQuery.ts             # validate-then-execute read-only SQL (NEW)
    │   └── toolResponse.ts         # shared response/error formatting
    └── utils/
        ├── knownSchema.ts          # curated KNOWN_TABLES / KNOWN_RELATIONSHIPS / SYNONYMS
        ├── normalize.ts            # tokenizer, synonym expansion, name parsing
        ├── sqlSafety.ts            # validateReadOnlySql + tryFixMissingNoLock
        ├── metadata.ts             # sys.tables / sys.columns / sys.indexes / sys.foreign_keys helpers
        └── documentationSearch.ts  # resilient search across NombresTablas / CamposTablas / maeConsultas
```

---

## Security & performance

- Use a **read-only SQL Server user**. The server should never have write privileges on the production ERP.
- All metadata queries are **parameterized** (`@Pattern`, `@Schema`, `@Table`). Database names use a strict allowlist (`olComun`, `olVentas`, `olAdmin`) and are never injected from user input.
- All ERP-table reads use `WITH (NOLOCK)`.
- Connection pool is reused across tool calls.
- Documentation searches are limited with `TOP (n)` and the connection has a 30s `requestTimeout`.
- `validate_query` and `generate_query` **never execute SQL** — they only parse, validate, and assemble drafts.
- The server prints a single `console.error` line on stderr at startup, then stays silent. Database password is **never logged**.
