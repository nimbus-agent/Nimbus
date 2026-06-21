import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerWorkdayTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;

function captureTools(): Map<string, Handler> {
  const t = new Map<string, Handler>();
  registerWorkdayTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      t.set(n, h as Handler),
  );
  return t;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("workday connector tools", () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    process.env["WORKDAY_ACCESS_TOKEN"] = "tok";
    process.env["WORKDAY_TENANT_HOST"] = "https://wd5.workday.com";
    process.env["WORKDAY_TENANT"] = "acme";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "w1", descriptor: "Ada Lovelace" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["WORKDAY_ACCESS_TOKEN"];
    delete process.env["WORKDAY_TENANT_HOST"];
    delete process.env["WORKDAY_TENANT"];
  });

  it("registers exactly the three read tools", () => {
    expect([...captureTools().keys()].sort()).toEqual([
      "workday_get",
      "workday_list",
      "workday_search",
    ]);
  });

  it("workday_list returns the workers array", async () => {
    const out = payload(await (captureTools().get("workday_list") as Handler)({}));
    expect(out["data"]).toEqual([{ id: "w1", descriptor: "Ada Lovelace" }]);
  });

  it("throws when WORKDAY_ACCESS_TOKEN is unset", async () => {
    delete process.env["WORKDAY_ACCESS_TOKEN"];
    await expect((captureTools().get("workday_list") as Handler)({})).rejects.toThrow(
      /WORKDAY_ACCESS_TOKEN/,
    );
  });
});
