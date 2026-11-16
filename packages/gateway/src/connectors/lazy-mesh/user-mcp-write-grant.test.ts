// The one builder of a user MCP write grant (I15; Phase 28 AD5b-2): each step of the preparation,
// in order, with a spy on every later step; the Windows ledger; the manifest parts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxPolicy } from "../../platform/sandbox/sandbox-policy.ts";
import type { WriteDirScan } from "../../platform/sandbox/write-dir-scan.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import { WRITE_DIR_REFUSALS, type WriteDirDeps } from "../write-dir-rules.ts";
import {
  fileUserMcpGrantLedger,
  ledgerServiceIds,
  NO_USER_MCP_WRITE_GRANT,
  prepareUserMcpWriteGrant,
  releaseUserMcpGrants,
  storedWriteDirs,
  USER_MCP_WRITE_GRANT_REFUSALS,
  type UserMcpGrantLedgerStore,
  type UserMcpLedgerEntry,
  type UserMcpWriteGrantDeps,
  userMcpGrantLedgerFile,
  userMcpPolicyId,
  userMcpWriteManifestParts,
} from "./user-mcp-write-grant.ts";

const DIR = { isDirectory: () => true, isSymbolicLink: () => false };

/** A ledger from plain path lists: every listed path read-only unless named in `write`. */
function ledgerOf(
  simple: Record<string, readonly string[]>,
  write: Record<string, readonly string[]> = {},
): Record<string, UserMcpLedgerEntry> {
  return Object.fromEntries(
    Object.entries(simple).map(([id, paths]) => [id, { paths, writable: write[id] ?? [] }]),
  );
}

function row(over: Partial<UserMcpConnectorRow> = {}): UserMcpConnectorRow {
  return {
    service_id: "mcp_notes",
    command: "/opt/srv/bin/notes",
    args_json: "[]",
    created_at: 1,
    read_paths_json: "[]",
    net_hosts_json: "[]",
    model_access: 0,
    write_paths_json: "[]",
    ...over,
  };
}

interface Spy {
  readonly calls: string[];
  readonly deps: UserMcpWriteGrantDeps;
  readonly ledger: { all: Record<string, UserMcpLedgerEntry> };
  readonly policies: SandboxPolicy[];
}

function spy(
  over: {
    scan?: WriteDirScan;
    canConfine?: string | null;
    active?: boolean;
    ledger?: Record<string, readonly string[]>;
    /** Which of the ledger's paths were WRITE grants. */
    ledgerWrite?: Record<string, readonly string[]>;
    loadThrows?: boolean;
    saveThrows?: boolean;
    revokeThrows?: boolean;
  } = {},
): Spy {
  const calls: string[] = [];
  const policies: SandboxPolicy[] = [];
  const ledger = { all: ledgerOf(over.ledger ?? {}, over.ledgerWrite ?? {}) };
  const writeDir: WriteDirDeps = {
    platform: "linux",
    realpath: (p) => p,
    lstat: () => DIR,
    exists: () => false,
    homeDir: "/home/me",
    tmpDir: "/tmp",
    pathEntries: [],
    appDataDirs: [],
    protectedRoots: () => [],
    iacWorkdirs: () => [],
    serverCodePaths: () => [],
    scan: (dir) => {
      calls.push(`scan ${dir}`);
      return over.scan ?? "clean";
    },
  };
  const store: UserMcpGrantLedgerStore = {
    load: () => {
      calls.push("ledger.load");
      if (over.loadThrows === true) throw new Error("unreadable");
      return ledger.all;
    },
    save: (all) => {
      calls.push(`ledger.save ${JSON.stringify(all)}`);
      if (over.saveThrows === true) throw new Error("disk full");
      ledger.all = { ...all };
    },
  };
  const deps: UserMcpWriteGrantDeps = {
    writeDir,
    canConfine: (policy) => {
      calls.push("canConfine");
      policies.push(policy);
      return over.canConfine ?? null;
    },
    ledger: store,
    revokerFor: (policyId) => ({
      active: over.active === true,
      revoke: (paths) => {
        calls.push(`revoke ${policyId} ${JSON.stringify(paths)}`);
        return over.revokeThrows === true
          ? Promise.reject(new Error("helper failed"))
          : Promise.resolve();
      },
    }),
  };
  return { calls, deps, ledger, policies };
}

const OUT = "/srv/out";
const WRITES = JSON.stringify([OUT]);

