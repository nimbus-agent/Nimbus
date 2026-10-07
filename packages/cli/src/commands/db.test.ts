import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { CliPlatformPaths } from "../paths.ts";

const dbMod = await import("./db.ts");
const { runDb } = dbMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runDb (help)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help when no subcommand is given", async () => {
    await runDb([]);
    expect(out.stdout).toContain("nimbus db");
    expect(out.stdout).toContain("nimbus db verify");
  });

  it("prints help on explicit 'help'", async () => {
    await runDb(["help"]);
    expect(out.stdout).toContain("nimbus db");
  });

  it("prints help on --help / -h", async () => {
    await runDb(["--help"]);
    expect(out.stdout).toContain("nimbus db");
    out.reset();
    await runDb(["-h"]);
    expect(out.stdout).toContain("nimbus db");
  });
});

describe("runDb verify", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("calls db.verify and prints formatted output", async () => {
    const ipc = createMockIpcClient([{ clean: true, formatted: "All good.", exitCode: 0 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["verify"]);
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0]).toEqual({ method: "db.verify", params: {} });
    expect(out.stdout).toContain("All good.");
    expect(process.exitCode).toBe(0);
  });

  it("propagates non-zero exitCode from the gateway", async () => {
    const ipc = createMockIpcClient([{ clean: false, formatted: "Issues found.", exitCode: 1 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["verify"]);
    expect(process.exitCode).toBe(1);
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runDb(["verify"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });
});

describe("runDb repair", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("requires --yes", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runDb(["repair"])).rejects.toThrow("Usage: nimbus db repair --yes");
  });

  it("calls db.repair with confirm:true when --yes is given", async () => {
    const ipc = createMockIpcClient([{ formatted: "Repaired." }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["repair", "--yes"]);
    expect(ipc.calls[0]).toEqual({ method: "db.repair", params: { confirm: true } });
    expect(out.stdout).toContain("Repaired.");
  });
});

describe("runDb snapshot", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls db.snapshot.take and prints the path", async () => {
    const ipc = createMockIpcClient([{ path: "/data/snapshots/snap-1.db.gz" }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["snapshot"]);
    expect(ipc.calls[0]).toEqual({ method: "db.snapshot.take", params: {} });
    expect(out.stdout).toContain("/data/snapshots/snap-1.db.gz");
  });
});

describe("runDb snapshots list", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints '(none)' message when list is empty", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["snapshots", "list"]);
    expect(ipc.calls[0]).toEqual({ method: "db.snapshots.list", params: {} });
    expect(out.stdout).toContain("No snapshots yet.");
  });

  it("prints rows when present", async () => {
    const ipc = createMockIpcClient([
      [
        {
          filename: "snap-1.db.gz",
          timestampMs: 1700000000000,
          compressedSizeBytes: 1024,
          path: "/data/snapshots/snap-1.db.gz",
        },
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["snapshots", "list"]);
    expect(out.stdout).toContain("snap-1.db.gz");
    expect(out.stdout).toContain("1024 B");
  });

  it("rejects an unknown snapshots sub-op", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runDb(["snapshots", "bogus"])).rejects.toThrow(/snapshots/);
  });
});

describe("runDb snapshots prune", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("requires --yes", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runDb(["snapshots", "prune"])).rejects.toThrow(
      "Usage: nimbus db snapshots prune --yes",
    );
  });

  it("calls db.snapshots.prune with confirm:true", async () => {
    const ipc = createMockIpcClient([{ deleted: 3, keepLast: 5 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["snapshots", "prune", "--yes"]);
    expect(ipc.calls[0]).toEqual({
      method: "db.snapshots.prune",
      params: { confirm: true },
    });
    expect(out.stdout).toContain("Pruned 3 snapshot(s)");
  });

  it("passes --keep-last through", async () => {
    const ipc = createMockIpcClient([{ deleted: 0, keepLast: 2 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["snapshots", "prune", "--yes", "--keep-last", "2"]);
    expect(ipc.calls[0]).toEqual({
      method: "db.snapshots.prune",
      params: { confirm: true, keepLast: 2 },
    });
  });
});

describe("runDb backups list", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls db.backups.list and prints JSON", async () => {
    const ipc = createMockIpcClient([[{ id: "b1" }]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["backups", "list"]);
    expect(ipc.calls[0]).toEqual({ method: "db.backups.list", params: {} });
    expect(out.stdout).toContain('"id": "b1"');
  });

  it("rejects an unknown backups sub-op", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runDb(["backups", "bogus"])).rejects.toThrow("Usage: nimbus db backups list");
  });
});

