import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { resolveConnectorEntry, runStandalone, standaloneEligibility } from "./launcher.ts";

describe("resolveConnectorEntry", () => {
  test("resolves a known connector id to its server entry", () => {
    expect(resolveConnectorEntry("github")).toMatch(
      /mcp-connectors[\\/]github[\\/]src[\\/]server\.ts$/,
    );
  });

  test("rejects an id containing a path separator — no traversal via the id", () => {
    expect(() => resolveConnectorEntry("../gateway/src/index")).toThrow(/invalid connector id/);
    expect(() => resolveConnectorEntry("a/b")).toThrow(/invalid connector id/);
    expect(() => resolveConnectorEntry("a\\b")).toThrow(/invalid connector id/);
  });

  test("rejects uppercase and empty ids", () => {
    expect(() => resolveConnectorEntry("GitHub")).toThrow(/invalid connector id/);
    expect(() => resolveConnectorEntry("")).toThrow(/invalid connector id/);
  });
});

describe("standaloneEligibility", () => {
  test("a read-only connector qualifies with no work — nothing to gate", () => {
    // athena exposes only list/get/search and declares no write or delete.
    expect(standaloneEligibility("athena")).toEqual({ eligible: true, reason: "no-writes" });
  });

  test("github qualifies because its write tools were hardened", () => {
    expect(standaloneEligibility("github")).toEqual({ eligible: true, reason: "hardened" });
  });

  test("a write-declaring connector that has NOT been migrated is refused", () => {
    // snowflake declares writes and has not been routed through the consent kit yet.
    const v = standaloneEligibility("snowflake");
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/not been routed through the consent kit/);
  });

  test("a connector that MUTATES but declares nothing is still refused", () => {
    // snyk issues mutating HTTP requests while its manifest says hitlRequired: []. Trusting the
    // manifest alone would admit it as write-free; the verb signal catches it.
    const v = standaloneEligibility("snyk");
    expect(v.eligible).toBe(false);
  });

  test("an unknown connector is refused rather than assumed safe", () => {
    expect(standaloneEligibility("definitely-not-a-connector").eligible).toBe(false);
  });
});

describe("runStandalone", () => {
  test("exits non-zero with usage when no id is given", async () => {
    expect(await runStandalone([])).toBe(2);
  });

  test("exits non-zero for an unknown connector", async () => {
    expect(await runStandalone(["definitely-not-a-connector"])).toBe(2);
  });

  test("exits non-zero for an invalid id", async () => {
    expect(await runStandalone(["../../etc/passwd"])).toBe(2);
  });

  test("refuses an unmigrated write-capable connector with its own exit code", async () => {
    // 3, not 2: "this connector is not safe standalone yet" is a different fact from "no such
    // connector", and a human triaging the failure should not have to read the message to tell.
    expect(await runStandalone(["snowflake"])).toBe(3);
  });
});

describe("the launcher as an entrypoint", () => {
  const LAUNCHER = resolve(fileURLToPath(import.meta.url), "../launcher.ts");

  async function toolsVia(id: string, elicitation: boolean): Promise<string[]> {
    const client = new Client(
      { name: "launcher-e2e", version: "1.0.0" },
      { capabilities: elicitation ? { elicitation: {} } : {} },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["run", LAUNCHER, id],
        env: { ...process.env, NIMBUS_MCP_GITHUB_WRITE_SCOPE: "repo:acme/api" } as Record<
          string,
          string
        >,
      }),
    );
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  test("a connector booted THROUGH the launcher stays alive and serves tools", async () => {
    // REGRESSION GUARD. `process.exit(await runStandalone(...))` killed the server it had just
    // started: most connectors connect their transport at module scope, so the import resolves
    // while the server is live and runStandalone returns 0 immediately. Calling runStandalone
    // directly — as the unit tests above do — never executes the import.meta.main block, so only
    // an out-of-process boot can catch this.
    const tools = await toolsVia("github", true);
    expect(tools).toContain("github_repo_list");
    expect(tools).toContain("github_branch_delete");
  }, 30_000);

  test("the launcher applies the standalone gate — no elicitation means no write tools", async () => {
    const tools = await toolsVia("github", false);
    expect(tools).toContain("github_repo_list");
    expect(tools).not.toContain("github_branch_delete");
  }, 30_000);
});
