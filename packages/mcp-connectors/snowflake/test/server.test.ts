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

function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerSnowflakeTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      tools.set(n, h as Handler),
    consentFakeServer((n, h) => tools.set(n, h as Handler)),
  );
  return tools;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
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

describe("snowflake server main tools", () => {
  const origFetch = globalThis.fetch;
  const origAccount = process.env["SNOWFLAKE_ACCOUNT"];
  const origToken = process.env["SNOWFLAKE_TOKEN"];
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    process.env["SNOWFLAKE_ACCOUNT"] = "acme-xy12345";
    process.env["SNOWFLAKE_TOKEN"] = "tok";
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      fetchCalls++;
      return new Response(
        statementsResponse([
          ["DB1", "PUBLIC", "USERS", "100", "2026-01-01T00:00:00Z"],
          ["DB1", "PUBLIC", "ORDERS", "500", "2026-01-02T00:00:00Z"],
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origAccount !== undefined) process.env["SNOWFLAKE_ACCOUNT"] = origAccount;
    else delete process.env["SNOWFLAKE_ACCOUNT"];

    if (origToken !== undefined) process.env["SNOWFLAKE_TOKEN"] = origToken;
    else delete process.env["SNOWFLAKE_TOKEN"];
  });

  it("snowflake_get returns a specific table when found", async () => {
    const handler = captureTools().get("snowflake_get") as Handler;
    const res = await handler({ id: "DB1.PUBLIC.USERS" });
    const out = payload(res);
    expect(out).toEqual({
      database_name: "DB1",
      schema_name: "PUBLIC",
      table_name: "USERS",
      row_count: 100,
      last_altered: "2026-01-01T00:00:00Z",
    });
    expect(fetchCalls).toBe(1);
  });

  it("snowflake_get rejects when the table is not found", async () => {
    const handler = captureTools().get("snowflake_get") as Handler;
    await expect(handler({ id: "DB1.PUBLIC.UNKNOWN" })).rejects.toThrow(
      /Snowflake table not found/,
    );
  });

  it("snowflake_search returns matched tables via filterSnowflakeTables", async () => {
    const handler = captureTools().get("snowflake_search") as Handler;
    const res = await handler({ query: "ORDER", limit: 10 });
    const out = payload(res);
    expect(Array.isArray(out["matches"])).toBe(true);
    expect(out["matches"]).toHaveLength(1);
    expect((out["matches"] as unknown[])[0]).toMatchObject({
      table_name: "ORDERS",
    });
  });

  it("throws when SNOWFLAKE_ACCOUNT is unset", async () => {
    delete process.env["SNOWFLAKE_ACCOUNT"];
    const handler = captureTools().get("snowflake_get") as Handler;
    await expect(handler({ id: "DB1.PUBLIC.USERS" })).rejects.toThrow(
      "SNOWFLAKE_ACCOUNT is not set",
    );
  });

  it("throws when SNOWFLAKE_TOKEN is unset", async () => {
    delete process.env["SNOWFLAKE_TOKEN"];
    const handler = captureTools().get("snowflake_get") as Handler;
    await expect(handler({ id: "DB1.PUBLIC.USERS" })).rejects.toThrow("SNOWFLAKE_TOKEN is not set");
  });

  it("throws when the snowflake api returns a non-OK status", async () => {
    globalThis.fetch = (async () => {
      return new Response("internal error from snowflake", { status: 500 });
    }) as unknown as typeof fetch;
    const handler = captureTools().get("snowflake_get") as Handler;
    await expect(handler({ id: "DB1.PUBLIC.USERS" })).rejects.toThrow(/Snowflake 500:/);
  });
});
