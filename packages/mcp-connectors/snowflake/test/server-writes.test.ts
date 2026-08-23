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

describe("snowflake write tools", () => {
  const origFetch = globalThis.fetch;
  let bodies: unknown[] = [];

  beforeEach(() => {
    bodies = [];
    process.env["SNOWFLAKE_ACCOUNT"] = "acme-xy12345";
    process.env["SNOWFLAKE_TOKEN"] = "tok";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ statementHandle: "h1" }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("snowflake_tag_set issues ALTER ... SET TAG with escaped literal", async () => {
    const out = payload(
      await (captureTools().get("snowflake_tag_set") as Handler)({
        object: "DB.SCHEMA.T",
        tag: "GOVERNANCE.PII",
        value: "yes'no",
      }),
    );
    expect(out["status"]).toBe("ok");
    expect((bodies[0] as { statement: string }).statement).toContain("SET TAG");
    expect((bodies[0] as { statement: string }).statement).toContain("'yes''no'");
  });

  it("snowflake_tag_set with no value issues UNSET TAG", async () => {
    await (captureTools().get("snowflake_tag_set") as Handler)({ object: "DB.S.T", tag: "T1" });
    expect((bodies[0] as { statement: string }).statement).toContain("UNSET TAG");
  });

  it("snowflake_comment_set issues COMMENT ON TABLE with escaped literal", async () => {
    const out = payload(
      await (captureTools().get("snowflake_comment_set") as Handler)({
        object: "DB.SCHEMA.T",
        comment: "it's fine",
      }),
    );
    expect(out["status"]).toBe("ok");
    expect((bodies[0] as { statement: string }).statement).toContain("COMMENT ON TABLE");
    expect((bodies[0] as { statement: string }).statement).toContain("'it''s fine'");
  });

  it("accepts a double-quoted identifier part", async () => {
    const out = payload(
      await (captureTools().get("snowflake_comment_set") as Handler)({
        object: `DB.SCHEMA."My-Table"`,
        comment: "c",
      }),
    );
    expect(out["status"]).toBe("ok");
    expect((bodies[0] as { statement: string }).statement).toContain(`DB.SCHEMA."My-Table"`);
  });

  it("rejects an unsafe identifier", async () => {
    await expect(
      (captureTools().get("snowflake_comment_set") as Handler)({
        object: "T; DROP TABLE x",
        comment: "c",
      }),
    ).rejects.toThrow(/identifier/i);
  });

  it("rejects an unsafe tag identifier", async () => {
    await expect(
      (captureTools().get("snowflake_tag_set") as Handler)({
        object: "DB.S.T",
        tag: 'BAD"QUOTE',
        value: "v",
      }),
    ).rejects.toThrow(/identifier/i);
  });
});