describe("runDb restore", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("requires a snapshot argument", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runDb(["restore"])).rejects.toThrow(/restore/);
  });

  it("prints the safety hint when --yes is absent (gateway not running)", async () => {
    setFixture({});
    await runDb(["restore", "/tmp/x.db.gz"]);
    expect(out.stdout).toContain("Restoring overwrites");
    expect(out.stdout).toContain("/tmp/x.db.gz");
  });
});

// The destructive arm: `--yes` overwrites `<dataDir>/nimbus.db`. Every case injects `getPaths` at a
// fresh temp root, so the restore can only ever write there — never the real data directory, which
// on macOS an in-process HOME override would not redirect.
describe("runDb restore --yes (injected paths, temp root)", () => {
  let root: string;

  function pathsUnder(dir: string): CliPlatformPaths {
    const dataDir = join(dir, "data");
    return {
      configDir: join(dir, "config"),
      dataDir,
      logDir: join(dataDir, "logs"),
      socketPath: FAKE_SOCKET_PATH,
      extensionsDir: join(dataDir, "extensions"),
      tempDir: join(dir, "tmp"),
      sandboxDir: join(dir, "sandbox"),
    };
  }

  function writeSnapshot(bytes: Uint8Array<ArrayBuffer>): string {
    const snap = join(root, "snap-1.db.gz");
    writeFileSync(snap, Bun.gzipSync(bytes));
    return snap;
  }

  beforeEach(() => {
    out.reset();
    root = mkdtempSync(join(tmpdir(), "nimbus-db-restore-"));
  });
  afterEach(() => {
    clearFixture();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses while the recorded gateway process is alive, before creating or writing anything", async () => {
    const snap = writeSnapshot(new TextEncoder().encode("snapshot bytes"));
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 4242 }, processAlive: true });
    await expect(
      runDb(["restore", snap, "--yes"], { getPaths: () => pathsUnder(root) }),
    ).rejects.toThrow("Stop the Gateway before restoring the database file (nimbus stop).");
    expect(existsSync(join(root, "data"))).toBe(false);
    // Nothing at all is printed: not the confirmation, and not the --yes hint either.
    expect(out.stdout).toBe("");
  });

  it("a stale gateway.json whose process is gone does not block the restore", async () => {
    const original = new TextEncoder().encode("SQLite format 3\u0000 stale-state restore");
    const snap = writeSnapshot(original);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 4242 }, processAlive: false });
    const paths = pathsUnder(root);
    await runDb(["restore", snap, "--yes"], { getPaths: () => paths });
    expect(new Uint8Array(readFileSync(join(paths.dataDir, "nimbus.db")))).toEqual(original);
    // EXACTLY the confirmation: a confirmed restore must not also print the "run it with --yes" hint.
    expect(out.stdout).toBe(`Restored database from ${snap}\n`);
  });

  it("with no gateway, creates the data directory and REPLACES an existing nimbus.db", async () => {
    const original = new TextEncoder().encode("SQLite format 3\u0000 the snapshot");
    const snap = writeSnapshot(original);
    setFixture({});
    const paths = pathsUnder(root);
    // A first restore into a data directory that does not exist yet...
    await runDb(["restore", snap, "--yes"], { getPaths: () => paths });
    expect(new Uint8Array(readFileSync(join(paths.dataDir, "nimbus.db")))).toEqual(original);
    // ...and a second over a live file with different, LONGER contents: replaced, not appended.
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(
      join(paths.dataDir, "nimbus.db"),
      "a much longer pre-existing database file body",
    );
    await runDb(["restore", snap, "--yes"], { getPaths: () => paths });
    expect(new Uint8Array(readFileSync(join(paths.dataDir, "nimbus.db")))).toEqual(original);
    expect(out.stdout).toBe(`Restored database from ${snap}\n`.repeat(2));
  });

  it("without --yes prints the hint naming the snapshot and writes nothing", async () => {
    const snap = writeSnapshot(new TextEncoder().encode("bytes"));
    setFixture({});
    await runDb(["restore", snap], { getPaths: () => pathsUnder(root) });
    expect(out.stdout).toBe(
      `Restoring overwrites nimbus.db. Stop the Gateway, then run:\n  nimbus db restore ${snap} --yes\n`,
    );
    expect(existsSync(join(root, "data"))).toBe(false);
  });
});

