/**
 * Unit tests for `LazyConnectorMesh` — the lazy MCP mesh that spawns
 * per-connector child processes. The class is constructed against a real
 * `MockVault` + a tmp-dir-backed `PlatformPaths`; tests exercise:
 *
 *   - the constructor (filesystem MCPClient wiring, spawn context)
 *   - the simple getters (`getToolsEpoch`)
 *   - every `ensure<Service>Running` delegator (no vault keys present →
 *     each delegate is a no-op, but the wrapper line is still covered)
 *   - `disconnect()` with no active slots
 *   - `stopExtensionClient` against an unknown extension id (no-op)
 *
 * We intentionally do NOT exercise actual MCP child spawning here — that
 * path requires real `bunx` resolution and would launch real subprocesses.
 * Slot-state plumbing is covered by `lazy-mesh.test.ts` (LazyDrainTracker
 * + mergeToolMapsOrThrow). This file targets the wiring boilerplate.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-"));
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

describe("ensure<Service>Running delegators (no vault keys → all no-op)", () => {
  // Each ensure*Running wraps a free `ensureXxxMcp` function. With no vault
  // keys + no MCP spawn path triggered, each one returns without effect.
  // The point here is line coverage of the delegator wrapper itself.
  beforeEach(() => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
  });

  test("ensurePhase3BundleRunning is a no-op without vault keys", async () => {
    await mesh!.ensurePhase3BundleRunning();
  });
  test("ensureGoogleDriveRunning", async () => {
    await mesh!.ensureGoogleDriveRunning();
  });
  // ensureMicrosoftBundleRunning spawns onedrive/outlook/teams unconditionally
  // — skip in unit tests; covered by E2E.
  test("ensureGithubRunning", async () => {
    await mesh!.ensureGithubRunning();
  });
  test("ensureGitlabRunning", async () => {
    await mesh!.ensureGitlabRunning();
  });
  test("ensureBitbucketRunning", async () => {
    await mesh!.ensureBitbucketRunning();
  });
  test("ensureSlackRunning", async () => {
    await mesh!.ensureSlackRunning();
  });
  test("ensureLinearRunning", async () => {
    await mesh!.ensureLinearRunning();
  });
  test("ensureJiraRunning", async () => {
    await mesh!.ensureJiraRunning();
  });
  test("ensureNotionRunning", async () => {
    await mesh!.ensureNotionRunning();
  });
  test("ensureObsidianRunning", async () => {
    await mesh!.ensureObsidianRunning();
  });
  test("ensureConfluenceRunning", async () => {
    await mesh!.ensureConfluenceRunning();
  });
  test("ensureDiscordRunning", async () => {
    await mesh!.ensureDiscordRunning();
  });
  test("ensureJenkinsRunning", async () => {
    await mesh!.ensureJenkinsRunning();
  });
  test("ensureCircleciRunning", async () => {
    await mesh!.ensureCircleciRunning();
  });
  test("ensurePagerdutyRunning", async () => {
    await mesh!.ensurePagerdutyRunning();
  });
  test("ensureKubernetesRunning", async () => {
    await mesh!.ensureKubernetesRunning();
  });
});

describe("user-mcp + extension lifecycle (no rows)", () => {
  test("ensureUserMcpRunning is a no-op when service id has no row", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [],
    });
    // No connectors → returns silently.
    await mesh.ensureUserMcpRunning("nonexistent");
  });

  test("stopExtensionClient on unknown id is a no-op", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    await mesh.stopExtensionClient("unknown.ext");
  });
});

describe("disconnect with no active slots", () => {
  test("disconnect after construction tears down filesystem MCP cleanly", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    await mesh.disconnect();
    // After disconnect, calling again should also not throw (lazySlots is
    // empty so the loop is empty and filesystem.disconnect catches errors).
    await mesh.disconnect();
    // Mark as already disconnected so afterEach doesn't re-disconnect.
    mesh = undefined;
  });
});

// ─── Fakes for exercising slot state-machine + listTools envelope ──────────
//
// The collection / wrap / listTools paths normally consult the real
// `@mastra/mcp` MCPClient (which spawns a `bunx` child). Below we swap in a
// fake client that implements only the `listTools()` + `disconnect()` shape
// the mesh exercises, so we can hit the dispatcher + the I11 envelope path
// (~line 397) without spawning real subprocesses.

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
  return fake as FakeMcpClient & { disconnectCalls: number; listToolsCalls: number };
}

/**
 * Cast helper for poking the private `filesystem` field + the `lazySlots`
 * map. The lazy mesh exposes these only as `private`, but for unit tests
 * we deliberately swap them to fake `MCPClient` shapes so the dispatcher
 * + envelope wiring can be exercised without subprocess spawning.
 */
