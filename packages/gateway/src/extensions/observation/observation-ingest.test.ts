import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
  runObservationPass,
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
    serviceIdFor: (id) => (id === EXT ? "ext_com_example_a" : undefined),
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
  runIndexedSchemaMigrations(db, 82);
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
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 1, rejected: 0 });
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
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 2, rejected: 0 });
    expect(readdirSync(dir)).toEqual([]);
    const a = readExtensionAudit(db, EXT, "1.0.0");
    expect(a.coverage).toMatchObject({ runs: 1, network_observed: 1, dropped: 4 });
    expect(a.coverage?.observed_ms).toBe(4000);
  });

  test("a stop marker (no final file) is accepted, and a run with neither end marker still counts", () => {
    put(`${RUN}.0.json`, body({ entries: [] }));
    put(`${RUN}.1440.json`, body({ seq: 1440, runStart: false, stopped: true }));
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 2, rejected: 0 });
    expect(readExtensionAudit(db, EXT, "1.0.0").coverage).toMatchObject({ runs: 1, stopped: 1 });
  });

  test("an unmatched entry keeps its IPv4 or IPv6 literal verbatim", () => {
    put(
      `${RUN}.0.json`,
      body({
        os: "win32",
        entries: [
          { o: "unmatched", h: "203.0.113.7", p: 443, n: 2 },
          { o: "unmatched", h: "2001:db8::1", p: 443, n: 1 },
        ],
      }),
    );
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 1, rejected: 0 });
    const a = readExtensionAudit(db, EXT, "1.0.0");
    expect(a.rows.map((r) => `${r.outcome} ${r.destination}:${r.port} ${r.count}`)).toEqual([
      "unmatched 2001:db8::1:443 1",
      "unmatched 203.0.113.7:443 2",
    ]);
  });

  test("a run with no stop marker leaves stopped unset", () => {
    put(`${RUN}.0.json`, body());
    ingestObservationFiles(deps());
    expect(readExtensionAudit(db, EXT, "1.0.0").coverage?.stopped).toBe(0);
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
      "an unmatched entry naming a host, not an address",
      body({ entries: [{ o: "unmatched", h: "evil.example.com", p: 443, n: 1 }] }),
    ],
    [
      "an unmatched entry that is not an address at all",
      body({ entries: [{ o: "unmatched", h: "1.2.3.4 x", p: 443, n: 1 }] }),
    ],
    [
      "a used entry naming an IPv6 literal (used keeps the name alphabet)",
      body({ entries: [{ o: "used", h: "2001:db8::1", p: 443, n: 1 }] }),
    ],
    [
      "a refused entry naming an IPv6 literal",
      body({ entries: [{ o: "refused", h: "2001:db8::1", p: 0, n: 1 }] }),
    ],
    [
      "a name of 254 characters",
      body({ entries: [{ o: "used", h: "a".repeat(254), p: 1, n: 1 }] }),
    ],
    ["runStart on a later file", body({ seq: 3, runStart: true })],
    ["toMs before fromMs", body({ fromMs: 5000, toMs: 4000 })],
    ["an os of 'freebsd'", body({ os: "freebsd" })],
    ["stopped: false", body({ stopped: false })],
    ["stopped on a seq below 1440", body({ stopped: true })],
    ["a body seq that is not the file name's", body({ seq: 3, runStart: false })],
    ["text that is not JSON", "{not json"],
    ["a JSON array", "[]"],
  ];

  for (const [what, b] of rejections) {
    test(`${what}: rejected, deleted, logged once by name, and no rows`, () => {
      const path = put(`${RUN}.0.json`, b);
      expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 1 });
      expect(existsSync(path)).toBe(false);
      expect(rowCount()).toBe(0);
      expect(coverageCount()).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`${RUN}.0.json`);
    });
  }

  test("a file over 64 KiB is rejected without being parsed", () => {
    const path = put(`${RUN}.0.json`, body({ pad: "x".repeat(70_000) }));
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 1 });
    expect(existsSync(path)).toBe(false);
    expect(logs[0]).toContain("64 KiB");
  });

  test("a file named for another service id than its label's extension is rejected", () => {
    const path = put("ext_other.1700000000000.deadbeef.0.json", body());
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 1 });
    expect(existsSync(path)).toBe(false);
    expect(rowCount()).toBe(0);
    expect(logs[0]).toContain("service id");
  });

  test("a label whose extension has no service id is rejected", () => {
    put(`${RUN}.0.json`, body());
    expect(ingestObservationFiles(deps({ serviceIdFor: () => undefined }))).toEqual({
      applied: 0,
      rejected: 1,
      touched: [],
    });
    expect(rowCount()).toBe(0);
  });

  test("a file whose delete keeps failing is applied once, however many passes read it", () => {
    const path = put(`${RUN}.0.json`, body({ dropped: 2 }));
    const failing = deps({
      remove: () => {
        throw new Error("EPERM");
      },
    });
    expect(ingestObservationFiles(failing)).toMatchObject({ applied: 1, rejected: 0 });
    const once = readExtensionAudit(db, EXT, "1.0.0");
    for (let i = 0; i < 3; i += 1) {
      expect(ingestObservationFiles(failing)).toMatchObject({ applied: 0, rejected: 0 });
    }
    expect(existsSync(path)).toBe(true);
    expect(readExtensionAudit(db, EXT, "1.0.0")).toEqual(once);
    expect(once.coverage).toMatchObject({ runs: 1, dropped: 2 });
    expect(once.rows.find((r) => r.outcome === "used")?.count).toBe(2);
  });

  test("a crash between the commit and the delete: a fresh ingest only deletes the file", () => {
    const path = put(`${RUN}.0.json`, body());
    // The first gateway committed the window and died before the unlink.
    ingestObservationFiles(
      deps({
        remove: () => {
          throw new Error("killed");
        },
      }),
    );
    const before = readExtensionAudit(db, EXT, "1.0.0");
    // A new gateway, with a real delete.
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 0 });
    expect(existsSync(path)).toBe(false);
    expect(readExtensionAudit(db, EXT, "1.0.0")).toEqual(before);
    expect(before.coverage?.runs).toBe(1);
  });

  test.skipIf(process.platform === "win32")(
    "a symlink named like a window file is rejected, and its target is never read or touched",
    () => {
      const target = join(root, "elsewhere.json");
      writeFileSync(target, JSON.stringify(body()));
      symlinkSync(target, join(dir, `${RUN}.0.json`));
      expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 1 });
      expect(rowCount()).toBe(0);
      expect(existsSync(target)).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  test("a .json whose name is not a window file's is rejected and deleted", () => {
    const path = put("planted.json", body());
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 1 });
    expect(existsSync(path)).toBe(false);
    expect(rowCount()).toBe(0);
  });

  test("a directory named like a window file is left while fresh, then removed whole, logged once", () => {
    const planted = join(dir, `${RUN}.0.json`);
    mkdirSync(planted);
    writeFileSync(join(planted, "inner"), "x");
    nowMs = Date.now();
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 0 });
    expect(existsSync(planted)).toBe(true);
    expect(logs).toEqual([]);
    nowMs += STALE_TEMP_MS + 1000;
    for (let i = 0; i < 3; i += 1) ingestObservationFiles(deps());
    expect(existsSync(planted)).toBe(false);
    expect(rowCount()).toBe(0);
    expect(logs).toEqual([expect.stringContaining(`removed stray ${RUN}.0.json`)]);
  });

  test("an entry that is neither .json nor .tmp is removed once stale, logged once", () => {
    const stray = put("notes.txt", "x");
    const strayDir = join(dir, "subdir");
    mkdirSync(strayDir);
    writeFileSync(join(strayDir, "f"), "x");
    nowMs = Date.now();
    ingestObservationFiles(deps());
    expect(existsSync(stray)).toBe(true);
    expect(existsSync(strayDir)).toBe(true);
    nowMs += STALE_TEMP_MS + 1000;
    for (let i = 0; i < 3; i += 1) ingestObservationFiles(deps());
    expect(readdirSync(dir)).toEqual([]);
    expect(logs.filter((l) => l.includes("notes.txt"))).toHaveLength(1);
    expect(logs.filter((l) => l.includes("subdir"))).toHaveLength(1);
    expect(logs.filter((l) => l.includes("could not delete"))).toEqual([]);
  });

  test("a read error leaves the file for the next pass, which applies it", () => {
    const path = put(`${RUN}.0.json`, body());
    const busy = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    const locked = deps({
      readFile: () => {
        throw busy;
      },
    });
    expect(ingestObservationFiles(locked)).toMatchObject({ applied: 0, rejected: 0 });
    expect(existsSync(path)).toBe(true);
    expect(rowCount()).toBe(0);
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 1, rejected: 0 });
    expect(existsSync(path)).toBe(false);
    expect(readExtensionAudit(db, EXT, "1.0.0").coverage?.runs).toBe(1);
  });

  test("a file that stays unreadable is rejected once it is stale", () => {
    const path = put(`${RUN}.0.json`, body());
    const locked = deps({
      readFile: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    });
    nowMs = Date.now();
    expect(ingestObservationFiles(locked)).toMatchObject({ applied: 0, rejected: 0 });
    nowMs += STALE_TEMP_MS + 1000;
    expect(ingestObservationFiles(locked)).toMatchObject({ applied: 0, rejected: 1 });
    expect(existsSync(path)).toBe(false);
    expect(logs).toEqual([expect.stringContaining(`rejected ${RUN}.0.json: unreadable`)]);
  });

  test("a bad file never stops the good ones beside it", () => {
    put(`${RUN}.0.json`, body());
    put(`${RUN}.1.json`, body({ seq: 1, runStart: false, extra: true }));
    put(`${RUN}.2.json`, body({ seq: 2, runStart: false }));
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 2, rejected: 1 });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a .tmp file is ignored while fresh and deleted once older than 10 minutes", () => {
    const fresh = put(`${RUN}.1.4242.abcd.tmp`, "{");
    const old = put(`${RUN}.2.4242.abcd.tmp`, "{");
    nowMs = Date.now();
    const oldSec = (nowMs - STALE_TEMP_MS - 1000) / 1000;
    utimesSync(old, oldSec, oldSec);
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 0 });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(logs).toEqual([]);
  });

  test("a store failure leaves the file in place, applies nothing, and stops the pass", () => {
    const first = put(`${RUN}.0.json`, body());
    const second = put(`${RUN}.1.json`, body({ seq: 1, runStart: false }));
    dbRun(db, "DROP TABLE extension_observation_coverage");
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 0, rejected: 0 });
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
      runKey: "ext_com_example_a.1.00000000",
      seq: 0,
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

  test("the age-out still runs when the directory cannot be read", () => {
    applyObservationWindow(db, {
      runKey: "ext_com_example_a.1.00000000",
      seq: 0,
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
    ingestObservationFiles(deps({ dir: join(root, "nope") }));
    expect(readExtensionAudit(db, EXT, "0.9.0").rows).toHaveLength(0);
  });

  test("a missing directory is logged, not thrown", () => {
    expect(ingestObservationFiles(deps({ dir: join(root, "nope") }))).toEqual({
      applied: 0,
      rejected: 0,
      touched: [],
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
    expect(ingestObservationFiles(deps())).toMatchObject({ applied: 1, rejected: 0 });
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

describe("touched and runObservationPass", () => {
  test("ingest returns the label of every applied window, and none for a duplicate or reject", () => {
    put(`${RUN}.0.json`, body());
    put(
      `${RUN}.1.json`,
      body({ seq: 1, runStart: false, label: { extensionId: EXT, version: "1.1.0" } }),
    );
    put(`${RUN}.2.json`, "not json");
    expect(ingestObservationFiles(deps())).toEqual({
      applied: 2,
      rejected: 1,
      touched: [
        { extensionId: EXT, version: "1.0.0" },
        { extensionId: EXT, version: "1.1.0" },
      ],
    });
  });

  test("a pass hands what it applied to the notifier; nothing applied, no call", async () => {
    const calls: unknown[] = [];
    const d = deps({ notifier: { afterIngest: async (t) => void calls.push(t) } });
    expect(await runObservationPass(d)).toBe(true);
    expect(calls).toEqual([]);
    put(`${RUN}.0.json`, body());
    await runObservationPass(d);
    expect(calls).toEqual([[{ extensionId: EXT, version: "1.0.0" }]]);
  });

  test("a pass that finds one running with the same deps is skipped", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const d = deps({
      notifier: {
        afterIngest: async () => {
          calls += 1;
          await gate;
        },
      },
    });
    put(`${RUN}.0.json`, body());
    const first = runObservationPass(d);
    put(`${RUN}.1.json`, body({ seq: 1, runStart: false }));
    expect(await runObservationPass(d)).toBe(false);
    // The skipped pass ingested nothing: the file waits for the next one.
    expect(readdirSync(dir)).toEqual([`${RUN}.1.json`]);
    release();
    expect(await first).toBe(true);
    expect(await runObservationPass(d)).toBe(true);
    expect(calls).toBe(2);
  });

  test("a notifier that rejects is logged, and the pass still resolves", async () => {
    put(`${RUN}.0.json`, body());
    const d = deps({
      notifier: { afterIngest: () => Promise.reject(new Error("boom")) },
    });
    expect(await runObservationPass(d)).toBe(true);
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
    // The next pass runs: the flag was cleared.
    expect(await runObservationPass(d)).toBe(true);
  });
});
