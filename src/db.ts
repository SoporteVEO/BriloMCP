import sql from "mssql";

const CONNECTION_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

let poolPromise: Promise<sql.ConnectionPool> | null = null;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    const allEnvVars = [
      "SQLSERVER_HOST",
      "SQLSERVER_PORT",
      "SQLSERVER_USERNAME",
      "SQLSERVER_PASSWORD",
    ];
    const present = allEnvVars
      .map((k) => `${k}=${process.env[k] ? "(set)" : "(missing)"}`)
      .join(", ");
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Current state: ${present}. ` +
        `Make sure your .env is at the project root (D:/veo/brilo_mcp/.env) ` +
        `or pass credentials via the MCP "env" block in mcp.json.`,
    );
  }
  return value;
}

function buildConfig(): sql.config {
  const host = getRequiredEnv("SQLSERVER_HOST");
  const portRaw = process.env.SQLSERVER_PORT?.trim();
  const port = portRaw ? Number.parseInt(portRaw, 10) : 1433;
  const user = getRequiredEnv("SQLSERVER_USERNAME");
  const password = getRequiredEnv("SQLSERVER_PASSWORD");

  if (Number.isNaN(port)) {
    throw new Error(
      `SQLSERVER_PORT is not a valid number: '${portRaw}'. Please configure it in your .env file.`,
    );
  }

  return {
    server: host,
    port,
    user,
    password,
    database: "master",
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30_000,
    },
    options: {
      encrypt: true,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
  };
}

export async function getPool(): Promise<sql.ConnectionPool> {
  if (poolPromise) {
    try {
      const pool = await poolPromise;
      if (pool.connected) {
        return pool;
      }
    } catch {
      poolPromise = null;
    }
  }

  if (!poolPromise) {
    const config = buildConfig();
    const pool = new sql.ConnectionPool(config);

    pool.on("error", (err) => {
      console.error("[brilo-sqlserver-mcp] Connection pool error:", err.message);
    });

    poolPromise = pool.connect().catch((err) => {
      poolPromise = null;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to connect to SQL Server (${config.server}:${config.port}): ${message}`,
      );
    });
  }

  return poolPromise;
}

export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  try {
    const pool = await poolPromise;
    await pool.close();
  } catch {
    /* swallow close errors */
  } finally {
    poolPromise = null;
  }
}

export type SqlParam = {
  name: string;
  type: sql.ISqlType | (() => sql.ISqlType);
  value: unknown;
};

export async function runQuery<T = Record<string, unknown>>(
  query: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const pool = await getPool();
  const request = pool.request();

  for (const param of params) {
    request.input(param.name, param.type, param.value);
  }

  const result = await request.query<T>(query);
  return result.recordset ?? [];
}

export const sqlTypes = sql;
