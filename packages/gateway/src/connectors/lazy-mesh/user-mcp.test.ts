/**
 * Direct unit tests for `connectors/lazy-mesh/user-mcp.ts` — covers the
 * `recordArgsJsonFailure` failure-recorder and `ensureUserMcpClient`
 * early-return branches without going through `LazyConnectorMesh`.
 *
 * The successful spawn path (which constructs a real `MCPClient`) is
 * covered by `lazy-mesh.test.ts` / `connector-spawns.test.ts`; here we
 * focus on the error / no-op branches that drive the watermark above 80%.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../../index/local-index.ts";
import { getConnectorHealth } from "../health.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import type { MeshLogger, MeshSpawnContext } from "./slot.ts";
import { ensureUserMcpClient, recordArgsJsonFailure } from "./user-mcp.ts";

// ─── Test fixtures ───────────────────────────────────────────────────────────

type WarnRecord = { bindings: Record<string, unknown>; msg: string | undefined };

interface SpyCallRecord {
  clearLazyIdle: string[];
  getLazyClient: string[];
  setLazyClient: Array<{ key: string; client: unknown }>;
  bumpToolsEpoch: number;
  scheduleLazyDisconnect: string[];
}

interface SpyContext {
  ctx: MeshSpawnContext;
  warns: WarnRecord[];
  calls: SpyCallRecord;
  healthDb: Database | undefined;
}

function makeSpyContext(
  opts: { withLogger?: boolean; withHealthDb?: boolean; existingClient?: unknown } = {},
): SpyContext {
  const warns: WarnRecord[] = [];
  const calls: SpyCallRecord = {
    clearLazyIdle: [],
    getLazyClient: [],
    setLazyClient: [],
    bumpToolsEpoch: 0,
    scheduleLazyDisconnect: [],
  };

  const stubVault = {
    async get(): Promise<string | null> {
      return null;
    },
    async set(): Promise<void> {},
    async delete(): Promise<void> {},
    async listKeys(): Promise<string[]> {
      return [];
    },
  };

  let healthDb: Database | undefined;
  if (opts.withHealthDb === true) {
    healthDb = new Database(":memory:");
    LocalIndex.ensureSchema(healthDb);
  }

  const logger: MeshLogger | undefined =
    opts.withLogger === true
      ? {
          warn: (b: Record<string, unknown>, m?: string): void => {
            warns.push({ bindings: b, msg: m });
          },
        }
      : undefined;

  const ctx: MeshSpawnContext = {
    vault: stubVault,
    ...(logger === undefined ? {} : { logger }),
    ...(healthDb === undefined ? {} : { healthDb }),
    obsidianVaultPaths: undefined,
    sandboxCwd: "/tmp/sandbox-test-cwd",
    clearLazyIdle: (key: string): void => {
      calls.clearLazyIdle.push(key);
    },
    getLazyClient: (key: string): never | undefined => {
      calls.getLazyClient.push(key);
      // Return the configured "existing client" sentinel without forcing
      // a real MCPClient instance — `ensureUserMcpClient` only checks for
      // `!== undefined`.
      return opts.existingClient as never | undefined;
    },
    setLazyClient: (key: string, client: never): void => {
      calls.setLazyClient.push({ key, client });
    },
    bumpToolsEpoch: (): void => {
      calls.bumpToolsEpoch += 1;
    },
    scheduleLazyDisconnect: (key: string): void => {
      calls.scheduleLazyDisconnect.push(key);
    },
  };

  return { ctx, warns, calls, healthDb };
}

function makeRow(overrides: Partial<UserMcpConnectorRow> = {}): UserMcpConnectorRow {
  return {
    service_id: "mcp_test_svc",
    command: "/bin/echo",
    args_json: '["hello"]',
    created_at: 0,
    ...overrides,
  };
}

// ─── recordArgsJsonFailure ───────────────────────────────────────────────────

describe("recordArgsJsonFailure — branch coverage", () => {
  test("with logger AND healthDb: warns and transitions health to error", () => {
    const { ctx, warns, healthDb } = makeSpyContext({
      withLogger: true,
      withHealthDb: true,
    });

    recordArgsJsonFailure(ctx, "broken-svc", "expected string array");

    expect(warns.length).toBe(1);
    expect(warns[0]?.bindings["serviceId"]).toBe("broken-svc");
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(warns[0]?.msg).toMatch(/args_json/);

    if (healthDb === undefined) throw new Error("healthDb should be defined");
    const snap = getConnectorHealth(healthDb, "broken-svc");
    // `persistent_error` transitions to the `error` state.
    expect(snap.state).toBe("error");
    expect(snap.lastError ?? "").toMatch(/expected string array/);

    healthDb.close();
  });

  test("with logger only (no healthDb): warns and does NOT throw", () => {
    const { ctx, warns, healthDb } = makeSpyContext({
      withLogger: true,
      withHealthDb: false,
    });

    recordArgsJsonFailure(ctx, "no-db-svc", "JSON parse failed");

    expect(warns.length).toBe(1);
    expect(warns[0]?.bindings["serviceId"]).toBe("no-db-svc");
    expect(warns[0]?.bindings["reason"]).toBe("JSON parse failed");
    expect(healthDb).toBeUndefined();
  });

  test("with no logger AND no healthDb: silent path, no throws", () => {
    const { ctx, warns, healthDb } = makeSpyContext({
      withLogger: false,
      withHealthDb: false,
    });

    expect(() => {
      recordArgsJsonFailure(ctx, "silent-svc", "JSON parse failed");
    }).not.toThrow();
    expect(warns.length).toBe(0);
    expect(healthDb).toBeUndefined();
  });

  test("with healthDb only (no logger): transitions health silently", () => {
    const { ctx, warns, healthDb } = makeSpyContext({
      withLogger: false,
      withHealthDb: true,
    });

    recordArgsJsonFailure(ctx, "db-only-svc", "expected string array");

    expect(warns.length).toBe(0);
    if (healthDb === undefined) throw new Error("healthDb should be defined");
    const snap = getConnectorHealth(healthDb, "db-only-svc");
    expect(snap.state).toBe("error");

    healthDb.close();
  });
});

// ─── ensureUserMcpClient — early-return + failure branches ──────────────────

describe("ensureUserMcpClient — args_json failures", () => {
  test("args_json is not JSON → records 'JSON parse failed', no client created", async () => {
    const { ctx, warns, calls, healthDb } = makeSpyContext({
      withLogger: true,
      withHealthDb: true,
    });
    const row = makeRow({ service_id: "mcp_parse_fail", args_json: "not-json" });

    await ensureUserMcpClient(ctx, row);

    // Verify failure recording
    expect(warns.length).toBe(1);
    expect(warns[0]?.bindings["serviceId"]).toBe("mcp_parse_fail");
    expect(warns[0]?.bindings["reason"]).toBe("JSON parse failed");

    // Verify no client created
    expect(calls.setLazyClient.length).toBe(0);
    expect(calls.bumpToolsEpoch).toBe(0);

    // Verify early slot bookkeeping still ran
    expect(calls.clearLazyIdle.length).toBe(1);
    expect(calls.clearLazyIdle[0]).toBe("mesh:user:mcp_parse_fail");
    expect(calls.getLazyClient.length).toBe(1);

    // Verify scheduleLazyDisconnect NOT called on the failure path
    // (only the early "already-running" return path schedules a disconnect)
    expect(calls.scheduleLazyDisconnect.length).toBe(0);

    if (healthDb === undefined) throw new Error("healthDb should be defined");
    const snap = getConnectorHealth(healthDb, "mcp_parse_fail");
    expect(snap.state).toBe("error");
    healthDb.close();
  });

  test("args_json parses but is a bare string → records 'expected string array'", async () => {
    const { ctx, warns, calls, healthDb } = makeSpyContext({
      withLogger: true,
      withHealthDb: true,
    });
    const row = makeRow({
      service_id: "mcp_bare_string",
      args_json: '"a string"',
    });

    await ensureUserMcpClient(ctx, row);

    expect(warns.length).toBe(1);
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(calls.setLazyClient.length).toBe(0);
    expect(calls.bumpToolsEpoch).toBe(0);

    if (healthDb === undefined) throw new Error("healthDb should be defined");
    const snap = getConnectorHealth(healthDb, "mcp_bare_string");
    expect(snap.state).toBe("error");
    healthDb.close();
  });

  test("args_json parses to an array of non-strings → records 'expected string array'", async () => {
    const { ctx, warns, calls } = makeSpyContext({
      withLogger: true,
      withHealthDb: false,
    });
    const row = makeRow({
      service_id: "mcp_num_array",
      args_json: "[1, 2, 3]",
    });

    await ensureUserMcpClient(ctx, row);

    expect(warns.length).toBe(1);
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(calls.setLazyClient.length).toBe(0);
    expect(calls.bumpToolsEpoch).toBe(0);
  });

  test("args_json parses to mixed strings + numbers → records 'expected string array'", async () => {
    const { ctx, warns, calls } = makeSpyContext({
      withLogger: true,
      withHealthDb: false,
    });
    const row = makeRow({
      service_id: "mcp_mixed_array",
      args_json: '["ok", 42]',
    });

    await ensureUserMcpClient(ctx, row);

    expect(warns.length).toBe(1);
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(calls.setLazyClient.length).toBe(0);
  });

  test("args_json parses to {} object → records 'expected string array'", async () => {
    const { ctx, warns, calls } = makeSpyContext({
      withLogger: true,
      withHealthDb: false,
    });
    const row = makeRow({
      service_id: "mcp_obj",
      args_json: '{"not":"an array"}',
    });

    await ensureUserMcpClient(ctx, row);

    expect(warns.length).toBe(1);
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(calls.setLazyClient.length).toBe(0);
  });
});

describe("ensureUserMcpClient — early-return when client already exists", () => {
  test("existing client → scheduleLazyDisconnect called, no new client created", async () => {
    const sentinel = { __isExistingClient: true };
    const { ctx, calls, warns } = makeSpyContext({
      withLogger: true,
      withHealthDb: false,
      existingClient: sentinel,
    });
    const row = makeRow({
      service_id: "mcp_exists",
      // Even valid args_json must not be used — we return before parse.
      args_json: '["valid", "args"]',
    });

    await ensureUserMcpClient(ctx, row);

    // Verify early-return behavior:
    //   - clearLazyIdle invoked once with the mesh key
    //   - getLazyClient invoked once and returned the sentinel
    //   - scheduleLazyDisconnect invoked once (the "extend liveness" call
    //     in the early-return branch)
    //   - no setLazyClient, no bumpToolsEpoch (we never built a new client)
    expect(calls.clearLazyIdle).toEqual(["mesh:user:mcp_exists"]);
    expect(calls.getLazyClient).toEqual(["mesh:user:mcp_exists"]);
    expect(calls.scheduleLazyDisconnect).toEqual(["mesh:user:mcp_exists"]);
    expect(calls.setLazyClient.length).toBe(0);
    expect(calls.bumpToolsEpoch).toBe(0);

    // No failure recording either.
    expect(warns.length).toBe(0);
  });

  test("existing client + malformed args_json → STILL returns early (early-return precedes parse)", async () => {
    // This locks in the invariant that the early-return for an existing
    // client short-circuits BEFORE args_json is touched — otherwise an
    // already-running connector could be spuriously transitioned to
    // `persistent_error` if someone later edits its row to broken args_json.
    const sentinel = { __isExistingClient: true };
    const { ctx, calls, warns, healthDb } = makeSpyContext({
      withLogger: true,
      withHealthDb: true,
      existingClient: sentinel,
    });
    const row = makeRow({
      service_id: "mcp_exists_broken",
      args_json: "this is not json at all",
    });

    await ensureUserMcpClient(ctx, row);

    expect(calls.scheduleLazyDisconnect).toEqual(["mesh:user:mcp_exists_broken"]);
    expect(calls.setLazyClient.length).toBe(0);
    // No failure recording — we never reached the parse step.
    expect(warns.length).toBe(0);
    if (healthDb === undefined) throw new Error("healthDb should be defined");
    const snap = getConnectorHealth(healthDb, "mcp_exists_broken");
    // No health transition occurred — snapshot stays at default `healthy`
    // (the `sync_state` row is created by transitionHealth, so absent ⇒
    // buildSnapshot returns default healthy).
    expect(snap.state).toBe("healthy");
    healthDb.close();
  });
});

describe("ensureUserMcpClient — successful path (constructs MCPClient lazily)", () => {
  test("valid args_json + no existing client → setLazyClient + bumpToolsEpoch", async () => {
    // This test exercises the `userMcpDefaultManifest` + `wrapServerSpec`
    // + `new MCPClient(...)` lines. The MCPClient is constructed lazily —
    // no subprocess actually spawns until tools are requested — so this
    // is cheap and safe in a unit test.
    const { ctx, calls, warns } = makeSpyContext({
      withLogger: true,
      withHealthDb: false,
    });
    const row = makeRow({
      service_id: "mcp_ok",
      command: "/bin/echo",
      args_json: '["one", "two"]',
    });

    await ensureUserMcpClient(ctx, row);

    // Verify the success path ran end-to-end:
    expect(calls.setLazyClient.length).toBe(1);
    expect(calls.setLazyClient[0]?.key).toBe("mesh:user:mcp_ok");
    expect(calls.setLazyClient[0]?.client).toBeDefined();
    expect(calls.bumpToolsEpoch).toBe(1);
    expect(calls.scheduleLazyDisconnect).toEqual(["mesh:user:mcp_ok"]);

    // And no failure was recorded.
    expect(warns.length).toBe(0);
  });

  test("service_id with non-alphanumeric chars gets sanitized to MCP server key", async () => {
    // mcpServerKeyForUserConnector replaces non-[a-zA-Z0-9_-] with "_".
    // Exercises the regex branch even though the result is internal.
    const { ctx, calls, warns } = makeSpyContext({
      withLogger: false,
      withHealthDb: false,
    });
    const row = makeRow({
      service_id: "mcp_with.dots+plus",
      command: "/bin/echo",
      args_json: "[]",
    });

    await ensureUserMcpClient(ctx, row);

    expect(calls.setLazyClient.length).toBe(1);
    expect(calls.setLazyClient[0]?.key).toBe("mesh:user:mcp_with.dots+plus");
    expect(calls.bumpToolsEpoch).toBe(1);
    expect(warns.length).toBe(0);
  });
});
