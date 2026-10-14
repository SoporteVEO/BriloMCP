import { z } from "zod";
import { DOCUMENTATION_TABLES } from "../utils/knownSchema.js";
import { expandSynonyms, normalizeText } from "../utils/normalize.js";
import { getTableColumns, type MetaColumn } from "../utils/metadata.js";
import { searchDocumentationTable } from "../utils/documentationSearch.js";
import { validateQueryWithFix } from "../utils/sqlSafety.js";
import { errorResponse, type ToolTextResponse } from "./toolResponse.js";

export const generateQueryInputShape = {
  request: z
    .string()
    .min(1, "request must not be empty")
    .describe(
      "Natural language description of the query, e.g. 'ventas de este mes por cliente'.",
    ),
};

export const generateQueryInputSchema = z.object(generateQueryInputShape);
export type GenerateQueryInput = z.infer<typeof generateQueryInputSchema>;

type Intent = "sales_by_client" | "sales_basic" | "client_lookup" | "product_lookup" | "payments_lookup" | "unknown";

function detectIntent(request: string): Intent {
  const text = normalizeText(request);
  const isSales = /(ventas?|factura|facturas|maefacturas|detfacturas)/.test(text);
  const isClient = /(cliente|clientes|cliid)/.test(text);
  const isProduct = /(producto|productos|proid)/.test(text);
  const isPayment = /(pago|pagos|abono|abonos|cxc)/.test(text);

  if (isSales && isClient) return "sales_by_client";
  if (isSales) return "sales_basic";
  if (isPayment) return "payments_lookup";
  if (isProduct) return "product_lookup";
  if (isClient) return "client_lookup";
  return "unknown";
}

function isThisMonth(text: string): boolean {
  const lc = normalizeText(text);
  return /\bes(te|ta)\s+mes\b/.test(lc) || /\bthis\s+month\b/.test(lc);
}

function isThisYear(text: string): boolean {
  const lc = normalizeText(text);
  return /\bes(te|ta)\s+a[nñ]o\b/.test(lc) || /\bthis\s+year\b/.test(lc);
}

function isToday(text: string): boolean {
  const lc = normalizeText(text);
  return /\bhoy\b/.test(lc) || /\btoday\b/.test(lc);
}

const DATE_NAME_HINTS = [
  "fechafactura",
  "fechaemision",
  "fechacreacion",
  "fechadocumento",
  "fechaproceso",
  "fecemi",
  "fec_factura",
  "fecha",
  "creacionfecha",
];

const AMOUNT_NAME_HINTS = [
  "totalfactura",
  "total",
  "totalneto",
  "totalbruto",
  "subtotal",
  "monto",
  "montototal",
  "valor",
  "totalvendido",
  "totalventa",
  "importe",
];

function pickColumnByHints(
  cols: MetaColumn[],
  hints: string[],
  prefer: { dataTypes?: string[] } = {},
): MetaColumn | null {
  if (cols.length === 0) return null;

  const filtered = prefer.dataTypes
    ? cols.filter((c) =>
        prefer.dataTypes!.some((t) => c.dataType.toLowerCase().includes(t)),
      )
    : cols;

  for (const hint of hints) {
    const exact = filtered.find((c) => c.column.toLowerCase() === hint);
    if (exact) return exact;
  }
  for (const hint of hints) {
    const partial = filtered.find((c) =>
      c.column.toLowerCase().includes(hint),
    );
    if (partial) return partial;
  }
  return null;
}

