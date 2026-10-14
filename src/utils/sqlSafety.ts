import { ERP_TABLE_SHORT_NAMES, ERP_TABLES_FULL_NAMES } from "./knownSchema.js";

const DESTRUCTIVE_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "EXEC",
  "EXECUTE",
  "GRANT",
  "REVOKE",
  "DENY",
  "BACKUP",
  "RESTORE",
  "DBCC",
  "OPENROWSET",
  "OPENDATASOURCE",
  "BULK",
];

const FORBIDDEN_PREFIXES = ["sp_", "xp_"];

const ALLOWED_LEADING_KEYWORDS = ["SELECT", "WITH", "DECLARE"];

export type ValidateReadOnlyResult = {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
};

export type ValidateQueryResult = ValidateReadOnlyResult & {
  fixedSqlDraft?: string;
};

function stripStringsAndComments(sql: string): string {
  let stripped = sql.replace(/--[^\r\n]*/g, " ");
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, " ");
  stripped = stripped.replace(/'(?:[^']|'')*'/g, "''");
  stripped = stripped.replace(/"(?:[^"]|"")*"/g, '""');
  return stripped;
}

function getLeadingKeyword(sanitized: string): string | null {
  const trimmed = sanitized.trimStart();
  const match = trimmed.match(/^([A-Za-z_]+)/);
  if (!match) return null;
  return match[1].toUpperCase();
}

function containsKeywordAsToken(sanitized: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${keyword}\\b`, "i");
  return pattern.test(sanitized);
}

function containsForbiddenPrefix(sanitized: string, prefix: string): boolean {
  const escaped = prefix.replace(/[_]/g, "\\_");
  const pattern = new RegExp(`\\b${escaped}[A-Za-z0-9_]+`, "i");
  return pattern.test(sanitized);
}

function findIntoUsage(sanitized: string): boolean {
  const pattern = /\bINTO\b/i;
  if (!pattern.test(sanitized)) return false;
  const insertPattern = /\bINSERT\s+INTO\b/i;
  if (insertPattern.test(sanitized)) return true;
  const selectIntoPattern = /\bSELECT\b[\s\S]*?\bINTO\b\s+(?!@)/i;
  if (selectIntoPattern.test(sanitized)) return true;
  return false;
}

function findKnownTableMentions(sanitized: string): {
  fullName: string;
  matchIndex: number;
}[] {
  const mentions: { fullName: string; matchIndex: number }[] = [];
  for (const fullName of ERP_TABLES_FULL_NAMES) {
    const escaped = fullName.replace(/\./g, "\\.");
    const pattern = new RegExp(`\\b${escaped}\\b`, "gi");
    let match;
    while ((match = pattern.exec(sanitized)) !== null) {
      mentions.push({ fullName, matchIndex: match.index });
    }
  }
  return mentions;
}

function hasNoLockNearMention(
  sanitized: string,
  matchIndex: number,
  fullName: string,
): boolean {
  const after = sanitized.slice(matchIndex, matchIndex + fullName.length + 80);
  return /WITH\s*\(\s*NOLOCK\s*\)/i.test(after);
}

function findUnqualifiedKnownShortTables(sanitized: string): string[] {
  const found: string[] = [];
  for (const shortName of ERP_TABLE_SHORT_NAMES) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_\\.])${shortName}(?![A-Za-z0-9_])`,
      "gi",
    );
    let match;
    while ((match = pattern.exec(sanitized)) !== null) {
      const before = sanitized.slice(Math.max(0, match.index - 20), match.index);
      if (!/\.\s*$/.test(before)) {
        found.push(shortName);
        break;
      }
    }
  }
  return Array.from(new Set(found));
}

function hasSelectStar(sanitized: string): boolean {
  return /\bSELECT\s+\*/i.test(sanitized);
}

