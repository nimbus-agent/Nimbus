import { describe, expect, test } from "bun:test";
import { checkWorkflowImportConfinement } from "./check-nimbus-invariants.ts";

// D50(b): the executor's `usesPromptText` module may spell `workflow.import`, never `workflow.export`.
const TYPES = "packages/gateway/src/engine/executor/action-types.ts";
const rules = (contents: string): string[] =>
  checkWorkflowImportConfinement([{ relPath: TYPES, contents }]).map((v) => v.rule);

describe("D50 - engine/executor/action-types.ts and the method literals", () => {
  test("a workflow.import literal there passes", () => {
    expect(rules('const m = "workflow.import";')).toEqual([]);
  });

  test("a workflow.export literal there is still flagged", () => {
    expect(rules('const m = "workflow.export";')).toContain("workflow-import-entry-confined");
  });
});