describe("prepareUserMcpWriteGrant: a server with no write directory", () => {
  test("off Windows nothing is read and nothing is run: the empty grant", async () => {
    const s = spy();
    const r = await prepareUserMcpWriteGrant(row(), ["/data"], [], s.deps);
    expect(r).toEqual({ ok: true, grant: NO_USER_MCP_WRITE_GRANT });
    expect(s.calls).toEqual([]);
  });

  test("on Windows with no grant of any kind and no ledger entry: one ledger read, nothing else", async () => {
    const s = spy({ active: true });
    const r = await prepareUserMcpWriteGrant(row(), [], [], s.deps);
    expect(r).toEqual({ ok: true, grant: NO_USER_MCP_WRITE_GRANT });
    expect(s.calls).toEqual(["ledger.load"]);
  });
});

describe("prepareUserMcpWriteGrant: each step in order, and nothing after a refusal", () => {
  test("a clean directory passes: the rule, then canConfine for the exact policy, then (off Windows) nothing", async () => {
    const s = spy();
    const r = await prepareUserMcpWriteGrant(
      row({ write_paths_json: WRITES }),
      ["/data"],
      ["api.x.com"],
      s.deps,
    );
    expect(r.ok && r.grant.dirs).toEqual([OUT]);
    expect(s.calls).toEqual([`scan ${OUT}`, "canConfine"]);
    expect(s.policies).toEqual([
      {
        id: "user.mcp_notes",
        permissions: {
          network: ["api.x.com"],
          filesystem: { read: ["/data", OUT], write: [OUT] },
        },
        canonicalWritePaths: [OUT],
        canonicalWriteDirs: [OUT],
      },
    ]);
  });

  test("a malformed stored list refuses before any read", async () => {
    for (const bad of ["not json", '{"a":1}', "[1]", '"x"']) {
      const s = spy({ active: true });
      const r = await prepareUserMcpWriteGrant(row({ write_paths_json: bad }), [], [], s.deps);
      expect(r).toEqual({ ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.malformed });
      expect(s.calls).toEqual([]);
    }
  });

  test("five stored directories, and two that overlap, refuse before any read", async () => {
    const five = JSON.stringify(["/a", "/b", "/c", "/d", "/e"]);
    const s = spy();
    expect(await prepareUserMcpWriteGrant(row({ write_paths_json: five }), [], [], s.deps)).toEqual(
      { ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.tooMany },
    );
    const nested = JSON.stringify(["/a/out", "/a/out/sub"]);
    expect(
      await prepareUserMcpWriteGrant(row({ write_paths_json: nested }), [], [], s.deps),
    ).toEqual({ ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.overlap });
    expect(s.calls).toEqual([]);
  });

  test("a directory the placement rule refuses stops there: no canConfine, no ledger", async () => {
    const s = spy({ scan: "marker", active: true });
    const r = await prepareUserMcpWriteGrant(row({ write_paths_json: WRITES }), [], [], s.deps);
    expect(r).toEqual({ ok: false, reason: WRITE_DIR_REFUSALS.marker });
    expect(s.calls).toEqual([`scan ${OUT}`]);
  });

  test("the SECOND directory is checked too", async () => {
    const s = spy();
    const refusingSecond: UserMcpWriteGrantDeps = {
      ...s.deps,
      writeDir: {
        ...s.deps.writeDir,
        scan: (d) => (d === "/srv/two" ? "link" : "clean"),
      },
    };
    const r = await prepareUserMcpWriteGrant(
      row({ write_paths_json: JSON.stringify(["/srv/one", "/srv/two"]) }),
      [],
      [],
      refusingSecond,
    );
    expect(r).toEqual({ ok: false, reason: WRITE_DIR_REFUSALS.treeLink });
  });

  test("a sandbox that cannot confine the policy refuses with its own reason, before the ledger", async () => {
    const s = spy({ canConfine: "macOS cannot confine this", active: true });
    const r = await prepareUserMcpWriteGrant(row({ write_paths_json: WRITES }), [], [], s.deps);
    expect(r).toEqual({ ok: false, reason: "macOS cannot confine this" });
    expect(s.calls).toEqual([`scan ${OUT}`, "canConfine"]);
  });

  test("a canConfine that throws is a refusal, never a pass", async () => {
    const s = spy();
    const throwing: UserMcpWriteGrantDeps = {
      ...s.deps,
      canConfine: () => {
        throw new Error("no runner");
      },
    };
    const r = await prepareUserMcpWriteGrant(row({ write_paths_json: WRITES }), [], [], throwing);
    expect(r.ok).toBe(false);
  });

  test("canConfine is not asked for a server with no write directory", async () => {
    const s = spy({ canConfine: "would refuse" });
    const r = await prepareUserMcpWriteGrant(row(), ["/data"], [], s.deps);
    expect(r.ok).toBe(true);
    expect(s.calls).toEqual([]);
  });
});

