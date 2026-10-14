export type ToolTextResponse = {
  text: string;
  data: Record<string, unknown>;
  isError?: boolean;
};

export function toMcpResult(response: ToolTextResponse) {
  return {
    content: [
      {
        type: "text" as const,
        text: response.text,
      },
    ],
    structuredContent: response.data,
    isError: response.isError ?? false,
  };
}

export function errorResponse(
  message: string,
  extra: Record<string, unknown> = {},
): ToolTextResponse {
  return {
    text: `Error: ${message}`,
    data: { error: message, ...extra },
    isError: true,
  };
}

export function formatList(label: string, items: string[]): string {
  if (items.length === 0) return `${label}: (none)`;
  return `${label}:\n${items.map((i) => `- ${i}`).join("\n")}`;
}

export function indent(value: string, spaces = 2): string {
  const pad = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}
