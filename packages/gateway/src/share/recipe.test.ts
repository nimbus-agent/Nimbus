// packages/gateway/src/share/recipe.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { writeToolCallLog } from "../db/tool-call-log.ts";
import { TOOL_CALL_LOG_V29_SCHEMA_SQL } from "../index/tool-call-log-v29-sql.ts";
import { TOOL_CALL_PARAMS_V42_SQL } from "../index/tool-call-params-v42-sql.ts";
import { buildRecipeFromSession } from "./recipe.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.exec(TOOL_CALL_LOG_V29_SCHEMA_SQL);
  d.exec(TOOL_CALL_PARAMS_V42_SQL);
  return d;
}

describe("buildRecipeFromSession — ordered steps", () => {
  test("steps follow called_at ascending and carry tool/service/params/status", () => {
    const d = db();
    writeToolCallLog(d, {
      sessionId: "s1",
      toolId: "slack_search",
      service: "slack",
      calledAt: 200,
      durationMs: 1,
      resultEnvelope: "{}",
      status: "ok",
      params: { q: "incident" },
    });
    writeToolCallLog(d, {
      sessionId: "s1",
      toolId: "gmail_list",
      service: "gmail",
      calledAt: 100,
      durationMs: 1,
      resultEnvelope: "{}",
      status: "ok",
      params: { label: "INBOX" },
    });
    const recipe = buildRecipeFromSession(d, "s1", () => 999);
    expect(recipe.recipeVersion).toBe(1);
    expect(recipe.sourceSessionId).toBe("s1");
    expect(recipe.generatedAt).toBe(999);
    expect(recipe.steps.map((s) => s.tool)).toEqual(["gmail_list", "slack_search"]); // 100 before 200
    expect(recipe.steps[0]?.service).toBe("gmail");
    expect((recipe.steps[0]?.params as { label?: string } | undefined)?.label).toBe("INBOX");
    expect(recipe.steps[0]?.status).toBe("ok");
    expect(recipe.steps[0]?.stepId).toBe("step-1");
    expect(recipe.steps[1]?.stepId).toBe("step-2");
    expect(recipe.graphTraversals).toEqual([]);
  });

  test("deterministic — identical rows produce identical recipes", () => {
    const seed = (d: Database) => {
      writeToolCallLog(d, {
        sessionId: "s1",
        toolId: "a_list",
        service: "a",
        calledAt: 1,
        durationMs: 1,
        resultEnvelope: "{}",
        status: "ok",
        params: { x: 1 },
      });
      writeToolCallLog(d, {
        sessionId: "s1",
        toolId: "b_get",
        service: "b",
        calledAt: 2,
        durationMs: 1,
        resultEnvelope: "{}",
        status: "ok",
        params: { y: 2 },
      });
    };
    const d1 = db();
    seed(d1);
    const d2 = db();
    seed(d2);
    expect(JSON.stringify(buildRecipeFromSession(d1, "s1", () => 5))).toBe(
      JSON.stringify(buildRecipeFromSession(d2, "s1", () => 5)),
    );
  });

  test("empty session → empty steps", () => {
    expect(buildRecipeFromSession(db(), "nope", () => 1).steps).toEqual([]);
  });
});

describe("buildRecipeFromSession — advisory dependsOn", () => {
  function chain(d: Database, aResult: string, bParams: unknown): void {
    writeToolCallLog(d, {
      sessionId: "s1",
      toolId: "a_get",
      service: "a",
      calledAt: 1,
      durationMs: 1,
      resultEnvelope: aResult,
      status: "ok",
      params: {},
    });
    writeToolCallLog(d, {
      sessionId: "s1",
      toolId: "b_get",
      service: "b",
      calledAt: 2,
      durationMs: 1,
      resultEnvelope: "{}",
      status: "ok",
      params: bParams,
    });
  }

  test("identifier value in B.params found in A.result → edge B→A", () => {
    const d = db();
    chain(d, JSON.stringify({ id: "issue-9f2a8c71" }), { ref: "issue-9f2a8c71" });
    const recipe = buildRecipeFromSession(d, "s1", () => 1);
    expect(recipe.steps[1]?.dependsOn).toEqual(["step-1"]);
  });

  test("trivial scalar collisions create NO edge", () => {
    const d = db();
    chain(d, JSON.stringify({ ok: true, count: 10, tag: "ab" }), {
      ok: true,
      count: 10,
      tag: "ab",
    });
    expect(buildRecipeFromSession(d, "s1", () => 1).steps[1]?.dependsOn).toEqual([]);
  });

  test("nested leaf identifier matches; whole-subtree does not", () => {
    const d = db();
    // Use "ref" (not "key") — "key" matches SENSITIVE_KEY and would be redacted to
    // "[REDACTED]", defeating the value-match. The test exercises nesting depth, not
    // the param-key name.
    chain(d, JSON.stringify({ items: [{ ref: "abcd1234efgh" }] }), {
      filter: { nested: { ref: "abcd1234efgh" } },
    });
    expect(buildRecipeFromSession(d, "s1", () => 1).steps[1]?.dependsOn).toEqual(["step-1"]);
  });

  test("no false edge when values differ", () => {
    const d = db();
    chain(d, JSON.stringify({ id: "issue-aaaaaaaa" }), { ref: "issue-bbbbbbbb" });
    expect(buildRecipeFromSession(d, "s1", () => 1).steps[1]?.dependsOn).toEqual([]);
  });
});
