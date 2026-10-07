/**
 * `connector.addMcp` resolves and validates BEFORE the owner is prompted, so the HITL gate (and
 * through it the consent prompt, the audit row and the I29 egress row) carries the FINAL values the
 * row will store — absolute command, canonical read paths, normalised hosts — and an invalid
 * request never reaches the gate at all.
 *
 * `which`/`realpath` are injected through the dispatcher's test seams (DI, never `mock.module`), so
 * nothing here touches the real filesystem or PATH.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LazyConnectorMesh } from "../connectors/lazy-mesh/mesh.ts";
import type { ResolvedUserMcpRegistration } from "../connectors/user-mcp-registration.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  buildAddMcpConsentPayload,
  ConnectorRpcError,
  dispatchConnectorRpc,
} from "./connector-rpc.ts";
import { defaultUserMcpRealpath, defaultUserMcpWhich } from "./connector-rpc-handlers/config.ts";

const WIN_NETWORK_NOTE =
  "Windows AppContainer network access is all-or-nothing (internetClient): this server can reach any host, not only the ones listed.";

let db: Database;
let localIndex: LocalIndex;
let vault: NimbusVault;

// Never created on disk: the fake realpath knows these spellings and nothing else.
const fakeRoot = join(tmpdir(), "nimbus-addmcp-fake");
const dataDir = join(fakeRoot, "data");
const configDir = join(fakeRoot, "config");
const sandboxDir = join(fakeRoot, "sandbox");
const notesDir = join(fakeRoot, "notes");
const nodeBin = join(fakeRoot, "bin", "node");
const known = new Set([dataDir, configDir, sandboxDir, notesDir, nodeBin]);

function fakeRealpath(p: string): string {
  if (known.has(p)) return p;
  throw new Error(`ENOENT: ${p}`);
}
function fakeWhich(cmd: string): string | null {
  return cmd === "node" ? nodeBin : cmd;
}

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  vault = createMockVault();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

type GateResult = "proceed" | { status: "rejected"; reason: string };

function stubExecutor(result: GateResult): {
  exec: ToolExecutor;
  calls: Array<{ type: string; payload: unknown }>;
} {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const exec = {
    async gate(args: { type: string; payload?: unknown }): Promise<GateResult> {
      calls.push({ type: args.type, payload: args.payload });
      return result;
    },
  } as unknown as ToolExecutor;
  return { exec, calls };
}

/** The sandbox-leaf half of the mesh; the default stub reports every leaf already clean. */
type SandboxSeam = Pick<LazyConnectorMesh, "ensureUserMcpSandboxClean" | "userMcpSandboxLeaf">;
const CLEAN_SANDBOX: SandboxSeam = {
  ensureUserMcpSandboxClean: async () => true,
  userMcpSandboxLeaf: (id: string) => join(sandboxDir, `user_${id}`),
};

function opts(exec: ToolExecutor, registered: string[] = [], sandbox: SandboxSeam = CLEAN_SANDBOX) {
  return {
    // The fake paths are built with the host's `join`, so the host platform is the one they match.
    platform: process.platform,
    vault,
    localIndex,
    openUrl: async (_u: string): Promise<void> => {},
    syncScheduler: {
      register: (s: { serviceId: string }) => {
        registered.push(s.serviceId);
      },
    } as never,
    connectorMesh: {
      ensureUserMcpRunning: async () => {},
      userMcpProtectedRoots: () => [dataDir, configDir, sandboxDir],
      ensureUserMcpSandboxClean: (id: string) => sandbox.ensureUserMcpSandboxClean(id),
      userMcpSandboxLeaf: (id: string) => sandbox.userMcpSandboxLeaf(id),
    } as never,
    toolExecutor: exec,
    resolveCommand: fakeWhich,
    realpath: fakeRealpath,
  };
}

type StoredRow = {
  command: string;
  args_json: string;
  read_paths_json: string;
  net_hosts_json: string;
  model_access: number;
};

function rowOf(id: string): StoredRow | null {
  return db
    .query(
      "SELECT command, args_json, read_paths_json, net_hosts_json, model_access FROM user_mcp_connector WHERE service_id = ?",
    )
    .get(id) as StoredRow | null;
}

async function rpcErrorOf(p: Promise<unknown>): Promise<ConnectorRpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConnectorRpcError) return e;
    throw e;
  }
  throw new Error("expected a ConnectorRpcError");
}

