import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  searchSchemaErrorWrap,
  searchSchemaHandler,
  searchSchemaInputShape,
} from "./tools/searchSchema.js";
import {
  getTableInfoErrorWrap,
  getTableInfoHandler,
  getTableInfoInputShape,
} from "./tools/getTableInfo.js";
import {
  getRelationshipsErrorWrap,
  getRelationshipsHandler,
  getRelationshipsInputShape,
} from "./tools/getRelationships.js";
import {
  getColumnMeaningErrorWrap,
  getColumnMeaningHandler,
  getColumnMeaningInputShape,
} from "./tools/getColumnMeaning.js";
import {
  generateQueryErrorWrap,
  generateQueryHandler,
  generateQueryInputShape,
} from "./tools/generateQuery.js";
import {
  validateQueryHandler,
  validateQueryInputShape,
} from "./tools/validateQuery.js";
import {
  runQueryErrorWrap,
  runQueryHandler,
  runQueryInputShape,
} from "./tools/runQuery.js";
import { toMcpResult, type ToolTextResponse } from "./tools/toolResponse.js";

function asyncToolWrapper<T>(
  handler: (input: T) => Promise<ToolTextResponse>,
  errorWrap: (err: unknown) => ToolTextResponse,
) {
  return async (input: T) => {
    try {
      const response = await handler(input);
      return toMcpResult(response);
    } catch (err) {
      return toMcpResult(errorWrap(err));
    }
  };
}

function syncToolWrapper<T>(
  handler: (input: T) => Promise<ToolTextResponse>,
  toolName: string,
) {
  return async (input: T) => {
    try {
      const response = await handler(input);
      return toMcpResult(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toMcpResult({
        text: `Error: ${toolName} failed: ${message}`,
        data: { error: message },
        isError: true,
      });
    }
  };
}

export const SERVER_NAME = "brilo-sqlserver-mcp";
export const SERVER_VERSION = "1.1.0";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.registerTool(
    "search_schema",
    {
      title: "Search the Brilo ERP schema",
      description:
        "Search known tables, SQL Server metadata, ERP documentation tables (olAdmin.dbo.NombresTablas, olAdmin.dbo.CamposTablas), and saved ERP queries (olComun.dbo.maeConsultas) for a natural language phrase. Use this first to discover relevant tables/columns.",
      inputSchema: searchSchemaInputShape,
    },
    asyncToolWrapper(searchSchemaHandler, searchSchemaErrorWrap),
  );

  server.registerTool(
    "get_table_info",
    {
      title: "Get detailed table information",
      description:
        "Given a table name (full, partial, business name, or short), return columns, types, primary key, indexes, foreign keys, ERP documentation, related saved queries, and known relationships from the curated Brilo schema.",
      inputSchema: getTableInfoInputShape,
    },
    asyncToolWrapper(getTableInfoHandler, getTableInfoErrorWrap),
  );

  server.registerTool(
    "get_relationships",
    {
      title: "Get table relationships",
      description:
        "Given a table, return curated Brilo relationships, SQL Server foreign keys (in/out), inferred relationships by column name/type, related saved query examples, and ready-to-use WITH (NOLOCK) join examples.",
      inputSchema: getRelationshipsInputShape,
    },
    asyncToolWrapper(getRelationshipsHandler, getRelationshipsErrorWrap),
  );

  server.registerTool(
    "get_column_meaning",
    {
      title: "Get column meaning",
      description:
        "Given a column name (full, partial, or short), return the most likely meaning, related table if it appears to be a key, ERP documentation rows, known relationships, saved query usage, and a confidence level (high/medium/low). Returns multiple possibilities when ambiguous.",
      inputSchema: getColumnMeaningInputShape,
    },
    asyncToolWrapper(getColumnMeaningHandler, getColumnMeaningErrorWrap),
  );

  server.registerTool(
    "generate_query",
    {
      title: "Generate a safe SQL Server query draft",
      description:
        "Generate a read-only SQL Server query draft for a natural language request following Brilo ERP rules: WITH (NOLOCK), fully qualified names, SARGABLE date filters, no SELECT *, TOP for previews. Inspects metadata to pick likely date/amount columns and returns context, assumptions, warnings, and a validate_query result.",
      inputSchema: generateQueryInputShape,
    },
    asyncToolWrapper(generateQueryHandler, generateQueryErrorWrap),
  );

  server.registerTool(
    "validate_query",
    {
      title: "Validate a SQL Server query against ERP safety rules",
      description:
        "Validate a SQL string. Rejects destructive keywords, validates leading SELECT/WITH/DECLARE, warns on missing WITH (NOLOCK), unqualified ERP tables, SELECT *, non-SARGABLE date functions, missing TOP, and leading-wildcard LIKE. Provides a fixedSqlDraft when a safe auto-fix is possible. Does NOT execute the query.",
      inputSchema: validateQueryInputShape,
    },
    syncToolWrapper(validateQueryHandler, "validate_query"),
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a validated read-only SQL Server query against Brilo",
      description:
        "Execute a read-only SQL query against the Brilo ERP SQL Server database and return the result rows. The query is validated with the same Brilo ERP safety rules as validate_query before running — destructive keywords, unqualified tables, SELECT INTO, etc. are rejected and the query is never executed. Results are capped (default 100 rows, hard max 1000). Use generate_query / validate_query first if you are not sure the query is safe.",
      inputSchema: runQueryInputShape,
    },
    asyncToolWrapper(runQueryHandler, runQueryErrorWrap),
  );

  return server;
}
