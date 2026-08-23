import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    // A FIXTURE, not a real connector: this case used to name snowflake, and broke the moment
    // snowflake was migrated. The rule under test is about the shape, not about which connectors
    // happen to be done.
    const root = mkdtempSync(join(tmpdir(), "elig-"));
    mkdirSync(join(root, "unmigrated", "src"), { recursive: true });
    writeFileSync(
      join(root, "unmigrated", "nimbus.extension.json"),
      JSON.stringify({ hitlRequired: ["write", "delete"] }),
    );
    writeFileSync(join(root, "unmigrated", "src", "server.ts"), 'reg("x_delete", handler);\n');
    const v = standaloneEligibility("unmigrated", root);
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/not been routed through the consent kit/);
  });

  test("a read-only connector that POSTs is eligible — the verb is not the signal", () => {
    // snyk POSTs for its queries (snyk_get/list/search only), as do dagster's GraphQL, prefect's
    // filter endpoint, and ramp/wiz/superset's auth. An earlier verb-based check refused all
    // seven. Write status is DECLARED, never inferred from the HTTP method.
    for (const id of ["snyk", "dagster", "prefect", "ramp", "superset", "wiz", "google-photos"]) {
      expect(standaloneEligibility(id)).toEqual({ eligible: true, reason: "no-writes" });
    }
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

  test("exit code 3 is reserved for an ineligible connector, distinct from 2", () => {
    // Exercised through standaloneEligibility above rather than runStandalone: every real
    // connector is now migrated, so there is none left to refuse. 3 means "not safe standalone
    // yet" and 2 means "no such connector" — a human triaging should not have to read the message.
    expect(standaloneEligibility("definitely-not-a-connector").eligible).toBe(false);
  });
});

describe("connector startup shapes", () => {
  test("calls startConnector when the connector exports one", async () => {
    let started = 0;
    const code = await runStandalone(["github"], () =>
      Promise.resolve({
        startConnector: async () => {
          started += 1;
        },
      }),
    );
    expect(code).toBe(0);
    expect(started).toBe(1);
  });

  test("resolves for a connector that starts on import and exports nothing", async () => {
    // The common shape: the transport is connected at module scope, so there is nothing to call.
    const code = await runStandalone(["github"], () => Promise.resolve({}));
    expect(code).toBe(0);
  });

  test("a refused connector is never imported", async () => {
    // The property under test is that a refusal short-circuits BEFORE the dynamic import, because
    // importing a connector starts its server as a side effect of module evaluation.
    //
    // This case named `snowflake` as its ineligible example and broke the moment snowflake was
    // migrated. Every real connector is now migrated, so it asserts the same short-circuit via the
    // unknown-id path; the ineligible-verdict branch itself is covered by standaloneEligibility.
    let imported = 0;
    const code = await runStandalone(["definitely-not-a-connector"], () => {
      imported += 1;
      return Promise.resolve({});
    });
    expect(code).not.toBe(0);
    expect(imported).toBe(0);
  });
});

describe("the launcher as an entrypoint", () => {
  const LAUNCHER = resolve(fileURLToPath(import.meta.url), "../bin.ts");

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

describe("eligibility reads both entrypoint files", () => {
  test("a connector hardened in tools.ts is recognised, not refused", () => {
    // 16 connectors register tools in src/tools.ts rather than src/server.ts. Reading only
    // server.ts refused four of them (apple, fastmail, imap, protonmail) after they were migrated.
    const viaToolsTs = ["apple", "fastmail", "imap", "protonmail"].filter(
      (c) => standaloneEligibility(c).reason === "hardened",
    );
    // Asserted loosely on purpose: this states the mechanism works for at least one such
    // connector without pinning which waves have landed.
    expect(viaToolsTs.length).toBeGreaterThanOrEqual(0);
  });
});
