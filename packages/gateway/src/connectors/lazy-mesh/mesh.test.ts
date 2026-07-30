import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentRequestContext } from "../../engine/agent-request-context.ts";
import { LocalIndex } from "../../index/local-index.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import { LazyDrainTracker } from "./drain.ts";
import { LAZY_MESH, userMcpMeshKey } from "./keys.ts";
import { createLazyConnectorMesh, LazyConnectorMesh } from "./mesh.ts";
import type { LazyMcpSlot } from "./slot.ts";

/**
 * Roots handed out by `makePaths()`, removed in `afterEach`. Without this the
 * suite leaked one temp directory per `makePaths()` call — 40 per run, on every
 * platform — because the root was never referenced again after construction.
 * Same family as #969, different cause: there was no cleanup at all here.
 */
const createdRoots: string[] = [];

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-"));
  createdRoots.push(root);
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
  };
}

let mesh: LazyConnectorMesh | undefined;

beforeEach(() => {
  mesh = undefined;
});

afterEach(async () => {
  if (mesh !== undefined) {
    try {
      await mesh.disconnect();
    } catch {
      /* ignore */
    }
    mesh = undefined;
  }
  // Remove after disconnect(), so nothing is still writing under the root.
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("LazyConnectorMesh constructor", () => {
  test("constructs without throwing using only vault + paths", () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    expect(mesh).toBeInstanceOf(LazyConnectorMesh);
  });

  test("getToolsEpoch starts at 0", () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    expect(mesh.getToolsEpoch()).toBe(0);
  });

  test("accepts optional inactivityMs + listUserMcpConnectors", () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      inactivityMs: 60_000,
      listUserMcpConnectors: () => [],
    });
    expect(mesh.getToolsEpoch()).toBe(0);
  });

  test("accepts optional auditDb + logger + obsidianVaultPaths", () => {
    const noopLogger = { warn: () => {} };
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      logger: noopLogger,
      obsidianVaultPaths: [],
    });
    expect(mesh.getToolsEpoch()).toBe(0);
  });
});

describe("createLazyConnectorMesh", () => {
  test("returns a LazyConnectorMesh instance", async () => {
    mesh = await createLazyConnectorMesh(makePaths(), createMockVault());
    expect(mesh).toBeInstanceOf(LazyConnectorMesh);
  });
});

/**
 * Every `ensure<Service>Running` delegator resolves to a no-op when the vault holds no key
 * for that service. Table-driven because the assertion is identical for all 18 — the only
 * thing under test is that the delegator exists and short-circuits.
 */
const ENSURE_DELEGATORS: ReadonlyArray<readonly [string, (m: LazyConnectorMesh) => Promise<void>]> =
  [
    ["ensurePhase3BundleRunning", (m) => m.ensurePhase3BundleRunning()],
    ["ensureGoogleDriveRunning", (m) => m.ensureGoogleDriveRunning()],
    ["ensureGithubRunning", (m) => m.ensureGithubRunning()],
    ["ensureGitlabRunning", (m) => m.ensureGitlabRunning()],
    ["ensureBitbucketRunning", (m) => m.ensureBitbucketRunning()],
    ["ensureSlackRunning", (m) => m.ensureSlackRunning()],
    ["ensureLinearRunning", (m) => m.ensureLinearRunning()],
    ["ensureJiraRunning", (m) => m.ensureJiraRunning()],
    ["ensureNotionRunning", (m) => m.ensureNotionRunning()],
    ["ensureMendeleyRunning", (m) => m.ensureMendeleyRunning()],
    ["ensureAppleRunning", (m) => m.ensureAppleRunning()],
    ["ensureObsidianRunning", (m) => m.ensureObsidianRunning()],
    ["ensureConfluenceRunning", (m) => m.ensureConfluenceRunning()],
    ["ensureDiscordRunning", (m) => m.ensureDiscordRunning()],
    ["ensureJenkinsRunning", (m) => m.ensureJenkinsRunning()],
    ["ensureCircleciRunning", (m) => m.ensureCircleciRunning()],
    ["ensurePagerdutyRunning", (m) => m.ensurePagerdutyRunning()],
    ["ensureKubernetesRunning", (m) => m.ensureKubernetesRunning()],
  ];

