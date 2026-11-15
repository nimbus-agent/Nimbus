/**
 * The mesh's half of a user MCP write grant (I15; Phase 28 AD5b-2): the spawn preparation it runs
 * before any client exists, the Windows ledger at removal and for orphans, and the reverse rule it
 * gives the iac directory approval. Real temp directories; the Windows revoker and the ledger are
 * fakes, so every OS runs every case.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import { approveWorkdir, IAC_WORKDIR_REFUSALS } from "../connector-writes/iac-grants.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import { LazyConnectorMesh } from "./mesh.ts";
import type { UserMcpGrantLedgerStore, UserMcpLedgerEntry } from "./user-mcp-write-grant.ts";

const roots: string[] = [];
const meshes: LazyConnectorMesh[] = [];

function makeRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-mesh-write-")));
  roots.push(root);
  return root;
}

function pathsUnder(root: string): PlatformPaths {
  return {
    configDir: join(root, "nimbus", "config"),
    dataDir: join(root, "nimbus", "data"),
    logDir: join(root, "nimbus", "log"),
    socketPath: join(root, "nimbus", "sock"),
    extensionsDir: join(root, "nimbus", "ext"),
    tempDir: join(root, "nimbus", "tmp"),
    sandboxDir: join(root, "nimbus", "cache", "sandbox"),
  };
}

function row(over: Partial<UserMcpConnectorRow> = {}): UserMcpConnectorRow {
  return {
    service_id: "mcp_notes",
    command: process.execPath,
    args_json: "[]",
    created_at: 1,
    read_paths_json: "[]",
    net_hosts_json: "[]",
    model_access: 0,
    write_paths_json: "[]",
    ...over,
  };
}

/** A ledger from plain path lists: every listed path read-only unless named in `write`. */
function ledgerOf(
  simple: Record<string, readonly string[]>,
  write: Record<string, readonly string[]> = {},
): Record<string, UserMcpLedgerEntry> {
  return Object.fromEntries(
    Object.entries(simple).map(([id, paths]) => [id, { paths, writable: write[id] ?? [] }]),
  );
}

interface Seams {
  readonly calls: string[];
  readonly warns: Array<{ reason?: unknown; msg: string }>;
  readonly ledger: { all: Record<string, UserMcpLedgerEntry> };
}

function build(
  root: string,
  rows: UserMcpConnectorRow[],
  over: {
    canConfine?: ((p: unknown) => string | null) | "absent";
    active?: boolean;
    ledger?: Record<string, readonly string[]>;
    revokeThrows?: boolean;
  } = {},
): { mesh: LazyConnectorMesh } & Seams {
  const calls: string[] = [];
  const warns: Seams["warns"] = [];
  const ledger = { all: ledgerOf(over.ledger ?? {}) };
  const store: UserMcpGrantLedgerStore = {
    load: () => ledger.all,
    save: (all) => {
      calls.push(`save ${JSON.stringify(all)}`);
      ledger.all = { ...all };
    },
  };
  const mesh = new LazyConnectorMesh(pathsUnder(root), createMockVault(), {
    listUserMcpConnectors: () => rows,
    logger: {
      warn: (obj: Record<string, unknown>, msg: string) =>
        warns.push({ reason: obj["reason"], msg }),
    } as never,
    userMcpGrantLedger: store,
    userMcpGrantRevokerFor: (policyId) => ({
      active: over.active === true,
      revoke: (paths) => {
        calls.push(`revoke ${policyId} ${JSON.stringify(paths)}`);
        return over.revokeThrows === true ? Promise.reject(new Error("helper")) : Promise.resolve();
      },
    }),
    // The gateway's own PATH and home are not what these cases are about.
    userMcpWriteDirDeps: { pathEntries: [], appDataDirs: [], homeDir: join(root, "home") },
    ...(over.canConfine === "absent" ? {} : { userMcpCanConfine: over.canConfine ?? (() => null) }),
  });
  meshes.push(mesh);
  return { mesh, calls, warns, ledger };
}

