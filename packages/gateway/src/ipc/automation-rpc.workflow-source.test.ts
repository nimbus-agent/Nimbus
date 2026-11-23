import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { recordImport } from "../automation/workflow-import-store.ts";
import { parseWorkflowSteps, workflowStepsSha256 } from "../automation/workflow-steps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAutomationRpc } from "./automation-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `workflow.list` reports where a workflow's content came from (I59), and only to the owner's own
 * connection (`cli` or `ui`): any other kind gets the rows with no `source` key at all.
 */
const STEPS = JSON.stringify([
  {
    kind: "query",
    label: "q",
    query: { service: "gmail", type: "email", select: "metadata.threadId", limit: 5 },
  },
  {
    kind: "write",
    tool: "gmail_thread_archive",
    input: { threadId: { from: "q", column: "metadata.threadId" } },
  },
]);

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

async function saveWorkflow(db: Database, name: string): Promise<string> {
  const out = await dispatchAutomationRpc({
    method: "workflow.save",
    params: { name, stepsJson: STEPS },
    db,
    clientKind: "cli",
  });
  if (out.kind !== "hit") throw new Error("save missed");
  return (out.value as { id: string }).id;
}

const FP = "f".repeat(32);

function importRecord(db: Database, workflowId: string, bundleName: string, stepsSha256: string) {
  recordImport(db, {
    signerFingerprint: FP,
    bundleName,
    issuedAt: 1_700_000_000_000,
    bundleSha256: "b".repeat(64),
    stepsSha256,
    signerPubkey: "pk",
    authorLabel: null,
    workflowId,
    importedAt: 1_700_000_001_000,
    approvalAuditId: 1,
  });
}

type Listed = { name: string; source?: Record<string, unknown> };

async function list(db: Database, clientKind?: ClientKind): Promise<Map<string, Listed>> {
  const out = await dispatchAutomationRpc({
    method: "workflow.list",
    params: {},
    db,
    ...(clientKind === undefined ? {} : { clientKind }),
  });
  if (out.kind !== "hit") throw new Error("list missed");
  const rows = (out.value as { workflows: Listed[] }).workflows;
  return new Map(rows.map((r) => [r.name, r]));
}

describe("workflow.list source (I59)", () => {
  const matching = workflowStepsSha256(parseWorkflowSteps(STEPS));

  async function seeded(): Promise<Database> {
    const db = freshDb();
    await saveWorkflow(db, "mine");
    importRecord(db, await saveWorkflow(db, "same"), "same", matching);
    importRecord(db, await saveWorkflow(db, "edited"), "edited", "0".repeat(64));
    const broken = await saveWorkflow(db, "broken");
    db.run("UPDATE workflow SET steps_json = 'not json' WHERE id = ?", [broken]);
    importRecord(db, broken, "broken", matching);
    return db;
  }

  test.each(["cli", "ui"] as const)(
    "a %s connection sees local and imported sources",
    async (kind) => {
      const rows = await list(await seeded(), kind);
      expect(rows.get("mine")?.source).toEqual({ kind: "local" });
      expect(rows.get("same")?.source).toEqual({
        kind: "imported",
        signerFingerprint: FP,
        issuedAt: 1_700_000_000_000,
        edited: false,
      });
      expect(rows.get("edited")?.source?.["edited"]).toBe(true);
      // Steps that no longer parse have no current hash: always read as edited.
      expect(rows.get("broken")?.source?.["edited"]).toBe(true);
    },
  );

  test.each([undefined, "mcp", "http", "unknown"] as const)(
    "a %p connection gets no source key",
    async (kind) => {
      const rows = await list(await seeded(), kind);
      expect(rows.size).toBe(4);
      for (const row of rows.values()) expect(Object.hasOwn(row, "source")).toBe(false);
    },
  );
});