function asPrivate(m: LazyConnectorMesh): {
  filesystem: { listTools(): Promise<unknown>; disconnect(): Promise<void> };
  lazySlots: Map<string, LazyMcpSlot>;
} {
  return m as unknown as {
    filesystem: { listTools(): Promise<unknown>; disconnect(): Promise<void> };
    lazySlots: Map<string, LazyMcpSlot>;
  };
}

// ─── listToolsForDispatcher + listTools (I11 envelope + V29 audit) ─────────

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

    expect(Object.keys(merged).sort()).toEqual(["fs_read"]);
    // Drain-counter wrap is present (slotForTool has no entry for fs_read
    // since the filesystem slot is not in lazySlots — wrap is skipped, the
    // original execute survives), but the merged map is the raw shape.
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

    // Inject a fake github slot with a drain tracker we can observe.
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

    expect(Object.keys(merged).sort()).toEqual(["fs_list", "gh_repos"]);

    // The github tool flows through wrapMergedToolsWithRefcount (because
    // its key appears in slotForTool). Calling it must bump+drop the drain.
    const ghReposExec = merged["gh_repos"]?.execute;
    if (ghReposExec === undefined) throw new Error("gh_repos missing");
    expect(ghDrain.count).toBe(0);
    const pending = ghReposExec({}, undefined);
    // While the call is in flight, drain.count is 1 (bump happened
    // synchronously). The Promise resolves after the original returns, at
    // which point drop() runs and count returns to 0.
    expect(ghDrain.count).toBe(1);
    const out = (await pending) as { repos: string[] };
    expect(out.repos).toEqual(["alpha", "beta"]);
    expect(ghDrain.count).toBe(0);
  });

  test("merges user-mcp slot tools when key starts with mesh:user: prefix", async () => {
    // ensureUserMcpConnectorsRunning tears down any user-prefix slot whose
    // service id is not in the row list, so we keep the row list in sync
    // with the slot we inject. We also stub ensureUserMcpClient by
    // pre-registering an existing client so the inner call hits the
    // early-return branch (no real subprocess construction).
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

    // Slot whose client.listTools() throws — must not poison the merged map.
    const flakyClient = makeFakeMcpClient({ tools: {}, listToolsThrows: false });
    // Second listTools (from buildSlotForToolMap) throws.
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

    expect(Object.keys(merged).sort()).toEqual(["fs_ok"]);
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

    // Structural assertion: must be the I11 envelope shape.
    expect(typeof envelope).toBe("string");
    expect(envelope.startsWith("<tool_output ")).toBe(true);
    expect(envelope.endsWith("</tool_output>")).toBe(true);
    expect(envelope).toContain('service="filesystem"');
    expect(envelope).toContain('tool="filesystem_read"');
    // The JSON-stringified body must be embedded.
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

    // The wrapped execute always re-throws so the caller sees the original
    // failure; the envelope is written to tool_call_log (when auditDb set)
    // and discarded otherwise.
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

    // Run inside an agent-request context so sessionId is captured.
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

    expect(rows.length).toBe(2);
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

// ─── Slot state-machine: drain / disconnect / idle scheduling ──────────────

describe("scheduleLazyDisconnect + stopLazyClient drain semantics", () => {
  test("scheduling then immediately stopping a slot drains 0-count cleanly", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), { inactivityMs: 50 });
    const fake = makeFakeMcpClient({ tools: {} });
    asPrivate(mesh).lazySlots.set(LAZY_MESH.linear, {
      client: fake as unknown as import("@mastra/mcp").MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });

    // Stop the slot directly via stopExtensionClient (which routes through
    // stopLazyClient via stopUserMcpClient + the bare-key path). The slot
    // is not under a user-mesh prefix or extension id we registered, so we
    // also exercise stopLazyClient through disconnect() at the end.
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

    // Simulate an in-flight tool call.
    drain.bump();

    const stopP = mesh.disconnect();
    // The disconnect should be pending until we drop().
    // Give the event loop a tick.
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

    // Must not throw despite the underlying disconnect failure.
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
    // disconnect() iterates lazySlots, and stopLazyClient bumps the epoch
    // whenever it tore down a non-undefined client.
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
    // The slot is removed after teardown (no idleTimer pending).
    expect(asPrivate(mesh).lazySlots.has(userMcpMeshKey(extId))).toBe(false);
    // Mark mesh as already disconnected so afterEach does not re-disconnect.
    mesh = undefined;
  });
});

// ─── ensureUserMcpRunning happy path (uses real user-mcp module) ──────────

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

    // A slot was registered under the user-mesh key.
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
    // No slot was ever populated (no setLazyClient call).
    expect(mesh.getToolsEpoch()).toBe(epochBefore);
  });
});
