// packages/gateway/src/share/recipe-runner.test.ts
import { describe, expect, test } from "bun:test";
import { isReadOnlyToolId } from "./read-tool-registry.ts";
import type { RecipeStep } from "./recipe.ts";
import {
  MAX_REPLAY_STEPS,
  replayRecipe,
  replayShare,
  stepsFromShare,
  type ToolRunOutcome,
} from "./recipe-runner.ts";
import type { ShareFile } from "./share-format.ts";

function shareWith(
  body: Partial<ShareFile["body"]> & { kind: "transcript" | "recipe" },
): ShareFile {
  return {
    format: "nimbus-share/v1",
    contentHash: "x",
    body: {
      sessionId: "s1",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: "h", pubkey: "P" },
      ...body,
    },
    sig: { alg: "ed25519", pubkey: "P", signature: "S" },
    forwarding: { hops: 0, chain: [] },
  };
}

describe("stepsFromShare", () => {
  test("recipe share → uses body.recipe.steps in order", () => {
    const share = shareWith({
      kind: "recipe",
      recipe: {
        recipeVersion: 1,
        sourceSessionId: "s1",
        generatedAt: 1,
        graphTraversals: [],
        steps: [
          {
            stepId: "step-1",
            tool: "gmail_list",
            service: "gmail",
            params: { a: 1 },
            status: "ok",
            dependsOn: [],
          },
          {
            stepId: "step-2",
            tool: "slack_search",
            service: "slack",
            params: {},
            status: "ok",
            dependsOn: [],
          },
        ],
      },
    });
    const { sourceSessionId, steps } = stepsFromShare(share);
    expect(sourceSessionId).toBe("s1");
    expect(steps.map((s) => s.tool)).toEqual(["gmail_list", "slack_search"]);
  });

  test("transcript share → synthesizes steps from body.toolCalls (ordered, step-N ids)", () => {
    const share = shareWith({
      kind: "transcript",
      toolCalls: [
        { toolId: "gmail_get", service: "gmail", params: { id: "1" }, status: "ok" },
        { toolId: "file_delete", service: "fs", params: { path: "/x" }, status: "ok" },
      ],
    });
    const { steps } = stepsFromShare(share);
    expect(steps.map((s) => s.stepId)).toEqual(["step-1", "step-2"]);
    expect(steps[1]?.tool).toBe("file_delete");
    expect(steps[1]?.dependsOn).toEqual([]);
  });

  test("malformed / missing recipe → empty steps (fail-safe)", () => {
    expect(stepsFromShare(shareWith({ kind: "recipe", recipe: undefined })).steps).toEqual([]);
    expect(stepsFromShare(shareWith({ kind: "recipe", recipe: { nope: true } })).steps).toEqual([]);
    expect(stepsFromShare(shareWith({ kind: "transcript" })).steps).toEqual([]);
  });

  test("transcript share with non-array toolCalls → empty steps, no throw", () => {
    const share = {
      ...shareWith({ kind: "transcript" }),
      body: { ...shareWith({ kind: "transcript" }).body, toolCalls: "not-an-array" },
    } as unknown as ShareFile;
    expect(() => stepsFromShare(share)).not.toThrow();
    expect(stepsFromShare(share).steps).toEqual([]);
  });

  test("transcript share with mixed valid/malformed toolCalls → only valid elements, sequential ids", () => {
    const share = {
      ...shareWith({ kind: "transcript" }),
      body: {
        ...shareWith({ kind: "transcript" }).body,
        toolCalls: [
          { toolId: "gmail_get", service: "gmail", params: { id: "1" }, status: "ok" },
          { service: "fs", params: {}, status: "ok" }, // missing toolId
          { toolId: "slack_search", service: "slack", params: {}, status: "ok" },
        ],
      },
    } as unknown as ShareFile;
    const { steps } = stepsFromShare(share);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.stepId).toBe("step-1");
    expect(steps[0]?.tool).toBe("gmail_get");
    expect(steps[1]?.stepId).toBe("step-2");
    expect(steps[1]?.tool).toBe("slack_search");
  });
});

function step(tool: string, status = "ok", params: unknown = {}): RecipeStep {
  return {
    stepId: `step-x`,
    tool,
    service: tool.split("_")[0] ?? "svc",
    params,
    status,
    dependsOn: [],
  };
}