function hasTopOrLimit(sanitized: string): boolean {
  if (/\bTOP\s*\(/i.test(sanitized)) return true;
  if (/\bTOP\s+\d+/i.test(sanitized)) return true;
  if (/\bOFFSET\s+\d+\s+ROWS\s+FETCH\s+NEXT/i.test(sanitized)) return true;
  return false;
}

function hasNonSargableDateFunctions(sanitized: string): {
  flag: boolean;
  hits: string[];
} {
  const hits: string[] = [];
  const inWhere = extractWhereClauses(sanitized);
  for (const clause of inWhere) {
    if (/\bCAST\s*\(/i.test(clause)) hits.push("CAST(");
    if (/\bCONVERT\s*\(/i.test(clause)) hits.push("CONVERT(");
    if (/\bYEAR\s*\(/i.test(clause)) hits.push("YEAR(");
    if (/\bMONTH\s*\(/i.test(clause)) hits.push("MONTH(");
    if (/\bDAY\s*\(/i.test(clause)) hits.push("DAY(");
  }
  return { flag: hits.length > 0, hits: Array.from(new Set(hits)) };
}

function extractWhereClauses(sanitized: string): string[] {
  const clauses: string[] = [];
  const regex =
    /\bWHERE\b([\s\S]*?)(?=\b(GROUP\s+BY|HAVING|ORDER\s+BY|UNION|EXCEPT|INTERSECT|OPTION|FOR\s+JSON|FOR\s+XML)\b|;|$)/gi;
  let match;
  while ((match = regex.exec(sanitized)) !== null) {
    clauses.push(match[1] ?? "");
  }
  return clauses;
}

function hasLeadingWildcardLike(sanitized: string): boolean {
  return /\bLIKE\s+(N?'%)/i.test(sanitized);
}

function declareIsReadOnlyOnly(sanitized: string): {
  ok: boolean;
  reason?: string;
} {
  const upper = sanitized.toUpperCase();
  const declarationsEndPattern = /\b(SELECT|WITH)\b/;
  const idx = upper.search(declarationsEndPattern);
  if (idx < 0) {
    return {
      ok: false,
      reason: "DECLARE block is not followed by a SELECT or WITH statement.",
    };
  }
  return { ok: true };
}

export function validateReadOnlySql(sql: string): ValidateReadOnlyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  if (!sql || !sql.trim()) {
    errors.push("Empty SQL is not allowed.");
    return { isValid: false, errors, warnings, suggestions };
  }

  const sanitized = stripStringsAndComments(sql);

  const leading = getLeadingKeyword(sanitized);
  if (!leading || !ALLOWED_LEADING_KEYWORDS.includes(leading)) {
    errors.push(
      `Query must start with one of: ${ALLOWED_LEADING_KEYWORDS.join(", ")}. Got: ${leading ?? "(none)"}.`,
    );
  }

  for (const keyword of DESTRUCTIVE_KEYWORDS) {
    if (containsKeywordAsToken(sanitized, keyword)) {
      errors.push(`Forbidden keyword detected: ${keyword}.`);
    }
  }

  for (const prefix of FORBIDDEN_PREFIXES) {
    if (containsForbiddenPrefix(sanitized, prefix)) {
      errors.push(
        `Forbidden stored procedure prefix detected: ${prefix}. System procedures are not allowed.`,
      );
    }
  }

  if (findIntoUsage(sanitized)) {
    errors.push(
      "Forbidden INTO usage detected. SELECT ... INTO and INSERT INTO are not allowed.",
    );
  }

  if (leading === "DECLARE") {
    const declCheck = declareIsReadOnlyOnly(sanitized);
    if (!declCheck.ok) {
      errors.push(declCheck.reason ?? "Invalid DECLARE block.");
    }
  }

  const mentions = findKnownTableMentions(sanitized);
  for (const mention of mentions) {
    if (!hasNoLockNearMention(sanitized, mention.matchIndex, mention.fullName)) {
      warnings.push(
        `Missing WITH (NOLOCK) on ERP table ${mention.fullName}. Add WITH (NOLOCK) after the table reference.`,
      );
    }
  }

  if (hasSelectStar(sanitized)) {
    warnings.push(
      "Avoid SELECT *. List the columns you actually need to keep results predictable and small.",
    );
  }

  if (!hasTopOrLimit(sanitized)) {
    warnings.push(
      "No TOP / OFFSET FETCH detected. For exploratory queries, prefer SELECT TOP (100) ... to limit row count.",
    );
  }

  const sargableCheck = hasNonSargableDateFunctions(sanitized);
  if (sargableCheck.flag) {
    warnings.push(
      `Non-SARGABLE date function(s) used in WHERE clause: ${sargableCheck.hits.join(", ")}. Prefer comparing the column directly against a date range, e.g. col >= @StartDate AND col < @EndDate.`,
    );
  }

  if (hasLeadingWildcardLike(sanitized)) {
    warnings.push(
      "Leading wildcard LIKE '%...' is not SARGABLE and will force a scan. Prefer 'value%' or full-text indexing.",
    );
  }

  const unqualifiedHits = findUnqualifiedKnownShortTables(sanitized);
  if (unqualifiedHits.length > 0) {
    warnings.push(
      `Unqualified ERP table reference(s): ${unqualifiedHits.join(", ")}. Use fully qualified names like olVentas.dbo.maeFacturas.`,
    );
  }

  if (warnings.length > 0) {
    suggestions.push(
      "Add WITH (NOLOCK) on every ERP table reference, use fully qualified database.schema.table names, prefer SARGABLE date filters, and limit exploratory rows with TOP.",
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    suggestions,
  };
}

export function tryFixMissingNoLock(sql: string): string | undefined {
  let didFix = false;
  let fixed = sql;

  for (const fullName of ERP_TABLES_FULL_NAMES) {
    const escaped = fullName.replace(/\./g, "\\.");
    const pattern = new RegExp(
      `\\b(${escaped})(\\s+(?:AS\\s+)?[A-Za-z_][A-Za-z0-9_]*)?\\b(?!\\s*WITH\\s*\\(\\s*NOLOCK\\s*\\))`,
      "gi",
    );

    fixed = fixed.replace(pattern, (whole, table: string, alias?: string) => {
      const tail = alias ?? "";
      const replacement = `${table}${tail} WITH (NOLOCK)`;
      if (replacement !== whole) didFix = true;
      return replacement;
    });
  }

  return didFix ? fixed : undefined;
}

export function validateQueryWithFix(sql: string): ValidateQueryResult {
  const result = validateReadOnlySql(sql);

  let fixedSqlDraft: string | undefined;
  if (
    result.isValid &&
    result.warnings.some((w) => w.includes("Missing WITH (NOLOCK)"))
  ) {
    const candidate = tryFixMissingNoLock(sql);
    if (candidate) {
      const reValidated = validateReadOnlySql(candidate);
      if (
        reValidated.isValid &&
        reValidated.warnings.filter((w) => w.includes("Missing WITH (NOLOCK)"))
          .length === 0
      ) {
        fixedSqlDraft = candidate;
      }
    }
  }

  return { ...result, fixedSqlDraft };
}
