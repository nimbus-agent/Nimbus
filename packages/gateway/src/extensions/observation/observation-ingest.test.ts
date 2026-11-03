import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertExtensionRow } from "../../automation/extension-store.ts";
import { dbRun } from "../../db/write.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  deleteObservationFilesFor,
  ensureObservationDir,
  extensionObservationDirFor,
  ingestObservationFiles,
  listObservationFiles,
  type ObservationIngestDeps,
  observationPrefixFor,
  STALE_TEMP_MS,
  startObservationIngest,
} from "./observation-ingest.ts";
import { applyObservationWindow, readExtensionAudit } from "./observation-store.ts";

const EXT = "com.example.a";
const RUN = "ext_com_example_a.1700000000000.deadbeef";
const DAY = 86_400_000;

let root: string;
let dir: string;
let db: Database;
let logs: string[];
let nowMs: number;

function deps(over: Partial<ObservationIngestDeps> = {}): ObservationIngestDeps {
  return {
    db,
    dir,
    now: () => nowMs,
    isInstalled: (id) => id === EXT,
    log: (l) => logs.push(l),
    ...over,
  };
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    label: { extensionId: EXT, version: "1.0.0" },
    seq: 0,
    runStart: true,
    os: "linux",
    networkObserved: true,
    fromMs: 1000,
    toMs: 61_000,
    final: false,
    entries: [
      { o: "used", h: "api.github.com", p: 443, n: 2 },
      { o: "refused", h: "undeclared.invalid", p: 0, n: 3 },
    ],
    dropped: 0,
    ...over,
  };
}

function put(name: string, b: Record<string, unknown> | string): string {
  const path = join(dir, name);
  writeFileSync(path, typeof b === "string" ? b : JSON.stringify(b));
  return path;
}

function rowCount(): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM extension_network_observation").get() as { n: number }
  ).n;
}

