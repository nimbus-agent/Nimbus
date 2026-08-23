import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = resolve(fileURLToPath(import.meta.url), "../../src/server.ts");

const WRITE_TOOLS = [
  "github_pr_merge",
  "github_pr_close",
  "github_issue_create",
  "github_branch_delete",
  "github_tag_create",
] as const;

/**
 * Boot the REAL connector as a subprocess and ask it what tools it exposes.
 *
 * This is the end-to-end proof, not a shape test: it exercises the real `McpServer`, the real
 * elicitation capability negotiation, and the real deferred registration. A fake server cannot
 * catch a structural mismatch with the SDK — four such mismatches only surfaced when a real
 * `McpServer` was first passed to the consent kit.
 */
async function toolsFor(opts: { elicitation: boolean }): Promise<string[]> {
  const client = new Client(
    { name: opts.elicitation ? "capable-test-client" : "legacy-test-client", version: "1.0.0" },
    { capabilities: opts.elicitation ? { elicitation: {} } : {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", SERVER],
    // No GITHUB_PAT: the token is read inside handlers, so startup does not need one, and a test
    // must never depend on a real credential.
    env: { ...process.env, NIMBUS_MCP_GITHUB_WRITE_SCOPE: "repo:acme/api" } as Record<
      string,
      string
    >,
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    return listed.tools.map((t) => t.name).sort((a, b) => a.localeCompare(b));
  } finally {
    await client.close();
  }
}

describe("github standalone write surface", () => {
  test("a client WITHOUT elicitation is offered no write tools at all", async () => {
    const tools = await toolsFor({ elicitation: false });
    for (const w of WRITE_TOOLS) {
      expect(tools).not.toContain(w);
    }
    // Reads are unaffected — the connector is genuinely useful, just read-only.
    expect(tools).toContain("github_repo_list");
  }, 30_000);

  test("a client WITH elicitation is offered every write tool", async () => {
    const tools = await toolsFor({ elicitation: true });
    for (const w of WRITE_TOOLS) {
      expect(tools).toContain(w);
    }
    expect(tools).toContain("github_repo_list");
  }, 30_000);

  test("github_commit_push is offered to BOTH — it mutates nothing", async () => {
    // It returns NOT_IMPLEMENTED and issues no request, so it is deliberately not a write tool.
    expect(await toolsFor({ elicitation: false })).toContain("github_commit_push");
  }, 30_000);
});

describe("github write declarations", () => {
  const src = readFileSync(SERVER, "utf8");

  test("every mutating tool declares a machine-readable action type", () => {
    for (const mutates of [
      "repo.pr.merge",
      "repo.pr.close",
      "repo.issue.create",
      "repo.branch.delete",
      "repo.tag.create",
    ]) {
      expect(src).toContain(`mutates: "${mutates}"`);
    }
  });

  test("branch delete declares itself unrecoverable and captures pre-state", () => {
    const idx = src.indexOf('"github_branch_delete"');
    const block = src.slice(idx, idx + 900);
    expect(block).toContain("recoverable: false");
    expect(block).toContain("capturePreState");
  });

  test("the prose 'requires HITL' hints are gone from migrated tools", () => {
    // The requirement is declared in `mutates` now. Leaving both invites them to drift, and the
    // prose version was never enforcement — it was a description string.
    for (const stale of ["requires HITL repo.pr.merge", "requires HITL repo.branch.delete"]) {
      expect(src).not.toContain(stale);
    }
  });
});