afterEach(async () => {
  for (const m of meshes.splice(0)) await m.disconnect();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("the spawn preparation of a user MCP server with a write directory", () => {
  test("a clean directory is prepared: nothing is refused, and on Windows its paths are recorded before any client", async () => {
    const root = makeRoot();
    const out = join(root, "work", "out");
    mkdirSync(out, { recursive: true });
    const s = build(root, [row({ write_paths_json: JSON.stringify([out]) })], { active: true });
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    expect(s.warns).toEqual([]);
    expect(s.calls).toEqual([
      `save ${JSON.stringify({ mcp_notes: { paths: [out], writable: [out] } })}`,
    ]);
  });

  test("a server with no write directory and no read path touches neither the helper nor the ledger", async () => {
    const root = makeRoot();
    const s = build(root, [row()], { active: true });
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    expect(s.calls).toEqual([]);
    expect(s.warns).toEqual([]);
  });

  test("a directory that gained a marker folder since registration refuses the spawn, logged once per streak", async () => {
    const root = makeRoot();
    const out = join(root, "work", "out");
    mkdirSync(join(out, ".git"), { recursive: true });
    const s = build(root, [row({ write_paths_json: JSON.stringify([out]) })], { active: true });
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    expect(s.warns).toHaveLength(1);
    expect(String(s.warns[0]?.reason)).toContain("marker folder");
    // Refused before the ledger: nothing was recorded, so nothing can be granted.
    expect(s.calls).toEqual([]);
  });

  test("a directory that is gone, and one inside a Nimbus folder, refuse the spawn", async () => {
    const root = makeRoot();
    const gone = join(root, "work", "gone");
    const s = build(root, [row({ write_paths_json: JSON.stringify([gone]) })]);
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    expect(String(s.warns[0]?.reason)).toContain("does not exist");

    const root2 = makeRoot();
    const inside = join(root2, "nimbus", "data", "x");
    mkdirSync(inside, { recursive: true });
    const p = build(root2, [row({ write_paths_json: JSON.stringify([inside]) })]);
    await p.mesh.ensureUserMcpRunning("mcp_notes");
    expect(String(p.warns[0]?.reason)).toContain("overlaps a folder Nimbus owns");
  });

  test("with no sandbox runner to ask, or one that cannot confine it, a write-granted server never starts", async () => {
    const root = makeRoot();
    const out = join(root, "work", "out");
    mkdirSync(out, { recursive: true });
    const rows = [row({ write_paths_json: JSON.stringify([out]) })];
    const absent = build(root, rows, { canConfine: "absent" });
    await absent.mesh.ensureUserMcpRunning("mcp_notes");
    expect(String(absent.warns[0]?.reason)).toContain("no sandbox runner");
    const root2 = makeRoot();
    const out2 = join(root2, "work", "out");
    mkdirSync(out2, { recursive: true });
    const cannot = build(root2, [row({ write_paths_json: JSON.stringify([out2]) })], {
      canConfine: () => "this OS cannot confine it",
    });
    await cannot.mesh.ensureUserMcpRunning("mcp_notes");
    expect(cannot.warns[0]?.reason).toBe("this OS cannot confine it");
  });

  test("the policy the sandbox is asked about declares the directory, readable and writable", async () => {
    const root = makeRoot();
    const out = join(root, "work", "out");
    mkdirSync(out, { recursive: true });
    const asked: unknown[] = [];
    const s = build(root, [row({ write_paths_json: JSON.stringify([out]) })], {
      canConfine: (p) => {
        asked.push(p);
        return null;
      },
    });
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    expect(asked).toEqual([
      {
        id: "user.mcp_notes",
        permissions: { network: [], filesystem: { read: [out], write: [out] } },
        canonicalWritePaths: [out],
        canonicalWriteDirs: [out],
      },
    ]);
  });

  test("another server's code inside the directory refuses the spawn (the facts are read now)", async () => {
    const root = makeRoot();
    const out = join(root, "work", "out");
    mkdirSync(out, { recursive: true });
    const other = row({ service_id: "mcp_other", command: join(out, "bin", "tool") });
    const s = build(root, [row({ write_paths_json: JSON.stringify([out]) }), other]);
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    expect(String(s.warns[0]?.reason)).toContain("code of a registered MCP server");
  });
});

describe("the Windows ledger at removal and for orphans", () => {
  test("removal revokes every recorded path of the server and drops its entry", async () => {
    const root = makeRoot();
    const s = build(root, [], {
      active: true,
      ledger: { mcp_notes: ["/data", "/out"], mcp_other: ["/x"] },
    });
    await s.mesh.removeUserMcpSandbox("mcp_notes");
    expect(s.calls).toEqual([
      'revoke user.mcp_notes ["/data","/out"]',
      `save ${JSON.stringify(ledgerOf({ mcp_other: ["/x"] }))}`,
    ]);
  });

  test("a failed revoke keeps the entry, is logged, and removal still completes", async () => {
    const root = makeRoot();
    const s = build(root, [], {
      active: true,
      revokeThrows: true,
      ledger: { mcp_notes: ["/out"] },
    });
    await s.mesh.removeUserMcpSandbox("mcp_notes");
    expect(s.ledger.all).toEqual(ledgerOf({ mcp_notes: ["/out"] }));
    expect(s.warns.map((w) => w.msg)).toContain(
      "user MCP sandbox grants not revoked; kept in the ledger",
    );
  });

  test("a registration's release revokes an UNREGISTERED id's leftovers, and never touches an id that is registered now", async () => {
    const root = makeRoot();
    const rows = [row()];
    const s = build(root, rows, {
      active: true,
      ledger: { mcp_notes: ["/live-out"], mcp_gone: ["/old-out"] },
    });
    // Registered: a second add of the same id must not cut the live registration's grants.
    expect(await s.mesh.releaseUserMcpGrantsUnlessRegistered("mcp_notes")).toBe("registered");
    expect(s.calls).toEqual([]);
    expect(Object.keys(s.ledger.all)).toContain("mcp_notes");
    // Not registered: the earlier registration's permissions are revoked and its entry dropped.
    expect(await s.mesh.releaseUserMcpGrantsUnlessRegistered("mcp_gone")).toBe(true);
    expect(s.calls[0]).toBe('revoke user.mcp_gone ["/old-out"]');
    expect(Object.keys(s.ledger.all)).not.toContain("mcp_gone");
  });

  test("that release reports false when the revoke fails, so the registration is refused", async () => {
    const root = makeRoot();
    const s = build(root, [], {
      active: true,
      revokeThrows: true,
      ledger: { mcp_gone: ["/old-out"] },
    });
    expect(await s.mesh.releaseUserMcpGrantsUnlessRegistered("mcp_gone")).toBe(false);
    expect(Object.keys(s.ledger.all)).toContain("mcp_gone");
  });

  test("before the first spawn decision, entries whose server is no longer registered are revoked, once", async () => {
    const root = makeRoot();
    const s = build(root, [row()], {
      active: true,
      ledger: { mcp_removed: ["/old-out"], mcp_notes: [] },
    });
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    expect(s.calls.filter((c) => c.startsWith("revoke"))).toEqual([
      'revoke user.mcp_removed ["/old-out"]',
    ]);
    expect(Object.keys(s.ledger.all)).not.toContain("mcp_removed");
  });

  test("off Windows nothing is revoked and nothing is recorded", async () => {
    const root = makeRoot();
    const out = join(root, "work", "out");
    mkdirSync(out, { recursive: true });
    const s = build(root, [row({ write_paths_json: JSON.stringify([out]) })], {
      ledger: { mcp_removed: ["/old"] },
    });
    await s.mesh.ensureUserMcpRunning("mcp_notes");
    await s.mesh.removeUserMcpSandbox("mcp_notes");
    expect(s.calls).toEqual([]);
  });
});

describe("the reverse rule: an iac working directory may not overlap a user MCP write directory", () => {
  test("inside one, equal to one and holding one are refused; with none registered the answer is unchanged", () => {
    const root = makeRoot();
    const out = join(root, "work", "out");
    mkdirSync(join(out, "infra"), { recursive: true });
    const rows: UserMcpConnectorRow[] = [];
    const { mesh } = build(root, rows);
    const deps = mesh.iacPathDepsForEnable();
    const none = approveWorkdir(join(out, "infra"), deps);
    expect(none).toEqual({ ok: true, path: join(out, "infra") });

    rows.push(row({ write_paths_json: JSON.stringify([out]) }));
    for (const dir of [join(out, "infra"), out, join(root, "work")]) {
      expect(approveWorkdir(dir, deps)).toEqual({
        ok: false,
        reason: IAC_WORKDIR_REFUSALS.protected,
      });
    }
    // A sibling is untouched.
    const sibling = join(root, "elsewhere");
    mkdirSync(sibling);
    expect(approveWorkdir(sibling, deps)).toEqual({ ok: true, path: sibling });
  });
});