describe("prepareUserMcpWriteGrant: the Windows ledger", () => {
  test("a first spawn records every path it will be granted, read and write, and revokes nothing", async () => {
    const s = spy({ active: true });
    const r = await prepareUserMcpWriteGrant(
      row({ write_paths_json: WRITES }),
      ["/data"],
      [],
      s.deps,
    );
    expect(r.ok).toBe(true);
    expect(s.calls).toEqual([
      `scan ${OUT}`,
      "canConfine",
      "ledger.load",
      `ledger.save ${JSON.stringify({ mcp_notes: { paths: ["/data", OUT], writable: [OUT] } })}`,
    ]);
  });

  test("an unchanged entry is neither revoked nor rewritten", async () => {
    const s = spy({
      active: true,
      ledger: { mcp_notes: ["/data", OUT] },
      ledgerWrite: { mcp_notes: [OUT] },
    });
    await prepareUserMcpWriteGrant(row({ write_paths_json: WRITES }), ["/data"], [], s.deps);
    expect(s.calls).toEqual([`scan ${OUT}`, "canConfine", "ledger.load"]);
  });

  test("a path an earlier spawn was granted and this one is not is revoked BEFORE the entry is rewritten", async () => {
    const s = spy({
      active: true,
      ledger: { mcp_notes: ["/data", "/srv/old-out"], mcp_other: ["/x"] },
    });
    const r = await prepareUserMcpWriteGrant(
      row({ write_paths_json: WRITES }),
      ["/data"],
      [],
      s.deps,
    );
    expect(r.ok).toBe(true);
    expect(s.calls.slice(2)).toEqual([
      "ledger.load",
      'revoke user.mcp_notes ["/srv/old-out"]',
      `ledger.save ${JSON.stringify({
        mcp_notes: { paths: ["/data", OUT], writable: [OUT] },
        mcp_other: { paths: ["/x"], writable: [] },
      })}`,
    ]);
  });

  test("a path that is KEPT but may no longer be written is revoked before it is granted read-only", async () => {
    // The earlier spawn could write /data; this one may only read it. A Windows grant merges
    // rights, so without the revoke the server would keep its write access to /data.
    const s = spy({
      active: true,
      ledger: { mcp_notes: ["/data"] },
      ledgerWrite: { mcp_notes: ["/data"] },
    });
    const r = await prepareUserMcpWriteGrant(row(), ["/data"], [], s.deps);
    expect(r.ok).toBe(true);
    expect(s.calls).toEqual([
      "ledger.load",
      'revoke user.mcp_notes ["/data"]',
      `ledger.save ${JSON.stringify({ mcp_notes: { paths: ["/data"], writable: [] } })}`,
    ]);
  });

  test("a server that now has no grant at all loses its entry after the revoke", async () => {
    const s = spy({ active: true, ledger: { mcp_notes: ["/srv/old-out"] } });
    const r = await prepareUserMcpWriteGrant(row(), [], [], s.deps);
    expect(r).toEqual({ ok: true, grant: NO_USER_MCP_WRITE_GRANT });
    expect(s.calls).toEqual([
      "ledger.load",
      'revoke user.mcp_notes ["/srv/old-out"]',
      "ledger.save {}",
    ]);
  });

  test("an unreadable ledger, a failed revoke and a failed ledger write each refuse the spawn", async () => {
    const unreadable = spy({ active: true, loadThrows: true });
    expect(
      await prepareUserMcpWriteGrant(row({ write_paths_json: WRITES }), [], [], unreadable.deps),
    ).toEqual({ ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.ledgerUnreadable });

    const revoke = spy({ active: true, revokeThrows: true, ledger: { mcp_notes: ["/old"] } });
    expect(
      await prepareUserMcpWriteGrant(row({ write_paths_json: WRITES }), [], [], revoke.deps),
    ).toEqual({ ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.revokeFailed });
    // The entry is untouched: it leaves only after a revoke of it succeeded.
    expect(revoke.ledger.all).toEqual(ledgerOf({ mcp_notes: ["/old"] }));
    expect(revoke.calls.some((c) => c.startsWith("ledger.save"))).toBe(false);

    const save = spy({ active: true, saveThrows: true });
    expect(
      await prepareUserMcpWriteGrant(row({ write_paths_json: WRITES }), [], [], save.deps),
    ).toEqual({ ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.ledgerWriteFailed });
  });
});

