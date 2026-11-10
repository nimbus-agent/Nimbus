// packages/gateway/src/tribal/tribal-no-confirm.test.ts
// Phase 9.7 D0a: the in-chat tribal capture executor (platform/assemble.ts) is handed a consent
// channel with `requestApproval` ONLY, so it can never approve a Wave 4 (type-to-confirm) write, and
// it never sends a Wave 4 type: its destinations are the two knowledge-base write types.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { ToolExecutor } from "../engine/executor.ts";

const assemble = stripComments(
  readFileSync(join(import.meta.dir, "../platform/assemble.ts"), "utf8"),
);

describe("the tribal in-chat executor cannot approve a Wave 4 write", () => {
  test("its consent channel is built with requestApproval only", () => {
    const start = assemble.indexOf("const tribalInterceptCommand");
    expect(start).toBeGreaterThan(-1);
    const at = assemble.indexOf("new ToolExecutor(", start);
    expect(at).toBeGreaterThan(start);
    const call = assemble.slice(at, assemble.indexOf("const submit: TribalSubmitAction", at));
    expect(call).toContain("requestApproval:");
    expect(call).not.toContain("requestConfirmedApproval");
  });

  test("the tribal write types are not Wave 4 rows", () => {
    const wave4 = new Set(
      CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 4).map((r) => r.actionType),
    );
    const gate = stripComments(readFileSync(join(import.meta.dir, "tribal-write-gate.ts"), "utf8"));
    const types = [...gate.matchAll(/type: "([a-z_.]+)"/g)].map((m) => m[1] ?? "");
    expect(types).toEqual(["notion.knowledge.write", "confluence.knowledge.write"]);
    for (const t of types) expect(wave4.has(t), t).toBe(false);
  });

  test("a channel with requestApproval only denies a Wave 4 type without asking (the executor's own rule)", async () => {
    let asked = 0;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          asked += 1;
          return { approved: true, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      { dispatch: async () => ({}) },
      undefined,
      NULL_EGRESS_SINK,
    );
    const out = await exec.execute({
      type: "github.pr.merge",
      payload: { mcpToolId: "github_pr_merge", input: { owner: "a", repo: "b", pullNumber: 1 } },
    });
    expect(out.status).toBe("rejected");
    expect(asked).toBe(0);
  });
});
