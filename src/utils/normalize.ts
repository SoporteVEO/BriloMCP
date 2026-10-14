import { SYNONYMS } from "./knownSchema.js";

export function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeText(value: string): string {
  return stripDiacritics(value.trim().toLowerCase());
}

export function tokenize(value: string): string[] {
  if (!value) return [];
  const normalized = normalizeText(value);
  return normalized
    .split(/[^a-z0-9_]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

export function expandSynonyms(value: string): string[] {
  const tokens = tokenize(value);
  const expanded = new Set<string>(tokens);

  for (const token of tokens) {
    for (const [, synonyms] of Object.entries(SYNONYMS)) {
      const normalizedSynonyms = synonyms.map(normalizeText);
      if (normalizedSynonyms.includes(token)) {
        for (const s of synonyms) {
          expanded.add(normalizeText(s));
        }
      }
    }
  }

  return Array.from(expanded);
}

export type ParsedTableName = {
  raw: string;
  database?: string;
  schema?: string;
  table: string;
  fullName: string;
};

export function parseTableName(input: string): ParsedTableName | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/^\[|\]$/g, "");
  const parts = trimmed.split(".").map((p) => p.trim().replace(/^\[|\]$/g, ""));

  if (parts.length === 3) {
    const [database, schema, table] = parts;
    if (!database || !schema || !table) return null;
    return {
      raw: input,
      database,
      schema,
      table,
      fullName: `${database}.${schema}.${table}`,
    };
  }

  if (parts.length === 2) {
    const [schema, table] = parts;
    if (!schema || !table) return null;
    return {
      raw: input,
      schema,
      table,
      fullName: `${schema}.${table}`,
    };
  }

  if (parts.length === 1) {
    const [table] = parts;
    if (!table) return null;
    return {
      raw: input,
      table,
      fullName: table,
    };
  }

  return null;
}

export function buildLikePattern(value: string): string {
  return `%${escapeLikeWildcards(value)}%`;
}

export function escapeLikeWildcards(value: string): string {
  return value.replace(/([%_\[])/g, "[$1]");
}

export function isPlausibleIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}