function buildSalesByClientQuery(args: {
  dateColumn: string | null;
  amountColumn: string | null;
  startVar: string;
  endVar: string;
  clientNameColumn: string | null;
}): string {
  const dateCol = args.dateColumn ?? "[LIKELY_DATE_COLUMN]";
  const amountCol = args.amountColumn ?? "[LIKELY_AMOUNT_COLUMN]";
  const clientNameCol = args.clientNameColumn ?? "cliNombres";

  return `DECLARE @StartDate DATE = ${args.startVar};
DECLARE @EndDate DATE = ${args.endVar};

SELECT
    c.cliId AS ClientId,
    c.${clientNameCol} AS ClientName,
    COUNT(DISTINCT mf.mfaId) AS InvoiceCount,
    SUM(mf.${amountCol}) AS TotalSales
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK)
INNER JOIN olComun.dbo.Clientes c WITH (NOLOCK)
    ON mf.cliIdInvoiceTo = c.cliId
WHERE mf.${dateCol} >= @StartDate
  AND mf.${dateCol} < @EndDate
GROUP BY
    c.cliId,
    c.${clientNameCol}
ORDER BY
    TotalSales DESC;`;
}

function buildSalesBasicQuery(args: {
  dateColumn: string | null;
  amountColumn: string | null;
  startVar: string;
  endVar: string;
}): string {
  const dateCol = args.dateColumn ?? "[LIKELY_DATE_COLUMN]";
  const amountCol = args.amountColumn ?? "[LIKELY_AMOUNT_COLUMN]";

  return `DECLARE @StartDate DATE = ${args.startVar};
DECLARE @EndDate DATE = ${args.endVar};

SELECT TOP (100)
    mf.mfaId,
    mf.cliIdInvoiceTo,
    mf.${dateCol} AS InvoiceDate,
    mf.${amountCol} AS Amount
FROM olVentas.dbo.maeFacturas mf WITH (NOLOCK)
WHERE mf.${dateCol} >= @StartDate
  AND mf.${dateCol} < @EndDate
ORDER BY
    mf.${dateCol} DESC;`;
}

function buildClientLookupQuery(): string {
  return `SELECT TOP (100)
    c.cliId,
    c.cliNombres,
    c.tactecoId
FROM olComun.dbo.Clientes c WITH (NOLOCK)
ORDER BY c.cliNombres;`;
}

function buildProductLookupQuery(): string {
  return `SELECT TOP (100)
    p.proId,
    p.[LIKELY_PRODUCT_NAME_COLUMN]
FROM olComun.dbo.Productos p WITH (NOLOCK)
ORDER BY p.proId;`;
}

function buildPaymentsLookupQuery(args: {
  startVar: string;
  endVar: string;
  paymentDateColumn: string | null;
  paymentAmountColumn: string | null;
}): string {
  const dateCol = args.paymentDateColumn ?? "[LIKELY_PAYMENT_DATE_COLUMN]";
  const amtCol = args.paymentAmountColumn ?? "[LIKELY_PAYMENT_AMOUNT_COLUMN]";
  return `DECLARE @StartDate DATE = ${args.startVar};
DECLARE @EndDate DATE = ${args.endVar};

SELECT TOP (100)
    a.dccId,
    a.${dateCol} AS PaymentDate,
    a.${amtCol} AS PaymentAmount,
    mf.mfaId AS InvoiceId,
    c.cliId AS ClientId,
    c.cliNombres AS ClientName
FROM olVentas.dbo.AbonosCXC a WITH (NOLOCK)
INNER JOIN olVentas.dbo.detCXC d WITH (NOLOCK)
    ON d.dccId = a.dccId
INNER JOIN olVentas.dbo.maeFacturas mf WITH (NOLOCK)
    ON mf.mfaId = d.mfaId
INNER JOIN olComun.dbo.Clientes c WITH (NOLOCK)
    ON c.cliId = mf.cliIdInvoiceTo
WHERE a.${dateCol} >= @StartDate
  AND a.${dateCol} < @EndDate
ORDER BY a.${dateCol} DESC;`;
}

async function getInvoiceColumns(): Promise<MetaColumn[]> {
  try {
    return await getTableColumns("olVentas", "dbo", "maeFacturas");
  } catch {
    return [];
  }
}

