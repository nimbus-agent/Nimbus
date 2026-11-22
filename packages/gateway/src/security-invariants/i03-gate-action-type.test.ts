import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I3 — HITL gate consults action.type (not payload.mcpToolId)", () => {
  test("executor.gate looks up HITL_REQUIRED.has(action.type), not the routing-only mcpToolId", async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toMatch(/HITL_REQUIRED\.has\(action\.type\)/);
    expect(src).not.toMatch(/HITL_REQUIRED\.has\(\s*action\.payload/);
    expect(src).not.toMatch(/HITL_REQUIRED\.has\(\s*resolvedToolId\s*\)/);
  });

  test("dispatcher uses action.type when payload.mcpToolId is absent", async () => {
    const src = await read("packages/gateway/src/connectors/registry.ts");
    expect(src).toMatch(/mcpToolId/);
    expect(src).toMatch(/action\.type/);
  });
});