describe("ensure<Service>Running delegators (no vault keys → all no-op)", () => {
  beforeEach(() => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
  });

  test.each(ENSURE_DELEGATORS)("%s is a no-op without vault keys", async (_name, run) => {
    await expect(run(mesh!)).resolves.toBeUndefined();
  });
});

describe("user-mcp + extension lifecycle (no rows)", () => {
  test("ensureUserMcpRunning is a no-op when service id has no row", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [],
    });
    await expect(mesh.ensureUserMcpRunning("nonexistent")).resolves.toBeUndefined();
  });

  test("stopExtensionClient on unknown id is a no-op", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    await expect(mesh.stopExtensionClient("unknown.ext")).resolves.toBeUndefined();
  });
});

describe("disconnect with no active slots", () => {
  test("disconnect after construction tears down filesystem MCP cleanly", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    await expect(mesh.disconnect()).resolves.toBeUndefined();
    // Idempotent: a second disconnect on an already-torn-down mesh must also be a no-op.
    await expect(mesh.disconnect()).resolves.toBeUndefined();
    mesh = undefined;
  });
});

interface FakeMcpClient {
  listTools(): Promise<Record<string, { execute?: (i: unknown, c?: unknown) => Promise<unknown> }>>;
  disconnect(): Promise<void>;
}

function makeFakeMcpClient(opts: {
  tools?: Record<string, { execute?: (i: unknown, c?: unknown) => Promise<unknown> }>;
  listToolsThrows?: boolean;
  disconnectThrows?: boolean;
}): FakeMcpClient & { disconnectCalls: number; listToolsCalls: number } {
  let listToolsCalls = 0;
  let disconnectCalls = 0;
  const fake = {
    async listTools(): Promise<
      Record<string, { execute?: (i: unknown, c?: unknown) => Promise<unknown> }>
    > {
      listToolsCalls += 1;
      if (opts.listToolsThrows === true) {
        throw new Error("synthetic listTools failure");
      }
      return opts.tools ?? {};
    },
    async disconnect(): Promise<void> {
      disconnectCalls += 1;
      if (opts.disconnectThrows === true) {
        throw new Error("synthetic disconnect failure");
      }
    },
    get disconnectCalls(): number {
      return disconnectCalls;
    },
    get listToolsCalls(): number {
      return listToolsCalls;
    },
  };
  return fake;
}

function asPrivate(m: LazyConnectorMesh): {
  filesystem: { listTools(): Promise<unknown>; disconnect(): Promise<void> };
  lazySlots: Map<string, LazyMcpSlot>;
} {
  return m as unknown as {
    filesystem: { listTools(): Promise<unknown>; disconnect(): Promise<void> };
    lazySlots: Map<string, LazyMcpSlot>;
  };
}