async function getClientColumns(): Promise<MetaColumn[]> {
  try {
    return await getTableColumns("olComun", "dbo", "Clientes");
  } catch {
    return [];
  }
}

async function getPaymentColumns(): Promise<MetaColumn[]> {
  try {
    return await getTableColumns("olVentas", "dbo", "AbonosCXC");
  } catch {
    return [];
  }
}

async function findRelevantSavedQueries(
  request: string,
): Promise<Record<string, unknown>[]> {
  const terms = expandSynonyms(request);
  if (terms.length === 0) return [];

  try {
    const rows = await searchDocumentationTable({
      fullTableName: DOCUMENTATION_TABLES.savedQueries,
      patterns: terms,
      topN: 5,
    });
    for (const r of rows) delete r.__matchedColumn;
    return rows;
  } catch {
    return [];
  }
}

export async function generateQueryHandler(
  input: GenerateQueryInput,
): Promise<ToolTextResponse> {
  const intent = detectIntent(input.request);
  const wantsThisMonth = isThisMonth(input.request);
  const wantsThisYear = isThisYear(input.request);
  const wantsToday = isToday(input.request);

  const startVar = wantsToday
    ? "CAST(GETDATE() AS DATE)"
    : wantsThisYear
      ? "DATEFROMPARTS(YEAR(GETDATE()), 1, 1)"
      : "DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)";
  const endVar = wantsToday
    ? "DATEADD(DAY, 1, CAST(GETDATE() AS DATE))"
    : wantsThisYear
      ? "DATEADD(YEAR, 1, DATEFROMPARTS(YEAR(GETDATE()), 1, 1))"
      : "DATEADD(MONTH, 1, @StartDate)";

  const assumptions: string[] = [];
  const warnings: string[] = [];
  const tablesUsed: string[] = [];
  const joinsUsed: string[] = [];

  let sql = "";

  if (intent === "sales_by_client" || intent === "sales_basic") {
    const invoiceCols = await getInvoiceColumns();
    const clientCols = intent === "sales_by_client" ? await getClientColumns() : [];

    const dateCol = pickColumnByHints(invoiceCols, DATE_NAME_HINTS, {
      dataTypes: ["date", "datetime", "datetime2", "smalldatetime"],
    });
    const amountCol = pickColumnByHints(invoiceCols, AMOUNT_NAME_HINTS, {
      dataTypes: ["money", "decimal", "numeric", "float", "real"],
    });

    if (!dateCol) {
      warnings.push(
        "Could not confidently detect the invoice date column on olVentas.dbo.maeFacturas. Placeholder [LIKELY_DATE_COLUMN] left in the query — confirm the actual column name (e.g. fechaFactura) before running.",
      );
    } else {
      assumptions.push(
        `Using mf.${dateCol.column} (${dateCol.dataType}) as the invoice date column.`,
      );
    }
    if (!amountCol) {
      warnings.push(
        "Could not confidently detect the invoice amount column on olVentas.dbo.maeFacturas. Placeholder [LIKELY_AMOUNT_COLUMN] left in the query — confirm the actual column name (e.g. totalFactura) before running.",
      );
    } else {
      assumptions.push(
        `Using mf.${amountCol.column} (${amountCol.dataType}) as the invoice amount column.`,
      );
    }

    if (intent === "sales_by_client") {
      const clientNameCol =
        clientCols.find((c) => c.column.toLowerCase() === "clinombres") ??
        pickColumnByHints(clientCols, ["clinombres", "nombres", "nombre", "razonsocial"]);
      if (!clientNameCol && clientCols.length > 0) {
        warnings.push(
          "Could not confidently detect a client name column on olComun.dbo.Clientes. Defaulted to cliNombres — confirm before running.",
        );
      } else if (clientNameCol) {
        assumptions.push(
          `Using c.${clientNameCol.column} as the client name column.`,
        );
      }

      sql = buildSalesByClientQuery({
        dateColumn: dateCol?.column ?? null,
        amountColumn: amountCol?.column ?? null,
        startVar,
        endVar,
        clientNameColumn: clientNameCol?.column ?? null,
      });
      tablesUsed.push("olVentas.dbo.maeFacturas", "olComun.dbo.Clientes");
      joinsUsed.push("maeFacturas.cliIdInvoiceTo = Clientes.cliId");
    } else {
      sql = buildSalesBasicQuery({
        dateColumn: dateCol?.column ?? null,
        amountColumn: amountCol?.column ?? null,
        startVar,
        endVar,
      });
      tablesUsed.push("olVentas.dbo.maeFacturas");
    }

    if (!wantsThisMonth && !wantsThisYear && !wantsToday) {
      assumptions.push(
        "Defaulted to 'this month' for the date range. Adjust @StartDate / @EndDate if a different period is needed.",
      );
    } else if (wantsThisMonth) {
      assumptions.push("Date range: current month [@StartDate, @EndDate).");
    } else if (wantsThisYear) {
      assumptions.push("Date range: current year [@StartDate, @EndDate).");
    } else if (wantsToday) {
      assumptions.push("Date range: today [@StartDate, @EndDate).");
    }
  } else if (intent === "payments_lookup") {
    const payCols = await getPaymentColumns();
    const dateCol = pickColumnByHints(payCols, [
      "fechaabono",
      "fechapago",
      "fechaaplicacion",
      "fecha",
      ...DATE_NAME_HINTS,
    ], {
      dataTypes: ["date", "datetime", "datetime2", "smalldatetime"],
    });
    const amountCol = pickColumnByHints(payCols, [
      "monto",
      "montoabono",
      "valorabono",
      ...AMOUNT_NAME_HINTS,
    ], {
      dataTypes: ["money", "decimal", "numeric", "float", "real"],
    });

    if (!dateCol) {
      warnings.push(
        "Could not confidently detect the payment date column on olVentas.dbo.AbonosCXC. Confirm before running.",
      );
    } else {
      assumptions.push(`Using a.${dateCol.column} as the payment date column.`);
    }
    if (!amountCol) {
      warnings.push(
        "Could not confidently detect the payment amount column on olVentas.dbo.AbonosCXC. Confirm before running.",
      );
    } else {
      assumptions.push(
        `Using a.${amountCol.column} as the payment amount column.`,
      );
    }

    sql = buildPaymentsLookupQuery({
      startVar,
      endVar,
      paymentDateColumn: dateCol?.column ?? null,
      paymentAmountColumn: amountCol?.column ?? null,
    });
    tablesUsed.push(
      "olVentas.dbo.AbonosCXC",
      "olVentas.dbo.detCXC",
      "olVentas.dbo.maeFacturas",
      "olComun.dbo.Clientes",
    );
    joinsUsed.push(
      "detCXC.dccId = AbonosCXC.dccId",
      "detCXC.mfaId = maeFacturas.mfaId",
      "Clientes.cliId = maeFacturas.cliIdInvoiceTo",
    );
  } else if (intent === "client_lookup") {
    sql = buildClientLookupQuery();
    tablesUsed.push("olComun.dbo.Clientes");
    assumptions.push("Returning a TOP 100 client preview ordered by name.");
  } else if (intent === "product_lookup") {
    sql = buildProductLookupQuery();
    tablesUsed.push("olComun.dbo.Productos");
    assumptions.push(
      "Returning a TOP 100 product preview. Confirm the product name column ([LIKELY_PRODUCT_NAME_COLUMN]) before running — try get_table_info('olComun.dbo.Productos').",
    );
    warnings.push(
      "Could not confidently determine the product name column without inspecting metadata.",
    );
  } else {
    const recommendedNextCalls = [
      `search_schema("${input.request}")`,
      `get_table_info("Facturas")`,
      `get_relationships("Facturas")`,
    ];
    return {
      text: [
        `Could not detect a known intent in "${input.request}".`,
        "",
        "Suggested next calls:",
        ...recommendedNextCalls.map((r) => `- ${r}`),
      ].join("\n"),
      data: {
        request: input.request,
        intent,
        recommendedNextCalls,
      },
    };
  }

  const validation = validateQueryWithFix(sql);
  if (validation.fixedSqlDraft) {
    sql = validation.fixedSqlDraft;
  }
  const finalValidation = validateQueryWithFix(sql);

  const savedQueries = await findRelevantSavedQueries(input.request);

  const isDraft = warnings.length > 0 || sql.includes("[LIKELY_");

  const lines: string[] = [];
  lines.push(`Generated query for: "${input.request}"`);
  lines.push(`Detected intent: ${intent}`);
  if (isDraft) lines.push("Status: DRAFT — confirm placeholders/assumptions before running.");
  lines.push("");
  lines.push("```sql");
  lines.push(sql);
  lines.push("```");
  lines.push("");

  lines.push("Tables used:");
  for (const t of tablesUsed) lines.push(`- ${t}`);
  lines.push("");

  if (joinsUsed.length > 0) {
    lines.push("Joins used:");
    for (const j of joinsUsed) lines.push(`- ${j}`);
    lines.push("");
  }

  if (assumptions.length > 0) {
    lines.push("Assumptions:");
    for (const a of assumptions) lines.push(`- ${a}`);
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push("validate_query result:");
  lines.push(`- isValid: ${finalValidation.isValid}`);
  if (finalValidation.errors.length > 0) {
    lines.push("- errors:");
    for (const e of finalValidation.errors) lines.push(`  - ${e}`);
  }
  if (finalValidation.warnings.length > 0) {
    lines.push("- warnings:");
    for (const w of finalValidation.warnings) lines.push(`  - ${w}`);
  }
  lines.push("");

  const recommendedNextCalls: string[] = [];
  for (const t of tablesUsed.slice(0, 3)) {
    recommendedNextCalls.push(`get_table_info("${t}")`);
  }
  if (tablesUsed.length > 0) {
    recommendedNextCalls.push(`get_relationships("${tablesUsed[0]}")`);
  }
  recommendedNextCalls.push(`validate_query(<the SQL above>)`);

  lines.push("Validation steps:");
  lines.push("- Confirm the [LIKELY_...] placeholder columns (if any) using get_column_meaning or get_table_info.");
  lines.push("- Run validate_query on the final SQL before executing.");
  lines.push("- Compare against saved ERP examples in olComun.dbo.maeConsultas if any are listed below.");
  lines.push("");

  lines.push("Recommended next calls:");
  for (const r of recommendedNextCalls) lines.push(`- ${r}`);

  if (savedQueries.length > 0) {
    lines.push("");
    lines.push(
      `Saved ERP query examples that may be relevant [${savedQueries.length}]:`,
    );
    for (const q of savedQueries.slice(0, 3)) {
      const preview = Object.entries(q)
        .filter(([, v]) => v != null)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${shortPreview(String(v))}`)
        .join(" | ");
      lines.push(`- ${preview}`);
    }
  }

  return {
    text: lines.join("\n").trim(),
    data: {
      request: input.request,
      intent,
      isDraft,
      sql,
      tablesUsed,
      joinsUsed,
      assumptions,
      warnings,
      dateRange: {
        startVar,
        endVar,
        period: wantsToday
          ? "today"
          : wantsThisYear
            ? "this_year"
            : "this_month",
      },
      validation: finalValidation,
      savedQueryExamples: savedQueries,
      recommendedNextCalls,
    },
  };
}

function shortPreview(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 100 ? `${cleaned.slice(0, 100)}...` : cleaned;
}

export function generateQueryErrorWrap(err: unknown): ToolTextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(`generate_query failed: ${message}`);
}