describe("connector.addMcp — argv is stored verbatim", () => {
  test("a command path containing a space stays ONE token", async () => {
    const { exec } = stubExecutor("proceed");
    const cmd = "C:\\Users\\Jane Doe\\x.exe";
    known.add(cmd);
    try {
      const r = await dispatchConnectorRpc({
        ...opts(exec),
        method: "connector.addMcp",
        params: { serviceId: "mcp_spaced", argv: [cmd] },
      });
      expect(r).toEqual({ kind: "hit", value: { ok: true, serviceId: "mcp_spaced" } });
    } finally {
      known.delete(cmd);
    }
    const row = rowOf("mcp_spaced");
    expect(row?.command).toBe(cmd);
    expect(row?.args_json).toBe("[]");
  });
});

describe("connector.addMcp — invalid requests never reach the gate", () => {
  test("a read path inside dataDir is refused with ERR_USER_MCP_READ_PATH_PROTECTED, no consent asked", async () => {
    const inside = join(dataDir, "nimbus.db");
    known.add(inside);
    const { exec, calls } = stubExecutor("proceed");
    try {
      const err = await rpcErrorOf(
        dispatchConnectorRpc({
          ...opts(exec),
          method: "connector.addMcp",
          params: { serviceId: "mcp_snoop", argv: ["node", "s.js"], readPaths: [inside] },
        }),
      );
      expect(err.rpcCode).toBe(-32602);
      expect(err.message.startsWith("ERR_USER_MCP_READ_PATH_PROTECTED")).toBe(true);
    } finally {
      known.delete(inside);
    }
    expect(calls).toHaveLength(0);
    expect(rowOf("mcp_snoop")).toBeNull();
  });

  test.each([
    ["both argv and commandLine", { argv: ["node"], commandLine: "node" }],
    ["neither argv nor commandLine", {}],
    ["argv not a string array", { argv: ["node", 3] }],
    ["readPaths not a string array", { argv: ["node"], readPaths: "x" }],
    ["netHosts not a string array", { argv: ["node"], netHosts: [1] }],
    ["modelAccess not a boolean", { argv: ["node"], modelAccess: "yes" }],
    ["unknown command", { argv: ["no-such-binary-xyz"] }],
    ["invalid host", { argv: ["node"], netHosts: ["https://x.example.com/"] }],
  ])("%s -> -32602 and the gate is never called", async (_label, extra) => {
    const { exec, calls } = stubExecutor("proceed");
    const err = await rpcErrorOf(
      dispatchConnectorRpc({
        ...opts(exec),
        resolveCommand: (c: string) => (c === "node" ? nodeBin : null),
        method: "connector.addMcp",
        params: { serviceId: "mcp_bad", ...extra },
      }),
    );
    expect(err.rpcCode).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("a built-in id and an invalid id are refused before the gate", async () => {
    const { exec, calls } = stubExecutor("proceed");
    for (const serviceId of ["github", "not-mcp"]) {
      const err = await rpcErrorOf(
        dispatchConnectorRpc({
          ...opts(exec),
          method: "connector.addMcp",
          params: { serviceId, argv: ["node"] },
        }),
      );
      expect(err.rpcCode).toBe(-32602);
    }
    expect(calls).toHaveLength(0);
  });

  test("a missing connector mesh is -32603 before the gate", async () => {
    const { exec, calls } = stubExecutor("proceed");
    const { connectorMesh: _omit, ...rest } = opts(exec);
    const err = await rpcErrorOf(
      dispatchConnectorRpc({
        ...rest,
        method: "connector.addMcp",
        params: { serviceId: "mcp_x", argv: ["node"] },
      }),
    );
    expect(err.rpcCode).toBe(-32603);
    expect(calls).toHaveLength(0);
  });
});

describe("connector.addMcp — the owner approves the resolved grants", () => {
  const params = {
    serviceId: "MCP_Notes",
    argv: ["node", "server.js", "--stdio"],
    readPaths: [notesDir],
    netHosts: ["API.Example.com:443"],
    modelAccess: true,
  };
  const expectedReadPaths =
    process.platform === "win32" ? [notesDir] : [notesDir, dirname(nodeBin)];
  const expectedPayload: Record<string, unknown> = {
    serviceId: "mcp_notes",
    command: nodeBin,
    args: ["server.js", "--stdio"],
    readPaths: expectedReadPaths,
    netHosts: ["api.example.com:443"],
    modelAccess: true,
    ...(process.platform === "win32" ? { networkNote: WIN_NETWORK_NOTE } : {}),
  };

  test("the gate is called once with exactly the resolved payload; approval stores the grants", async () => {
    const { exec, calls } = stubExecutor("proceed");
    const registered: string[] = [];
    const r = await dispatchConnectorRpc({
      ...opts(exec, registered),
      method: "connector.addMcp",
      params,
    });
    expect(r).toEqual({ kind: "hit", value: { ok: true, serviceId: "mcp_notes" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe("connector.addMcp");
    // JSON round-trip: the transform the audit and egress sinks apply (#808).
    expect(JSON.parse(JSON.stringify(calls[0]?.payload))).toEqual(expectedPayload);
    expect(rowOf("mcp_notes")).toEqual({
      command: nodeBin,
      args_json: JSON.stringify(["server.js", "--stdio"]),
      read_paths_json: JSON.stringify(expectedReadPaths),
      net_hosts_json: JSON.stringify(["api.example.com:443"]),
      model_access: 1,
    });
    expect(registered).toEqual(["mcp_notes"]);
  });

  test("rejection stores nothing and registers nothing", async () => {
    const { exec, calls } = stubExecutor({ status: "rejected", reason: "no" });
    const registered: string[] = [];
    const r = await dispatchConnectorRpc({
      ...opts(exec, registered),
      method: "connector.addMcp",
      params,
    });
    expect(r).toEqual({ kind: "hit", value: { status: "rejected", reason: "no" } });
    expect(calls).toHaveLength(1);
    expect(rowOf("mcp_notes")).toBeNull();
    expect(registered).toEqual([]);
  });

  test("no networkNote without hosts, and modelAccess defaults to false", async () => {
    const { exec, calls } = stubExecutor("proceed");
    await dispatchConnectorRpc({
      ...opts(exec),
      method: "connector.addMcp",
      params: { serviceId: "mcp_quiet", argv: ["node"] },
    });
    const payload = calls[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["args", "command", "modelAccess", "netHosts", "readPaths", "serviceId"].sort(),
    );
    expect(payload["modelAccess"]).toBe(false);
    expect(rowOf("mcp_quiet")?.model_access).toBe(0);
  });

  test("commandLine is still accepted (whitespace-split, compatibility)", async () => {
    const { exec, calls } = stubExecutor("proceed");
    await dispatchConnectorRpc({
      ...opts(exec),
      method: "connector.addMcp",
      params: { serviceId: "mcp_legacy", commandLine: "node server.js" },
    });
    const legacy = calls[0]?.payload as Record<string, unknown>;
    expect(legacy["command"]).toBe(nodeBin);
    expect(rowOf("mcp_legacy")?.args_json).toBe(JSON.stringify(["server.js"]));
  });
});

describe("connector.addMcp — a sandbox leaf left by an earlier registration", () => {
  // A REAL mesh over a temp sandbox root supplies the clear-or-refuse step; everything else stays
  // faked. `removeUserMcpSandbox` is best-effort, so a lock can leave the deterministic leaf behind.
  const realRoots: string[] = [];
  const realMeshes: LazyConnectorMesh[] = [];
  afterEach(async () => {
    for (const m of realMeshes.splice(0)) await m.disconnect();
    for (const r of realRoots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function realMesh(removeSandboxDir?: (dir: string) => void): LazyConnectorMesh {
    const root = mkdtempSync(join(tmpdir(), "nimbus-addmcp-sbx-"));
    realRoots.push(root);
    const mesh = new LazyConnectorMesh(
      {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        logDir: join(root, "log"),
        socketPath: join(root, "sock"),
        extensionsDir: join(root, "ext"),
        tempDir: join(root, "tmp"),
        sandboxDir: join(root, "sandbox"),
      },
      createMockVault(),
      removeSandboxDir === undefined ? {} : { removeSandboxDir },
    );
    realMeshes.push(mesh);
    return mesh;
  }

  test("a stale leaf holding a file is cleared after approval, then the row is stored", async () => {
    const mesh = realMesh();
    const leaf = mesh.userMcpSandboxLeaf("mcp_reused");
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, "left-behind.txt"), "the previous registration's data");
    const { exec, calls } = stubExecutor("proceed");
    const registered: string[] = [];
    const r = await dispatchConnectorRpc({
      ...opts(exec, registered, mesh),
      method: "connector.addMcp",
      params: { serviceId: "mcp_reused", argv: ["node"] },
    });
    expect(r).toEqual({ kind: "hit", value: { ok: true, serviceId: "mcp_reused" } });
    expect(calls).toHaveLength(1);
    expect(existsSync(leaf)).toBe(false);
    expect(rowOf("mcp_reused")).not.toBeNull();
    expect(registered).toEqual(["mcp_reused"]);
  });

  test("a leaf that cannot be cleared REFUSES after approval: no row, nothing registered", async () => {
    const mesh = realMesh(() => {
      throw new Error("EBUSY: resource busy or locked");
    });
    const leaf = mesh.userMcpSandboxLeaf("mcp_locked");
    mkdirSync(leaf, { recursive: true });
    const { exec, calls } = stubExecutor("proceed");
    const registered: string[] = [];
    const err = await rpcErrorOf(
      dispatchConnectorRpc({
        ...opts(exec, registered, mesh),
        method: "connector.addMcp",
        params: { serviceId: "mcp_locked", argv: ["node"] },
      }),
    );
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe(
      `ERR_USER_MCP_SANDBOX_NOT_CLEAN: ${leaf} could not be cleared; stop any process using it and retry`,
    );
    expect(calls).toHaveLength(1); // the owner WAS asked; the refusal comes after the gate
    expect(rowOf("mcp_locked")).toBeNull();
    expect(registered).toEqual([]);
  });

  test("no leftover leaf: nothing is deleted and the row is stored", async () => {
    const deleted: string[] = [];
    const mesh = realMesh((dir) => {
      deleted.push(dir);
    });
    const { exec } = stubExecutor("proceed");
    const r = await dispatchConnectorRpc({
      ...opts(exec, [], mesh),
      method: "connector.addMcp",
      params: { serviceId: "mcp_fresh", argv: ["node"] },
    });
    expect(r).toEqual({ kind: "hit", value: { ok: true, serviceId: "mcp_fresh" } });
    expect(deleted).toEqual([]);
    expect(rowOf("mcp_fresh")).not.toBeNull();
  });

  test("a rejected gate never touches the leaf", async () => {
    const mesh = realMesh();
    const leaf = mesh.userMcpSandboxLeaf("mcp_denied");
    mkdirSync(leaf, { recursive: true });
    const { exec } = stubExecutor({ status: "rejected", reason: "no" });
    await dispatchConnectorRpc({
      ...opts(exec, [], mesh),
      method: "connector.addMcp",
      params: { serviceId: "mcp_denied", argv: ["node"] },
    });
    expect(existsSync(leaf)).toBe(true);
  });
});

describe("buildAddMcpConsentPayload — the platform is passed in, not read", () => {
  const resolved: ResolvedUserMcpRegistration = {
    serviceId: "mcp_net",
    command: "/opt/bin/node",
    args: [],
    readPaths: [],
    netHosts: ["api.example.com"],
    modelAccess: false,
  };

  test("win32 with hosts carries the all-or-nothing network note", () => {
    expect(buildAddMcpConsentPayload(resolved, "win32")["networkNote"]).toBe(WIN_NETWORK_NOTE);
  });

  test("win32 without hosts carries no note", () => {
    const payload = buildAddMcpConsentPayload({ ...resolved, netHosts: [] }, "win32");
    expect("networkNote" in payload).toBe(false);
  });

  test("linux with hosts carries no note", () => {
    expect("networkNote" in buildAddMcpConsentPayload(resolved, "linux")).toBe(false);
  });
});

describe("connector.addMcp — no platform", () => {
  test("refuses -32603 before the gate rather than guessing the host OS", async () => {
    const { exec, calls } = stubExecutor("proceed");
    const { platform: _omit, ...rest } = opts(exec);
    const err = await rpcErrorOf(
      dispatchConnectorRpc({
        ...rest,
        method: "connector.addMcp",
        params: { serviceId: "mcp_x", argv: ["node"] },
      }),
    );
    expect(err.rpcCode).toBe(-32603);
    expect(calls).toHaveLength(0);
  });
});

describe("connector.addMcp — production seam defaults", () => {
  test("realpath defaults to realpathSync.native and which to Bun.which", () => {
    // The JS `realpathSync` keeps the caller's spelling: it does not return the on-disk case on a
    // case-insensitive volume (APFS, NTFS) nor expand Windows 8.3 short names, so a protected
    // folder could be named past the overlap check. Pinned by identity because the native
    // behaviour cannot be exercised portably; the case-folding test below covers it where it can.
    expect(defaultUserMcpRealpath).toBe(realpathSync.native);
    expect(defaultUserMcpWhich).toBe(Bun.which);
  });

  test("on a case-insensitive volume the default returns the ON-DISK case", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-addmcp-case-"));
    try {
      const real = join(root, "CaseDir");
      mkdirSync(real);
      const asked = join(root, "casedir");
      let caseInsensitive = true;
      try {
        realpathSync(asked);
      } catch {
        caseInsensitive = false;
      }
      // Self-validating: on a case-sensitive volume the premise does not hold, so there is
      // nothing to assert beyond the identity pin above.
      if (!caseInsensitive) return;
      expect(basename(defaultUserMcpRealpath(asked))).toBe("CaseDir");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
