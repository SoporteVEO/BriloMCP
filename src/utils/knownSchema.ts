export type KnownTable = {
  name: string;
  fullName: string;
  description: string;
};

export type KnownRelationship = {
  from: string;
  to: string;
  description: string;
};

export const KNOWN_TABLES: KnownTable[] = [
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

export const KNOWN_RELATIONSHIPS: KnownRelationship[] = [
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

export const ALLOWED_DATABASES = ["olComun", "olVentas", "olAdmin"] as const;

export type AllowedDatabase = (typeof ALLOWED_DATABASES)[number];

export const SYNONYMS: Record<string, string[]> = {
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

export const ERP_TABLES_FULL_NAMES = new Set(
  KNOWN_TABLES.map((t) => t.fullName.toLowerCase()),
);

export const ERP_TABLE_SHORT_NAMES = new Set(
  KNOWN_TABLES.map((t) => {
    const parts = t.fullName.split(".");
    return parts[parts.length - 1].toLowerCase();
  }),
);

export const DOCUMENTATION_TABLES = {
  tableNames: "olAdmin.dbo.NombresTablas",
  columnNames: "olAdmin.dbo.CamposTablas",
  savedQueries: "olComun.dbo.maeConsultas",
} as const;

export function findKnownTableByAnyName(
  input: string,
): KnownTable | undefined {
  if (!input) return undefined;
  const normalized = input.trim().toLowerCase();

  const exactFull = KNOWN_TABLES.find(
    (t) => t.fullName.toLowerCase() === normalized,
  );
  if (exactFull) return exactFull;

  const exactShort = KNOWN_TABLES.find((t) => {
    const parts = t.fullName.split(".");
    return parts[parts.length - 1].toLowerCase() === normalized;
  });
  if (exactShort) return exactShort;

  const exactBusiness = KNOWN_TABLES.find(
    (t) => t.name.toLowerCase() === normalized,
  );
  if (exactBusiness) return exactBusiness;

  return undefined;
}

export function findKnownTablesByPartial(input: string): KnownTable[] {
  if (!input) return [];
  const normalized = input.trim().toLowerCase();
  return KNOWN_TABLES.filter((t) => {
    return (
      t.fullName.toLowerCase().includes(normalized) ||
      t.name.toLowerCase().includes(normalized) ||
      t.description.toLowerCase().includes(normalized)
    );
  });
}

export function findKnownRelationshipsForTable(
  fullOrShortTableName: string,
): KnownRelationship[] {
  if (!fullOrShortTableName) return [];
  const normalized = fullOrShortTableName.trim().toLowerCase();
  return KNOWN_RELATIONSHIPS.filter((rel) => {
    const fromTable = rel.from.split(".").slice(0, 3).join(".").toLowerCase();
    const toTable = rel.to.split(".").slice(0, 3).join(".").toLowerCase();
    const fromShort = fromTable.split(".").pop() ?? "";
    const toShort = toTable.split(".").pop() ?? "";

    return (
      fromTable === normalized ||
      toTable === normalized ||
      fromShort === normalized ||
      toShort === normalized ||
      fromTable.includes(normalized) ||
      toTable.includes(normalized)
    );
  });
}