describe("runDb (unknown subcommand)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("rejects unknown subcommands", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runDb(["bogus"])).rejects.toThrow("Unknown db subcommand: bogus");
  });
});

describe("nimbus db verify --json / db repair --json", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  type VerifyJson = {
    clean: boolean;
    findings: Array<{ label: string; status: string; detail?: string }>;
    exitCode: number;
  };
  type RepairJson = {
    outcomes: Array<{ action: string; status: string; detail?: string }>;
    repairedAt: string;
  };

  it("verify emits clean/findings/exitCode and no formatted text on stdout", async () => {
    const ipc = createMockIpcClient([
      {
        clean: false,
        findings: [
          { label: "integrity_check", status: "ok" },
          { label: "vec_rowid_mismatch", status: "fail", detail: "3 orphans" },
        ],
        formatted: "Issues found in the human report.",
        exitCode: 1,
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["verify", "--json"]);

    expect(ipc.calls[0]).toEqual({ method: "db.verify", params: {} });
    const doc = JSON.parse(out.stdout) as VerifyJson;
    expect(doc.clean).toBe(false);
    expect(doc.exitCode).toBe(1);
    expect(doc.findings).toHaveLength(2);
    expect(doc.findings[1]).toEqual({
      label: "vec_rowid_mismatch",
      status: "fail",
      detail: "3 orphans",
    });
    expect(out.stdout).not.toContain("Issues found in the human report.");
  });

  it("verify still propagates the gateway exit code under --json", async () => {
    const ipc = createMockIpcClient([
      { clean: false, findings: [], formatted: "Issues found.", exitCode: 1 },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["verify", "--json"]);
    expect(process.exitCode).toBe(1);
  });

  it("repair emits the structured report and no formatted text on stdout", async () => {
    const ipc = createMockIpcClient([
      {
        report: {
          outcomes: [
            { action: "vec_orphan_delete", status: "applied", detail: "3 rows" },
            { action: "fts5_rebuild", status: "skipped" },
          ],
          repairedAt: "2026-08-01T00:00:00.000Z",
        },
        formatted: "Repaired (human report).",
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDb(["repair", "--yes", "--json"]);

    expect(ipc.calls[0]).toEqual({ method: "db.repair", params: { confirm: true } });
    const doc = JSON.parse(out.stdout) as RepairJson;
    expect(doc.repairedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(doc.outcomes.map((o) => o.action)).toEqual(["vec_orphan_delete", "fts5_rebuild"]);
    expect(doc.outcomes[0]?.status).toBe("applied");
    expect(out.stdout).not.toContain("Repaired (human report).");
  });

  it("repair still requires --yes under --json", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runDb(["repair", "--json"])).rejects.toThrow("Usage: nimbus db repair --yes");
    expect(out.stdout).toBe("");
  });
});