function coverageCount(): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM extension_observation_coverage").get() as { n: number }
  ).n;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "obs-ingest-"));
  dir = join(root, "obs");
  mkdirSync(dir);
  db = new Database(join(root, "i.db"));
  dbRun(db, "PRAGMA foreign_keys = ON");
  runIndexedSchemaMigrations(db, 81);
  insertExtensionRow(db, {
    id: EXT,
    version: "1.0.0",
    install_path: join(root, "install"),
    manifest_hash: "m",
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
  });
  logs = [];
  // Small, so the 90-day age-out at the end of each pass removes none of these windows.
  nowMs = 1_000_000;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("ingestObservationFiles", () => {
  test("a valid file is applied under its label's extension and version, then deleted", () => {
    const path = put(`${RUN}.0.json`, body());
    expect(ingestObservationFiles(deps())).toEqual({ applied: 1, rejected: 0 });
    expect(existsSync(path)).toBe(false);
    const a = readExtensionAudit(db, EXT, "1.0.0");
    expect(a.rows.map((r) => `${r.outcome} ${r.destination}:${r.port} ${r.count}`)).toEqual([
      "refused undeclared.invalid:0 3",
      "used api.github.com:443 2",
    ]);
    expect(a.coverage).toMatchObject({ runs: 1, os: "linux", network_observed: 1, dropped: 0 });
    expect(logs).toEqual([]);
  });

  test("two files of one run apply in order and count one run; observed if any file says so", () => {
    put(`${RUN}.0.json`, body({ networkObserved: false, entries: [], toMs: 1000 }));
    put(
      `${RUN}.1.json`,
      body({ seq: 1, runStart: false, final: true, fromMs: 1000, toMs: 5000, dropped: 4 }),
    );
    expect(ingestObservationFiles(deps())).toEqual({ applied: 2, rejected: 0 });
    expect(readdirSync(dir)).toEqual([]);
    const a = readExtensionAudit(db, EXT, "1.0.0");
    expect(a.coverage).toMatchObject({ runs: 1, network_observed: 1, dropped: 4 });
    expect(a.coverage?.observed_ms).toBe(4000);
  });

  test("a stop marker (no final file) is accepted, and a run with neither end marker still counts", () => {
    put(`${RUN}.0.json`, body({ entries: [] }));
    put(`${RUN}.1440.json`, body({ seq: 1440, runStart: false, stopped: true }));
    expect(ingestObservationFiles(deps())).toEqual({ applied: 2, rejected: 0 });
    expect(readExtensionAudit(db, EXT, "1.0.0").coverage?.runs).toBe(1);
  });

  const rejections: Array<[string, Record<string, unknown> | string]> = [
    ["an unknown top-level key", body({ extra: 1 })],
    ["an unknown entry key", body({ entries: [{ o: "used", h: "a.com", p: 443, n: 1, x: 1 }] })],
    ["an outcome of 'other'", body({ entries: [{ o: "other", h: "a.com", p: 443, n: 1 }] })],
    ["a port of 70000", body({ entries: [{ o: "used", h: "a.com", p: 70_000, n: 1 }] })],
    [
      "257 entries",
      body({
        entries: Array.from({ length: 257 }, (_, i) => ({
          o: "used",
          h: `h${i}.com`,
          p: 443,
          n: 1,
        })),
      }),
    ],
    [
      "a label naming an extension that is not installed",
      body({ label: { extensionId: "com.example.gone", version: "1.0.0" } }),
    ],
    ["a label with an extra key", body({ label: { extensionId: EXT, version: "1", x: 1 } })],
    ["a version longer than 64", body({ label: { extensionId: EXT, version: "9".repeat(65) } })],
    ["v 2", body({ v: 2 })],
    ["a count of 0", body({ entries: [{ o: "used", h: "a.com", p: 443, n: 0 }] })],
    ["a fractional port", body({ entries: [{ o: "used", h: "a.com", p: 1.5, n: 1 }] })],
    [
      "a name outside the sanitiser's alphabet",
      body({ entries: [{ o: "used", h: "a b", p: 1, n: 1 }] }),
    ],
    ["an empty name", body({ entries: [{ o: "used", h: "", p: 1, n: 1 }] })],
    [
      "a name of 254 characters",
      body({ entries: [{ o: "used", h: "a".repeat(254), p: 1, n: 1 }] }),
    ],
    ["runStart on a later file", body({ seq: 3, runStart: true })],
    ["toMs before fromMs", body({ fromMs: 5000, toMs: 4000 })],
    ["an os of 'freebsd'", body({ os: "freebsd" })],
    ["stopped: false", body({ stopped: false })],
    ["text that is not JSON", "{not json"],
    ["a JSON array", "[]"],
  ];

  for (const [what, b] of rejections) {
    test(`${what}: rejected, deleted, logged once by name, and no rows`, () => {
      const path = put(`${RUN}.0.json`, b);
      expect(ingestObservationFiles(deps())).toEqual({ applied: 0, rejected: 1 });
      expect(existsSync(path)).toBe(false);
      expect(rowCount()).toBe(0);
      expect(coverageCount()).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`${RUN}.0.json`);
    });
  }

  test("a file over 64 KiB is rejected without being parsed", () => {
    const path = put(`${RUN}.0.json`, body({ pad: "x".repeat(70_000) }));
    expect(ingestObservationFiles(deps())).toEqual({ applied: 0, rejected: 1 });
    expect(existsSync(path)).toBe(false);
    expect(logs[0]).toContain("64 KiB");
  });

  test("a .json whose name is not a window file's is rejected and deleted", () => {
    const path = put("planted.json", body());
    expect(ingestObservationFiles(deps())).toEqual({ applied: 0, rejected: 1 });
    expect(existsSync(path)).toBe(false);
    expect(rowCount()).toBe(0);
  });

  test("a directory named like a window file is rejected", () => {
    mkdirSync(join(dir, `${RUN}.0.json`));
    expect(ingestObservationFiles(deps())).toEqual({ applied: 0, rejected: 1 });
    expect(rowCount()).toBe(0);
  });

  test("a bad file never stops the good ones beside it", () => {
    put(`${RUN}.0.json`, body());
    put(`${RUN}.1.json`, body({ seq: 1, runStart: false, extra: true }));
    put(`${RUN}.2.json`, body({ seq: 2, runStart: false }));
    expect(ingestObservationFiles(deps())).toEqual({ applied: 2, rejected: 1 });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a .tmp file is ignored while fresh and deleted once older than 10 minutes", () => {
    const fresh = put(`${RUN}.1.4242.abcd.tmp`, "{");
    const old = put(`${RUN}.2.4242.abcd.tmp`, "{");
    nowMs = Date.now();
    const oldSec = (nowMs - STALE_TEMP_MS - 1000) / 1000;
    utimesSync(old, oldSec, oldSec);
    expect(ingestObservationFiles(deps())).toEqual({ applied: 0, rejected: 0 });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(logs).toEqual([]);
  });

  test("a store failure leaves the file in place, applies nothing, and stops the pass", () => {
    const first = put(`${RUN}.0.json`, body());
    const second = put(`${RUN}.1.json`, body({ seq: 1, runStart: false }));
    dbRun(db, "DROP TABLE extension_observation_coverage");
    expect(ingestObservationFiles(deps())).toEqual({ applied: 0, rejected: 0 });
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    // The entry upserts ran in the same transaction and were rolled back with it.
    expect(rowCount()).toBe(0);
    // The pass stopped at the first failure: the second file was not even tried.
    expect(logs.filter((l) => l.includes("could not store"))).toEqual([
      expect.stringContaining(`could not store ${RUN}.0.json`),
    ]);
  });

  test("the pass ages out rows older than 90 days", () => {
    applyObservationWindow(db, {
      extensionId: EXT,
      version: "0.9.0",
      os: "linux",
      networkObserved: true,
      runStart: true,
      fromMs: 1 * DAY,
      toMs: 1 * DAY,
      entries: [{ outcome: "used", destination: "old.example.com", port: 443, count: 1 }],
      dropped: 0,
    });
    nowMs = 200 * DAY;
    ingestObservationFiles(deps());
    expect(readExtensionAudit(db, EXT, "0.9.0").rows).toHaveLength(0);
  });

  test("a missing directory is logged, not thrown", () => {
    expect(ingestObservationFiles(deps({ dir: join(root, "nope") }))).toEqual({
      applied: 0,
      rejected: 0,
    });
    expect(logs).toHaveLength(1);
  });
});