describe("releaseUserMcpGrants", () => {
  test("off Windows it does nothing and succeeds", async () => {
    const s = spy({ ledger: { mcp_notes: [OUT] } });
    expect(await releaseUserMcpGrants("mcp_notes", s.deps)).toBe(true);
    expect(s.calls).toEqual([]);
  });

  test("on Windows it revokes the entry's paths, then drops the entry and keeps the others", async () => {
    const s = spy({ active: true, ledger: { mcp_notes: ["/data", OUT], mcp_other: ["/x"] } });
    expect(await releaseUserMcpGrants("mcp_notes", s.deps)).toBe(true);
    expect(s.calls).toEqual([
      "ledger.load",
      `revoke user.mcp_notes ${JSON.stringify(["/data", OUT])}`,
      `ledger.save ${JSON.stringify(ledgerOf({ mcp_other: ["/x"] }))}`,
    ]);
  });

  test("no entry: nothing to revoke", async () => {
    const s = spy({ active: true });
    expect(await releaseUserMcpGrants("mcp_notes", s.deps)).toBe(true);
    expect(s.calls).toEqual(["ledger.load"]);
  });

  test("a failed revoke, and an unreadable ledger, report false and keep the entry", async () => {
    const failing = spy({ active: true, revokeThrows: true, ledger: { mcp_notes: [OUT] } });
    expect(await releaseUserMcpGrants("mcp_notes", failing.deps)).toBe(false);
    expect(failing.ledger.all).toEqual(ledgerOf({ mcp_notes: [OUT] }));
    const unreadable = spy({ active: true, loadThrows: true });
    expect(await releaseUserMcpGrants("mcp_notes", unreadable.deps)).toBe(false);
  });
});

describe("the manifest parts and the stored list", () => {
  test("no grant: exactly `write: []`, the read list untouched, and no declaration", () => {
    expect(userMcpWriteManifestParts(["/data"], NO_USER_MCP_WRITE_GRANT)).toEqual({
      read: ["/data"],
      write: [],
    });
  });

  test("a grant: readable as well as writable, declared canonical and a directory, no duplicate read", async () => {
    const s = spy();
    const r = await prepareUserMcpWriteGrant(
      row({ write_paths_json: JSON.stringify([OUT, "/srv/more"]) }),
      [OUT],
      [],
      s.deps,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(userMcpWriteManifestParts([OUT, "/data"], r.grant)).toEqual({
      read: [OUT, "/data", "/srv/more"],
      write: [OUT, "/srv/more"],
      canonicalWritePaths: [OUT, "/srv/more"],
      canonicalWriteDirs: [OUT, "/srv/more"],
    });
    expect(Object.isFrozen(r.grant.dirs)).toBe(true);
  });

  test("storedWriteDirs reads no file system", () => {
    expect(storedWriteDirs(row({ write_paths_json: WRITES }), "linux")).toEqual({
      ok: true,
      dirs: [OUT],
    });
    expect(storedWriteDirs(row(), "linux")).toEqual({ ok: true, dirs: [] });
  });

  test("the policy id names the Windows profile", () => {
    expect(userMcpPolicyId("mcp_notes")).toBe("user.mcp_notes");
  });
});

describe("the ledger file", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function configDir(): string {
    const d = mkdtempSync(join(tmpdir(), "nimbus-user-mcp-ledger-"));
    temps.push(d);
    return d;
  }

  test("it lives under configDir/sandbox-grants, a missing file is empty, and a save round-trips", () => {
    const dir = configDir();
    const file = userMcpGrantLedgerFile(dir);
    expect(file).toBe(join(dir, "sandbox-grants", "user-mcp-ledger.json"));
    const ledger = fileUserMcpGrantLedger(file);
    expect(ledger.load()).toEqual({});
    expect(ledgerServiceIds(ledger)).toEqual([]);
    const entry = { mcp_notes: { paths: ["/data", OUT], writable: [OUT] } };
    ledger.save(entry);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(entry);
    expect(ledger.load()).toEqual(entry);
    expect(ledgerServiceIds(ledger)).toEqual(["mcp_notes"]);
  });

  test("a malformed file THROWS (fail closed), and the id list is then unknown", () => {
    const dir = configDir();
    const file = userMcpGrantLedgerFile(dir);
    const ledger = fileUserMcpGrantLedger(file);
    ledger.save({});
    for (const bad of [
      "[]",
      '{"mcp_notes":"/x"}',
      '{"mcp_notes":["/x"]}',
      '{"mcp_notes":{"paths":["/x"]}}',
      '{"mcp_notes":{"paths":[1],"writable":[]}}',
      "not json",
    ]) {
      writeFileSync(file, bad);
      expect(() => ledger.load()).toThrow();
      expect(ledgerServiceIds(ledger)).toBeUndefined();
    }
  });
});