describe("replayRecipe — per-step classification", () => {
  const readOnly = (t: string) => t.endsWith("_get") || t.endsWith("_list");

  test("non-read tool → skipped-non-read, executor NEVER called", async () => {
    let calls = 0;
    const report = await replayRecipe("s1", [step("file_delete")], {
      isReadOnly: readOnly,
      run: async () => {
        calls++;
        return { kind: "ran", ok: true };
      },
    });
    expect(report.steps[0]?.status).toBe("skipped-non-read");
    expect(calls).toBe(0);
  });

  test("unavailable → missing-connector (detail = service)", async () => {
    const report = await replayRecipe("s1", [step("gmail_get")], {
      isReadOnly: readOnly,
      run: async () => ({ kind: "unavailable" }),
    });
    expect(report.steps[0]?.status).toBe("missing-connector");
    expect(report.steps[0]?.detail).toBe("gmail");
  });

  test("threw → error (detail = message)", async () => {
    const report = await replayRecipe("s1", [step("gmail_get")], {
      isReadOnly: readOnly,
      run: async () => ({ kind: "threw", message: "boom" }),
    });
    expect(report.steps[0]?.status).toBe("error");
    expect(report.steps[0]?.detail).toBe("boom");
  });

  test("ran ok + original ok → match; ran ok + original error → diverged", async () => {
    const ran: ToolRunOutcome = { kind: "ran", ok: true };
    const r1 = await replayRecipe("s1", [step("gmail_get", "ok")], {
      isReadOnly: readOnly,
      run: async () => ran,
    });
    expect(r1.steps[0]?.status).toBe("match");
    const r2 = await replayRecipe("s1", [step("gmail_get", "error")], {
      isReadOnly: readOnly,
      run: async () => ran,
    });
    expect(r2.steps[0]?.status).toBe("diverged");
    // Reverse divergence: original ok but replay returns error → diverged
    const r3 = await replayRecipe("s1", [step("gmail_get", "ok")], {
      isReadOnly: readOnly,
      run: async () => ({ kind: "ran", ok: false }),
    });
    expect(r3.steps[0]?.status).toBe("diverged");
  });

  test("non-object params → skipped-invalid-params, executor NEVER called", async () => {
    let calls = 0;
    const report = await replayRecipe("s1", [step("gmail_get", "ok", ["not", "an", "object"])], {
      isReadOnly: readOnly,
      run: async () => {
        calls++;
        return { kind: "ran", ok: true };
      },
    });
    expect(report.steps[0]?.status).toBe("skipped-invalid-params");
    expect(calls).toBe(0);
  });

  test("prototype-pollution key in params → skipped-invalid-params, executor NEVER called", async () => {
    let calls = 0;
    // JSON.parse is how a share file's params actually arrive, and it creates `__proto__` as an
    // OWN property — an object literal would not, so the literal would not reproduce the bug.
    const polluted: unknown = JSON.parse('{"id":"1","__proto__":{"isAdmin":true}}');
    const report = await replayRecipe("s1", [step("gmail_get", "ok", polluted)], {
      isReadOnly: readOnly,
      run: async () => {
        calls++;
        return { kind: "ran", ok: true };
      },
    });
    expect(report.steps[0]?.status).toBe("skipped-invalid-params");
    expect(calls).toBe(0);
  });

  // The guard forbids THREE own-property names (FORBIDDEN_PARAM_KEYS), not just `__proto__` — the
  // above test alone leaves `constructor` and `prototype` unexercised. Parameterised so all three
  // share one assertion shape and a regression on any of them is unambiguous about which key broke.
  test.each([
    ["__proto__", '{"id":"1","__proto__":{"isAdmin":true}}'],
    ["constructor", '{"id":"1","constructor":{"isAdmin":true}}'],
    ["prototype", '{"id":"1","prototype":{"isAdmin":true}}'],
  ])(
    "forbidden key %s anywhere in params → skipped-invalid-params, executor NEVER called",
    async (_label, json) => {
      let calls = 0;
      // JSON.parse, not an object literal — see the comment on the `__proto__`-only test above for
      // why that distinction matters for `__proto__` specifically; kept consistent for all three.
      const polluted: unknown = JSON.parse(json);
      const report = await replayRecipe("s1", [step("gmail_get", "ok", polluted)], {
        isReadOnly: readOnly,
        run: async () => {
          calls++;
          return { kind: "ran", ok: true };
        },
      });
      expect(report.steps[0]?.status).toBe("skipped-invalid-params");
      expect(calls).toBe(0);
    },
  );

  test("params tree deeper than MAX_PARAM_DEPTH → skipped-invalid-params, executor NEVER called", async () => {
    let calls = 0;
    // MAX_PARAM_DEPTH is 32; nest one level past it so it is the walk's depth ceiling — not a
    // forbidden key — that triggers the rejection.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 33; i++) {
      deep = { nested: deep };
    }
    const report = await replayRecipe("s1", [step("gmail_get", "ok", deep)], {
      isReadOnly: readOnly,
      run: async () => {
        calls++;
        return { kind: "ran", ok: true };
      },
    });
    expect(report.steps[0]?.status).toBe("skipped-invalid-params");
    expect(calls).toBe(0);
  });

  test("undefined params are valid — a no-argument read tool still runs", async () => {
    let received: unknown = "never called";
    // Built inline, not via `step()`: that helper defaults `params` to `{}`, so passing
    // `undefined` through it would never exercise the absent-params case.
    const noParams: RecipeStep = {
      stepId: "step-x",
      tool: "gmail_get",
      service: "gmail",
      params: undefined,
      status: "ok",
      dependsOn: [],
    };
    const report = await replayRecipe("s1", [noParams], {
      isReadOnly: readOnly,
      run: async (_tool, params) => {
        received = params;
        return { kind: "ran", ok: true };
      },
    });
    expect(report.steps[0]?.status).toBe("match");
    expect(received).toBeUndefined();
  });

  test.each([
    ["null", null],
    ["a string", "gimme"],
    ["a number", 42],
  ])("%s as the params root → skipped-invalid-params, executor NEVER called", async (_label, p) => {
    let calls = 0;
    const report = await replayRecipe("s1", [step("gmail_get", "ok", p)], {
      isReadOnly: readOnly,
      run: async () => {
        calls++;
        return { kind: "ran", ok: true };
      },
    });
    expect(report.steps[0]?.status).toBe("skipped-invalid-params");
    expect(calls).toBe(0);
  });

  test("an array nested INSIDE params is legal — a list of ids still runs", async () => {
    const report = await replayRecipe("s1", [step("gmail_get", "ok", { ids: ["a", "b"] })], {
      isReadOnly: readOnly,
      run: async () => ({ kind: "ran", ok: true }),
    });
    expect(report.steps[0]?.status).toBe("match");
  });

  test("a nested prototype-pollution key → skipped-invalid-params", async () => {
    const nested: unknown = JSON.parse('{"filter":{"deep":{"__proto__":{"isAdmin":true}}}}');
    let calls = 0;
    const report = await replayRecipe("s1", [step("gmail_get", "ok", nested)], {
      isReadOnly: readOnly,
      run: async () => {
        calls++;
        return { kind: "ran", ok: true };
      },
    });
    expect(report.steps[0]?.status).toBe("skipped-invalid-params");
    expect(calls).toBe(0);
  });

  test("summary tallies each category and total", async () => {
    const steps = [step("file_delete"), step("gmail_get", "ok"), step("slack_list", "ok")];
    const report = await replayRecipe("s1", steps, {
      isReadOnly: readOnly,
      run: async (tool) =>
        tool === "gmail_get" ? { kind: "ran", ok: true } : { kind: "unavailable" },
    });
    expect(report.summary).toEqual({
      total: 3,
      match: 1,
      diverged: 0,
      missingConnector: 1,
      skippedNonRead: 1,
      skippedInvalidParams: 0,
      error: 0,
      capped: 0,
    });
  });

  // A share file is untrusted input and its step array is unbounded, so one file could otherwise
  // drive unlimited outbound calls on the owner's credentials. The excess is REPORTED, never
  // silently dropped — a truncated replay that looks complete is its own defect.
  test("caps the number of executed steps and reports the excess", async () => {
    const steps = Array.from({ length: MAX_REPLAY_STEPS + 5 }, (_, i) => ({
      stepId: `step-${i + 1}`,
      tool: "gmail_get",
      service: "gmail",
      params: {},
      status: "ok",
      dependsOn: [],
    }));
    let runs = 0;
    const report = await replayRecipe("s1", steps, {
      isReadOnly: () => true,
      run: async () => {
        runs++;
        return { kind: "ran", ok: true };
      },
    });
    expect(runs).toBe(MAX_REPLAY_STEPS);
    expect(report.summary.total).toBe(MAX_REPLAY_STEPS);
    expect(report.summary.capped).toBe(5);
  });
});

