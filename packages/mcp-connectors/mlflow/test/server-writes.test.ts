import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerMlflowTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;

function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerMlflowTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      tools.set(n, h as Handler),
  );
  return tools;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("mlflow write tools", () => {
  const origFetch = globalThis.fetch;
  let bodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    bodies = [];
    process.env["MLFLOW_HOST"] = "https://mlflow.example.com";
    process.env["MLFLOW_TOKEN"] = "tok";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ model_version: { current_stage: "Production" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["MLFLOW_HOST"];
    delete process.env["MLFLOW_TOKEN"];
  });

  it("mlflow_model_promote sends stage=Production and archive_existing_versions=true by default", async () => {
    const out = payload(
      await (captureTools().get("mlflow_model_promote") as Handler)({
        name: "ranker",
        version: "4",
      }),
    );
    expect(out["status"]).toBe("ok");
    expect(bodies[0]).toEqual({
      name: "ranker",
      version: "4",
      stage: "Production",
      archive_existing_versions: true,
    });
  });

  it("mlflow_model_promote honors archiveExisting:false override", async () => {
    await (captureTools().get("mlflow_model_promote") as Handler)({
      name: "ranker",
      version: "4",
      archiveExisting: false,
    });
    expect(bodies[0]?.["archive_existing_versions"]).toBe(false);
  });

  it("mlflow_model_transition_stage sends the caller stage", async () => {
    await (captureTools().get("mlflow_model_transition_stage") as Handler)({
      name: "ranker",
      version: "4",
      stage: "Staging",
    });
    expect(bodies[0]?.["stage"]).toBe("Staging");
    expect(bodies[0]?.["archive_existing_versions"]).toBe(false);
  });

  it("mlflow_model_promote throws on a non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(
      (captureTools().get("mlflow_model_promote") as Handler)({ name: "ranker", version: "4" }),
    ).rejects.toThrow(/403/);
  });
});
