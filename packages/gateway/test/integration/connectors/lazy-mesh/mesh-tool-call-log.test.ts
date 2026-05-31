import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { createLazyConnectorMesh } from "../../../../src/connectors/lazy-mesh/mesh.ts";
import { readToolCallLog } from "../../../../src/db/tool-call-log.ts";
import { agentRequestContext } from "../../../../src/engine/agent-request-context.ts";
import { TOOL_CALL_LOG_V29_SCHEMA_SQL } from "../../../../src/index/tool-call-log-v29-sql.ts";
import type { PlatformPaths } from "../../../../src/platform/paths.ts";
import { MockVault } from "../../../../src/vault/mock.ts";

function freshAuditDb(): Database {
  const db = new Database(":memory:");
  db.exec(TOOL_CALL_LOG_V29_SCHEMA_SQL);
  return db;
}

function stubPaths(): PlatformPaths {
  return {
    socketPath: "/tmp/mock.sock",
    configDir: "/tmp/mock-config",
    dataDir: "/tmp/mock-data",
    logDir: "/tmp/mock-logs",
  } as unknown as PlatformPaths;
}

describe("mesh.ts:listTools — tool_call_log audit-write", () => {
  test("writes one tool_call_log row when a wrapped mesh tool resolves", async () => {
    const auditDb = freshAuditDb();
    const mesh = await createLazyConnectorMesh(stubPaths(), new MockVault(), {
      listUserMcpConnectors: () => [],
      auditDb,
    });

    const fakeKey = "github_repo_pr_list";
    const meshAny = mesh as unknown as {
      listToolsForDispatcher: () => Promise<
        Record<string, { execute?: (input: unknown, ctx?: unknown) => Promise<unknown> }>
      >;
    };
    const originalListToolsForDispatcher = meshAny.listToolsForDispatcher.bind(mesh);
    meshAny.listToolsForDispatcher = async () => ({
      [fakeKey]: { execute: async () => ({ prs: [{ id: 42 }] }) },
    });

    try {
      const tools = await mesh.listTools();
      const exec = tools[fakeKey]?.execute;
      expect(exec).toBeDefined();
      if (exec === undefined) throw new Error("unreachable");

      await agentRequestContext.run({ sessionId: "s-mesh-1" }, async () => {
        const out = await exec({});
        expect(typeof out).toBe("string");
        expect(out).toContain("<tool_output");
        expect(out).toContain('"prs":');
      });
    } finally {
      meshAny.listToolsForDispatcher = originalListToolsForDispatcher;
      await mesh.disconnect();
    }

    const result = readToolCallLog(auditDb, {});
    expect(result.toolCalls).toHaveLength(1);
    const row = result.toolCalls[0];
    if (row === undefined) throw new Error("unreachable");
    expect(row.sessionId).toBe("s-mesh-1");
    expect(row.toolId).toBe(fakeKey);
    expect(row.service).toBe("github");
    expect(row.status).toBe("ok");
  });

  test("writes status='error' when a wrapped mesh tool throws", async () => {
    const auditDb = freshAuditDb();
    const mesh = await createLazyConnectorMesh(stubPaths(), new MockVault(), {
      listUserMcpConnectors: () => [],
      auditDb,
    });
    const fakeKey = "slack_channel_post";
    const meshAny = mesh as unknown as {
      listToolsForDispatcher: () => Promise<
        Record<string, { execute?: (input: unknown, ctx?: unknown) => Promise<unknown> }>
      >;
    };
    const originalListToolsForDispatcher = meshAny.listToolsForDispatcher.bind(mesh);
    meshAny.listToolsForDispatcher = async () => ({
      [fakeKey]: {
        execute: async () => {
          throw new Error("rate limit exceeded");
        },
      },
    });

    try {
      const tools = await mesh.listTools();
      const exec = tools[fakeKey]?.execute;
      if (exec === undefined) throw new Error("unreachable");
      await agentRequestContext.run({ sessionId: "s-mesh-err" }, async () => {
        await expect(exec({})).rejects.toThrow("rate limit exceeded");
      });
    } finally {
      meshAny.listToolsForDispatcher = originalListToolsForDispatcher;
      await mesh.disconnect();
    }

    const result = readToolCallLog(auditDb, {});
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.status).toBe("error");
    expect(result.toolCalls[0]?.service).toBe("slack");
    expect(result.toolCalls[0]?.resultEnvelope).toContain("rate limit exceeded");
  });
});
