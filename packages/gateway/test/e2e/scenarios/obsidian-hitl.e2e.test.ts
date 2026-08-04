import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vaultIdFromAbsolutePath } from "../../../src/connectors/obsidian-vault-id.ts";
import { NULL_EGRESS_SINK } from "../../../src/egress/egress-ledger.ts";
import { HITL_REQUIRED, ToolExecutor } from "../../../src/engine/executor.ts";

function buildVault(): { root: string; vaultId: string } {
  const root = mkdtempSync(join(tmpdir(), "obsidian-hitl-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  return { root, vaultId: vaultIdFromAbsolutePath(root) };
}

test("obsidian.note.append is in HITL_REQUIRED (structural)", () => {
  expect(HITL_REQUIRED.has("obsidian.note.append")).toBe(true);
});

test("audit log entry is written before the dispatcher executes the append", async () => {
  const calls: Array<"audit" | "dispatch"> = [];
  const audit = {
    recordAudit: () => {
      calls.push("audit");
    },
  };
  const dispatch = {
    dispatch: async () => {
      calls.push("dispatch");
      return { ok: true };
    },
  };
  const consent = {
    requestApproval: async (_prompt: string, _details?: Record<string, unknown>) => true,
  };
  // biome-ignore lint/suspicious/noExplicitAny: mock spies are simpler than typed mocks here
  const exec = new ToolExecutor(
    consent as any,
    audit as any,
    dispatch as any,
    undefined,
    NULL_EGRESS_SINK,
  );
  const result = await exec.execute({
    type: "obsidian.note.append",
    payload: {
      mcpToolId: "obsidian_obsidian_append_to_daily_note",
      input: { vault_id: "x", content: "hi" },
    },
  });
  expect(result.status).toBe("ok");
  expect(calls[0]).toBe("audit");
  expect(calls[1]).toBe("dispatch");
});

test("rejecting the consent prompt returns rejected and never dispatches", async () => {
  const { root, vaultId } = buildVault();
  const dailyPath = join(root, "2026-05-10.md");
  writeFileSync(dailyPath, "before");

  const consent = {
    requestApproval: async () => false,
  };
  let auditCalls = 0;
  const audit = {
    recordAudit: () => {
      auditCalls++;
    },
  };
  let dispatched = false;
  const dispatch = {
    dispatch: async () => {
      dispatched = true;
      return null;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: mock spies are simpler than typed mocks here
  const exec = new ToolExecutor(
    consent as any,
    audit as any,
    dispatch as any,
    undefined,
    NULL_EGRESS_SINK,
  );

  const result = await exec.execute({
    type: "obsidian.note.append",
    payload: {
      mcpToolId: "obsidian_obsidian_append_to_daily_note",
      input: { vault_id: vaultId, content: "AFTER", date_iso: "2026-05-10" },
    },
  });

  expect(result.status).toBe("rejected");
  expect(dispatched).toBe(false);
  expect(auditCalls).toBe(1);
  expect(existsSync(dailyPath)).toBe(true);
  expect(readFileSync(dailyPath, "utf8")).toBe("before");
});