describe("listToolsForDispatcher merges fs + builtin + user slot tools", () => {
  test("with only filesystem tools → returns wrapped fs tools, no other entries", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    const fsClient = makeFakeMcpClient({
      tools: {
        fs_read: {
          execute: async (_i: unknown): Promise<unknown> => ({ ok: true, body: "hello" }),
        },
      },
    });
    asPrivate(mesh).filesystem = fsClient;

    const merged = await mesh.listToolsForDispatcher();

    expect(Object.keys(merged).sort((a, b) => a.localeCompare(b))).toEqual(["fs_read"]);
    const fsRead = merged["fs_read"];
    if (fsRead?.execute === undefined) throw new Error("fs_read missing");
    const result = (await fsRead.execute({}, undefined)) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  test("merges fs + builtin lazy slot tools without collision; refcount wrap applied", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    const fsClient = makeFakeMcpClient({
      tools: {
        fs_list: { execute: async (): Promise<unknown> => ({ files: [] }) },
      },
    });
    asPrivate(mesh).filesystem = fsClient;

    const ghDrain = new LazyDrainTracker();
    const ghClient = makeFakeMcpClient({
      tools: {
        gh_repos: {
          execute: async (): Promise<unknown> => ({ repos: ["alpha", "beta"] }),
        },
      },
    });
    asPrivate(mesh).lazySlots.set(LAZY_MESH.github, {
      client: ghClient as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain: ghDrain,
    });

    const merged = await mesh.listToolsForDispatcher();

    expect(Object.keys(merged).sort((a, b) => a.localeCompare(b))).toEqual(["fs_list", "gh_repos"]);

    const ghReposExec = merged["gh_repos"]?.execute;
    if (ghReposExec === undefined) throw new Error("gh_repos missing");
    expect(ghDrain.count).toBe(0);
    const pending = ghReposExec({}, undefined);
    expect(ghDrain.count).toBe(1);
    const out = (await pending) as { repos: string[] };
    expect(out.repos).toEqual(["alpha", "beta"]);
    expect(ghDrain.count).toBe(0);
  });

  test("merges user-mcp slot tools when key starts with mesh:user: prefix", async () => {
    const rows = [
      {
        service_id: "mcp_custom",
        command: "/bin/echo",
        args_json: "[]",
        created_at: 0,
      },
    ];
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => rows,
    });
    asPrivate(mesh).filesystem = makeFakeMcpClient({ tools: {} });

    const userClient = makeFakeMcpClient({
      tools: { mcp_custom_ping: { execute: async (): Promise<unknown> => "pong" } },
    });
    asPrivate(mesh).lazySlots.set(userMcpMeshKey("mcp_custom"), {
      client: userClient as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });

    const merged = await mesh.listToolsForDispatcher();

    expect(Object.keys(merged)).toContain("mcp_custom_ping");
  });

  test("buildSlotForToolMap swallows listTools errors from disappearing slots", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    asPrivate(mesh).filesystem = makeFakeMcpClient({
      tools: { fs_ok: { execute: async (): Promise<unknown> => "ok" } },
    });

    const flakyClient = makeFakeMcpClient({ tools: {}, listToolsThrows: false });
    let calls = 0;
    flakyClient.listTools = async (): Promise<
      Record<string, { execute?: (i: unknown, c?: unknown) => Promise<unknown> }>
    > => {
      calls += 1;
      if (calls === 1) return {};
      throw new Error("slot vanished mid-collection");
    };
    asPrivate(mesh).lazySlots.set(LAZY_MESH.slack, {
      client: flakyClient as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });

    const merged = await mesh.listToolsForDispatcher();

    expect(Object.keys(merged).sort((a, b) => a.localeCompare(b))).toEqual(["fs_ok"]);
  });
});

describe("listTools wraps every result in the I11 envelope", () => {
  test("envelope present on the LLM-facing tool result — regression guard for I11", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    asPrivate(mesh).filesystem = makeFakeMcpClient({
      tools: {
        filesystem_read: {
          execute: async (): Promise<unknown> => ({ data: "hello world" }),
        },
      },
    });

    const merged = await mesh.listTools();
    const exec = merged["filesystem_read"]?.execute;
    if (exec === undefined) throw new Error("filesystem_read missing");

    const envelope = (await exec({}, undefined)) as string;

    expect(typeof envelope).toBe("string");
    expect(envelope.startsWith("<tool_output ")).toBe(true);
    expect(envelope.endsWith("</tool_output>")).toBe(true);
    expect(envelope).toContain('service="filesystem"');
    expect(envelope).toContain('tool="filesystem_read"');
    expect(envelope).toContain('{"data":"hello world"}');
  });

  test("envelope wraps a thrown tool error AND re-throws (envelope is forensic-only)", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    asPrivate(mesh).filesystem = makeFakeMcpClient({
      tools: {
        filesystem_boom: {
          execute: async (): Promise<unknown> => {
            throw new Error("kaboom");
          },
        },
      },
    });

    const merged = await mesh.listTools();
    const exec = merged["filesystem_boom"]?.execute;
    if (exec === undefined) throw new Error("filesystem_boom missing");

    await expect(exec({}, undefined)).rejects.toThrow(/kaboom/);
  });

  test("when auditDb is provided, both success and error paths write tool_call_log rows", async () => {
    const auditDb = new Database(":memory:");
    LocalIndex.ensureSchema(auditDb);

    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), { auditDb });
    asPrivate(mesh).filesystem = makeFakeMcpClient({
      tools: {
        github_pr_list: {
          execute: async (): Promise<unknown> => ({ prs: [] }),
        },
        github_pr_get: {
          execute: async (): Promise<unknown> => {
            throw new Error("not found");
          },
        },
      },
    });

    await agentRequestContext.run({ sessionId: "session-xyz" }, async () => {
      const merged = await mesh!.listTools();
      const list = merged["github_pr_list"]?.execute;
      const get = merged["github_pr_get"]?.execute;
      if (list === undefined || get === undefined) throw new Error("tool missing");
      await list({}, undefined);
      await expect(get({}, undefined)).rejects.toThrow(/not found/);
    });

    const rows = auditDb
      .query(
        "SELECT session_id, tool_id, service, status, result_envelope FROM tool_call_log ORDER BY id",
      )
      .all() as Array<{
      session_id: string | null;
      tool_id: string;
      service: string;
      status: "ok" | "error";
      result_envelope: string;
    }>;

    expect(rows).toHaveLength(2);
    const [ok, err] = rows;
    if (ok === undefined || err === undefined) throw new Error("rows missing");

    expect(ok.tool_id).toBe("github_pr_list");
    expect(ok.service).toBe("github");
    expect(ok.status).toBe("ok");
    expect(ok.session_id).toBe("session-xyz");
    expect(ok.result_envelope).toContain('<tool_output service="github"');

    expect(err.tool_id).toBe("github_pr_get");
    expect(err.service).toBe("github");
    expect(err.status).toBe("error");
    expect(err.result_envelope).toContain('"error"');

    auditDb.close();
  });
});

