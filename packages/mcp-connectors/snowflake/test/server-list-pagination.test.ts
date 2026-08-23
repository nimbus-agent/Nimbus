import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerSnowflakeTools } from "../src/server.ts";

// These cases assert the TOOL SURFACE, not the consent gate. Gateway mode is the shape they were
// written against: the connector registers everything and executor.ts (I2) is the gate. Reset on
// BOTH sides — bun test runs many files in ONE process.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

/**
 * Minimal server for the consent kit. In gateway mode it never reads the capability surface, but
 * it DOES register through `registerTool` — so this records into the same sink the read registrar
 * fills, or the connector's write tools would vanish from the captured surface.
 */
function consentFakeServer(sink: (name: string, handler: unknown) => void): never {
  return {
    server: { getClientCapabilities: () => undefined },
    registerTool: (name: string, _cfg: unknown, handler: unknown) => {
      sink(name, handler);
      return { disable: () => undefined };
    },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
  } as unknown as never;
}

type Handler = (args: unknown) => Promise<McpListResult>;

/** Capture the registered tool handlers without starting a real stdio transport. */
function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerSnowflakeTools(
    <T>(
      name: string,
      _desc: string,
      _schema: ZodObjectSchema<T>,
      handler: (args: T) => Promise<McpListResult>,
    ) => {
      tools.set(name, handler as Handler);
    },
    consentFakeServer((n, h) => tools.set(n, h as Handler)),
  );
  return tools;
}

/** Look up a captured handler, failing loudly if the tool was never registered. */
function tool(tools: Map<string, Handler>, name: string): Handler {
  const handler = tools.get(name);
  if (handler === undefined) {
    throw new Error(`tool not registered: ${name}`);
  }
  return handler;
}

// Snowflake SQL-API /api/v2/statements response shape: { resultSetMetaData: { rowType }, data: [[...]] }.
function statementsResponse(rows: string[][]): string {
  return JSON.stringify({
    resultSetMetaData: {
      rowType: [
        { name: "DATABASE_NAME" },
        { name: "SCHEMA_NAME" },
        { name: "TABLE_NAME" },
        { name: "ROW_COUNT" },
        { name: "LAST_ALTERED" },
      ],
    },
    data: rows,
  });
}

function parsePayload(res: McpListResult): { items: unknown[]; nextCursor: string | null } {
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as { items: unknown[]; nextCursor: string | null };
}

describe("snowflake_list pagination", () => {
  const origFetch = globalThis.fetch;
  let statements: string[] = [];

  beforeEach(() => {
    statements = [];
    process.env["SNOWFLAKE_ACCOUNT"] = "acme-xy12345";
    process.env["SNOWFLAKE_TOKEN"] = "tok";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("passes LIMIT/OFFSET from {limit,cursor} and returns nextCursor on a full page", async () => {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      statements.push(JSON.parse(init.body).statement as string);
      const rows = Array.from({ length: 2 }, (_v, i) => [
        "DB",
        "PUBLIC",
        `T${i}`,
        "1",
        "2026-01-01T00:00:00Z",
      ]);
      return new Response(statementsResponse(rows), { status: 200 });
    }) as unknown as typeof fetch;

    const tools = captureTools();
    const out = parsePayload(await tool(tools, "snowflake_list")({ limit: 2, cursor: null }));

    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe("2"); // a full page → more rows may exist
    expect(statements[0]).toContain("LIMIT 2");
    expect(statements[0]).toContain("OFFSET 0");
  });

  it("translates a cursor into OFFSET and returns nextCursor=null on a short final page", async () => {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      statements.push(JSON.parse(init.body).statement as string);
      return new Response(
        statementsResponse([["DB", "PUBLIC", "T0", "1", "2026-01-01T00:00:00Z"]]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const tools = captureTools();
    const out = parsePayload(await tool(tools, "snowflake_list")({ limit: 2, cursor: "4" }));

    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull(); // short page → exhausted
    expect(statements[0]).toContain("OFFSET 4");
  });

  it("defaults to limit 200 / offset 0 when neither is supplied", async () => {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      statements.push(JSON.parse(init.body).statement as string);
      return new Response(statementsResponse([]), { status: 200 });
    }) as unknown as typeof fetch;

    const tools = captureTools();
    const out = parsePayload(await tool(tools, "snowflake_list")({}));

    expect(out.nextCursor).toBeNull();
    expect(statements[0]).toContain("LIMIT 200");
    expect(statements[0]).toContain("OFFSET 0");
  });
});
