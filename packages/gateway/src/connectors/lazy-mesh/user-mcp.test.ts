import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndex } from "../../index/local-index.ts";
import { getConnectorHealth } from "../health.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import type { MeshLogger, MeshSpawnContext } from "./slot.ts";
import { ensureUserMcpClient, recordArgsJsonFailure } from "./user-mcp.ts";

// Real, unique temp root for the fake sandbox cwd string (S5443) — never written.
const SANDBOX_CWD = join(mkdtempSync(join(tmpdir(), "nimbus-user-mcp-test-")), "sandbox-cwd");

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
    sandboxCwd: SANDBOX_CWD,
    clearLazyIdle: (key: string): void => {
      calls.clearLazyIdle.push(key);
    },
    getLazyClient: (key: string): undefined => {
      calls.getLazyClient.push(key);
      return opts.existingClient as undefined;
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

describe("recordArgsJsonFailure — branch coverage", () => {
  test("with logger AND healthDb: warns and transitions health to error", () => {
    const { ctx, warns, healthDb } = makeSpyContext({
      withLogger: true,
      withHealthDb: true,
    });

    recordArgsJsonFailure(ctx, "broken-svc", "expected string array");

    expect(warns).toHaveLength(1);
    expect(warns[0]?.bindings["serviceId"]).toBe("broken-svc");
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(warns[0]?.msg).toMatch(/args_json/);

    if (healthDb === undefined) throw new Error("healthDb should be defined");
    const snap = getConnectorHealth(healthDb, "broken-svc");
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

    expect(warns).toHaveLength(1);
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
    expect(warns).toHaveLength(0);
    expect(healthDb).toBeUndefined();
  });

  test("with healthDb only (no logger): transitions health silently", () => {
    const { ctx, warns, healthDb } = makeSpyContext({
      withLogger: false,
      withHealthDb: true,
    });

    recordArgsJsonFailure(ctx, "db-only-svc", "expected string array");

    expect(warns).toHaveLength(0);
    if (healthDb === undefined) throw new Error("healthDb should be defined");
    const snap = getConnectorHealth(healthDb, "db-only-svc");
    expect(snap.state).toBe("error");

    healthDb.close();
  });
});

describe("ensureUserMcpClient — args_json failures", () => {
  test("args_json is not JSON → records 'JSON parse failed', no client created", async () => {
    const { ctx, warns, calls, healthDb } = makeSpyContext({
      withLogger: true,
      withHealthDb: true,
    });
    const row = makeRow({ service_id: "mcp_parse_fail", args_json: "not-json" });

    await ensureUserMcpClient(ctx, row);

    expect(warns).toHaveLength(1);
    expect(warns[0]?.bindings["serviceId"]).toBe("mcp_parse_fail");
    expect(warns[0]?.bindings["reason"]).toBe("JSON parse failed");

    expect(calls.setLazyClient).toHaveLength(0);
    expect(calls.bumpToolsEpoch).toBe(0);

    expect(calls.clearLazyIdle).toHaveLength(1);
    expect(calls.clearLazyIdle[0]).toBe("mesh:user:mcp_parse_fail");
    expect(calls.getLazyClient).toHaveLength(1);

    expect(calls.scheduleLazyDisconnect).toHaveLength(0);

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

    expect(warns).toHaveLength(1);
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(calls.setLazyClient).toHaveLength(0);
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

    expect(warns).toHaveLength(1);
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(calls.setLazyClient).toHaveLength(0);
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

    expect(warns).toHaveLength(1);
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(calls.setLazyClient).toHaveLength(0);
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

    expect(warns).toHaveLength(1);
    expect(warns[0]?.bindings["reason"]).toBe("expected string array");
    expect(calls.setLazyClient).toHaveLength(0);
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
      args_json: '["valid", "args"]',
    });

    await ensureUserMcpClient(ctx, row);

    expect(calls.clearLazyIdle).toEqual(["mesh:user:mcp_exists"]);
    expect(calls.getLazyClient).toEqual(["mesh:user:mcp_exists"]);
    expect(calls.scheduleLazyDisconnect).toEqual(["mesh:user:mcp_exists"]);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(calls.bumpToolsEpoch).toBe(0);

    expect(warns).toHaveLength(0);
  });

  test("existing client + malformed args_json → STILL returns early (early-return precedes parse)", async () => {
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
    expect(calls.setLazyClient).toHaveLength(0);
    expect(warns).toHaveLength(0);
    if (healthDb === undefined) throw new Error("healthDb should be defined");
    // The property is that NOTHING was recorded — the early return precedes the parse, so no
    // health transition happens. It used to assert `healthy`, which was true only because
    // `buildSnapshot` hard-coded that for a connector with no row (the F6 defect); the test
    // therefore agreed with the bug while appearing to check the early return.
    const snap = getConnectorHealth(healthDb, "mcp_exists_broken");
    expect(snap.state).toBe("not_configured");
    expect(snap.lastError).toBeUndefined();
    healthDb.close();
  });
});

describe("ensureUserMcpClient — successful path (constructs MCPClient lazily)", () => {
  test("valid args_json + no existing client → setLazyClient + bumpToolsEpoch", async () => {
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

    expect(calls.setLazyClient).toHaveLength(1);
    expect(calls.setLazyClient[0]?.key).toBe("mesh:user:mcp_ok");
    expect(calls.setLazyClient[0]?.client).toBeDefined();
    expect(calls.bumpToolsEpoch).toBe(1);
    expect(calls.scheduleLazyDisconnect).toEqual(["mesh:user:mcp_ok"]);

    expect(warns).toHaveLength(0);
  });

  test("service_id with non-alphanumeric chars gets sanitized to MCP server key", async () => {
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

    expect(calls.setLazyClient).toHaveLength(1);
    expect(calls.setLazyClient[0]?.key).toBe("mesh:user:mcp_with.dots+plus");
    expect(calls.bumpToolsEpoch).toBe(1);
    expect(warns).toHaveLength(0);
  });
});