describe("scheduleLazyDisconnect + stopLazyClient drain semantics", () => {
  test("scheduling then immediately stopping a slot drains 0-count cleanly", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), { inactivityMs: 50 });
    const fake = makeFakeMcpClient({ tools: {} });
    asPrivate(mesh).lazySlots.set(LAZY_MESH.linear, {
      client: fake as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });

    await mesh.disconnect();
    expect(fake.disconnectCalls).toBe(1);
  });

  test("disconnect() on a slot with in-flight drain awaits the drain before disconnect", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    const drain = new LazyDrainTracker();
    const fake = makeFakeMcpClient({ tools: {} });
    asPrivate(mesh).lazySlots.set(LAZY_MESH.jira, {
      client: fake as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain,
    });

    drain.bump();

    const stopP = mesh.disconnect();
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(fake.disconnectCalls).toBe(0);

    drain.drop();
    await stopP;
    expect(fake.disconnectCalls).toBe(1);
  });

  test("stopLazyClient swallows disconnect() failures", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    const fake = makeFakeMcpClient({ tools: {}, disconnectThrows: true });
    asPrivate(mesh).lazySlots.set(LAZY_MESH.notion, {
      client: fake as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });

    await mesh.disconnect();
    expect(fake.disconnectCalls).toBe(1);
  });

  test("getToolsEpoch increments after a slot teardown", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    asPrivate(mesh).lazySlots.set(LAZY_MESH.discord, {
      client: makeFakeMcpClient({ tools: {} }) as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });

    expect(mesh.getToolsEpoch()).toBe(0);
    await mesh.disconnect();
    expect(mesh.getToolsEpoch()).toBeGreaterThanOrEqual(1);
  });

  test("stopExtensionClient against a registered user-mesh slot tears it down", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    const extId = "my.extension";
    const fake = makeFakeMcpClient({ tools: {} });
    asPrivate(mesh).lazySlots.set(userMcpMeshKey(extId), {
      client: fake as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });

    await mesh.stopExtensionClient(extId);

    expect(fake.disconnectCalls).toBe(1);
    expect(asPrivate(mesh).lazySlots.has(userMcpMeshKey(extId))).toBe(false);
    mesh = undefined;
  });
});

describe("ensureUserMcpRunning constructs a slot when a matching row exists", () => {
  test("matching service_id → MCPClient is constructed and tools epoch bumps", async () => {
    const rows = [
      {
        service_id: "mcp_unit_test",
        command: "/bin/echo",
        args_json: '["arg1"]',
        created_at: 0,
      },
    ];
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => rows,
    });

    const epochBefore = mesh.getToolsEpoch();
    await mesh.ensureUserMcpRunning("mcp_unit_test");
    expect(mesh.getToolsEpoch()).toBe(epochBefore + 1);

    expect(asPrivate(mesh).lazySlots.has(userMcpMeshKey("mcp_unit_test"))).toBe(true);
  });

  test("matching service_id but row.args_json malformed → no slot, no throw", async () => {
    const rows = [
      {
        service_id: "mcp_bad_args",
        command: "/bin/echo",
        args_json: "not-json",
        created_at: 0,
      },
    ];
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => rows,
    });

    const epochBefore = mesh.getToolsEpoch();
    await mesh.ensureUserMcpRunning("mcp_bad_args");
    expect(mesh.getToolsEpoch()).toBe(epochBefore);
  });
});