describe("listObservationFiles", () => {
  test("orders by run, then by sequence number numerically; unparsable names last", () => {
    const other = "ext_z.1700000000000.00000000";
    for (const n of [
      `${RUN}.10.json`,
      `${RUN}.9.json`,
      `${other}.0.json`,
      "zz.json",
      `${RUN}.0.json`,
      `${RUN}.0.1.abcd.tmp`,
    ]) {
      put(n, "{}");
    }
    expect(listObservationFiles(dir)).toEqual([
      `${RUN}.0.json`,
      `${RUN}.9.json`,
      `${RUN}.10.json`,
      `${other}.0.json`,
      "zz.json",
    ]);
  });
});

describe("deleteObservationFilesFor", () => {
  test("removes only that service id's windows and temps", () => {
    put("ext_a.1.00000000.0.json", "{}");
    put("ext_a.1.00000000.1.99.abcd.tmp", "{");
    put("ext_ab.1.00000000.0.json", "{}");
    put("ext_b.1.00000000.0.json", "{}");
    deleteObservationFilesFor(dir, "ext_a");
    expect(readdirSync(dir).sort((a, b) => (a < b ? -1 : 1))).toEqual([
      "ext_ab.1.00000000.0.json",
      "ext_b.1.00000000.0.json",
    ]);
  });

  test("a missing directory is a no-op", () => {
    expect(() => deleteObservationFilesFor(join(root, "nope"), "ext_a")).not.toThrow();
  });
});

describe("the directory and the prefix", () => {
  test("the directory is <dataDir>/extension-observations, created owner-only", () => {
    const dataDir = join(root, "data");
    const made = ensureObservationDir(dataDir);
    expect(made).toBe(join(dataDir, "extension-observations"));
    expect(extensionObservationDirFor(dataDir)).toBe(made);
    expect(statSync(made).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(made).mode & 0o777).toBe(0o700);
    // Idempotent.
    expect(ensureObservationDir(dataDir)).toBe(made);
  });

  test("the prefix is <dir>/<serviceId>.<ms>.<8 hex>, and its files parse as window files", () => {
    const p = observationPrefixFor(dir, "ext_com_example_a", () => 1234);
    expect(p.startsWith(join(dir, "ext_com_example_a.1234."))).toBe(true);
    expect(p.slice(join(dir, "ext_com_example_a.1234.").length)).toMatch(/^[0-9a-f]{8}$/);
    expect(observationPrefixFor(dir, "ext_x")).not.toBe(observationPrefixFor(dir, "ext_x"));
    writeFileSync(`${p}.0.json`, JSON.stringify(body()));
    expect(ingestObservationFiles(deps())).toEqual({ applied: 1, rejected: 0 });
  });
});

describe("startObservationIngest", () => {
  test("ingests at once, then on the timer, and stops ingesting after stop()", async () => {
    put(`${RUN}.0.json`, body());
    const stop = startObservationIngest(deps(), 20);
    try {
      expect(readdirSync(dir)).toEqual([]);
      put(`${RUN}.1.json`, body({ seq: 1, runStart: false }));
      const start = Date.now();
      while (readdirSync(dir).length > 0 && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      stop();
    }
    const late = put(`${RUN}.2.json`, body({ seq: 2, runStart: false }));
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(late)).toBe(true);
  });
});
