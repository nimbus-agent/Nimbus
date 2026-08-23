import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AuditEntry, appendAuditEntry, verifyAuditChain } from "./audit-chain.ts";

async function tempLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-audit-"));
  return join(dir, "audit.jsonl");
}

function entry(tool: string, outcome: AuditEntry["outcome"]): AuditEntry {
  return { ts: "2026-08-23T00:00:00.000Z", tool, outcome, connector: "github", detail: {} };
}

describe("audit chain", () => {
  test("an empty/absent log verifies as an empty chain", async () => {
    const p = await tempLog();
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 0 });
  });

  test("appends verify, and the chain survives multiple entries", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("github_pr_merge", "requested"));
    await appendAuditEntry(p, entry("github_pr_merge", "accepted"));
    await appendAuditEntry(p, entry("github_pr_merge", "executed"));
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 3 });
  });

  test("a TAMPERED entry breaks verification at its line", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("github_pr_merge", "declined"));
    await appendAuditEntry(p, entry("github_branch_delete", "executed"));

    const lines = (await readFile(p, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0] as string) as { entry: AuditEntry };
    (first.entry as { outcome: string }).outcome = "accepted";
    lines[0] = JSON.stringify(first);
    await writeFile(p, `${lines.join("\n")}\n`);

    expect(await verifyAuditChain(p)).toEqual({ ok: false, brokenAtLine: 1 });
  });

  test("a DELETED middle entry breaks the chain — append-only is enforced by the links", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("a", "executed"));
    await appendAuditEntry(p, entry("b", "executed"));
    await appendAuditEntry(p, entry("c", "executed"));

    const lines = (await readFile(p, "utf8")).trimEnd().split("\n");
    await writeFile(p, `${[lines[0], lines[2]].join("\n")}\n`);

    expect(await verifyAuditChain(p)).toEqual({ ok: false, brokenAtLine: 2 });
  });

  test("an unparseable line is reported at its own position, not as a silent pass", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("a", "executed"));
    await writeFile(p, `${(await readFile(p, "utf8")).trimEnd()}\nnot-json\n`);
    expect(await verifyAuditChain(p)).toEqual({ ok: false, brokenAtLine: 2 });
  });

  test("key order in detail does not affect verification", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, {
      ts: "2026-08-23T00:00:00.000Z",
      connector: "github",
      tool: "t",
      outcome: "executed",
      detail: { b: 2, a: 1 },
    });
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 1 });
  });
});