describe("replayShare", () => {
  test("recipe share → report over its steps", async () => {
    const share = shareWith({
      kind: "recipe",
      recipe: {
        recipeVersion: 1,
        sourceSessionId: "s1",
        generatedAt: 1,
        graphTraversals: [],
        steps: [
          {
            stepId: "step-1",
            tool: "gmail_list",
            service: "gmail",
            params: {},
            status: "ok",
            dependsOn: [],
          },
        ],
      },
    });
    const report = await replayShare(share, {
      isReadOnly: () => true,
      run: async () => ({ kind: "ran", ok: true }),
    });
    expect(report.summary.total).toBe(1);
    expect(report.steps[0]?.status).toBe("match");
  });

  // SECURITY-LOAD-BEARING (spec §8.1 / §11): a write tool absent from HITL_REQUIRED_BACKING must be
  // skipped-non-read and NEVER handed to the executor, under the REAL classifier.
  test("a write tool absent from HITL is skipped-non-read and never executed", async () => {
    const executed: string[] = [];
    const share = shareWith({
      kind: "transcript",
      toolCalls: [
        { toolId: "acme_destroy", service: "acme", params: { all: true }, status: "ok" }, // write, not in HITL
        { toolId: "snowflake_tag_set", service: "snowflake", params: {}, status: "ok" }, // write, IS in HITL
        { toolId: "gmail_get", service: "gmail", params: {}, status: "ok" }, // genuine read
      ],
    });
    const report = await replayShare(share, {
      isReadOnly: isReadOnlyToolId, // the REAL positive allowlist
      run: async (toolId) => {
        executed.push(toolId);
        return { kind: "ran", ok: true };
      },
    });
    expect(executed).toEqual(["gmail_get"]); // ONLY the read tool was executed
    expect(report.steps[0]?.status).toBe("skipped-non-read"); // acme_destroy (HITL-absent write)
    expect(report.steps[1]?.status).toBe("skipped-non-read"); // snowflake_tag_set (HITL-present write)
    expect(report.steps[2]?.status).toBe("match"); // gmail_get
  });
});
