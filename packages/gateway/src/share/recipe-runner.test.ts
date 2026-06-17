// packages/gateway/src/share/recipe-runner.test.ts
import { describe, expect, test } from "bun:test";
import { stepsFromShare } from "./recipe-runner.ts";
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
});
