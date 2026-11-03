import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteExtensionById, insertExtensionRow } from "../../automation/extension-store.ts";
import { dbRun } from "../../db/write.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  ageOutObservations,
  applyObservationWindow,
  deleteObservationsFor,
  type ObservationWindow,
  readExtensionAudit,
} from "./observation-store.ts";

const DAY = 86_400_000;
let dir: string;
let db: Database;

function addExt(id: string): void {
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: join(dir, id),
    manifest_hash: "m",
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
  });
}

/** Each window gets its own (run, seq) unless a test names one, so repeated applies all count. */
let nextSeq = 0;

function win(over: Partial<ObservationWindow> = {}): ObservationWindow {
  nextSeq += 1;
  return {
    runKey: "ext_a.1000.deadbeef",
    seq: nextSeq,
    extensionId: "ext-a",
    version: "1.0.0",
    os: "linux",
    networkObserved: true,
    runStart: true,
    fromMs: 1000,
    toMs: 2000,
    entries: [{ outcome: "used", destination: "api.example.com", port: 443, count: 2 }],
    dropped: 0,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obs-store-"));
  db = new Database(join(dir, "i.db"));
  dbRun(db, "PRAGMA foreign_keys = ON");
  runIndexedSchemaMigrations(db, 81);
  addExt("ext-a");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("applyObservationWindow", () => {
  test("two windows add counts and keep min/max times; runStart counts runs", () => {
    applyObservationWindow(db, win());
    applyObservationWindow(
      db,
      win({
        runStart: false,
        fromMs: 5000,
        toMs: 7000,
        entries: [{ outcome: "used", destination: "api.example.com", port: 443, count: 3 }],
      }),
    );
    const a = readExtensionAudit(db, "ext-a", "1.0.0");
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.count).toBe(5);
    expect(a.coverage?.runs).toBe(1);
    expect(a.coverage?.observed_ms).toBe(3000);
    expect(a.coverage?.first_seen).toBe(1000);
    expect(a.coverage?.last_seen).toBe(7000);
    expect(a.rows[0]?.first_seen).toBe(1000);
    expect(a.rows[0]?.last_seen).toBe(7000);
    applyObservationWindow(db, win({ runStart: true, fromMs: 8000, toMs: 8000, entries: [] }));
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.runs).toBe(2);
  });

  test("the 513th new key is dropped and counted, an existing key still updates", () => {
    const many = Array.from({ length: 512 }, (_, i) => ({
      outcome: "unmatched" as const,
      destination: `h${i}.example.com`,
      port: 80,
      count: 1,
    }));
    applyObservationWindow(db, win({ entries: many }));
    applyObservationWindow(
      db,
      win({
        runStart: false,
        entries: [
          { outcome: "unmatched", destination: "new.example.com", port: 80, count: 1 },
          { outcome: "unmatched", destination: "h0.example.com", port: 80, count: 4 },
        ],
        dropped: 2,
      }),
    );
    const a = readExtensionAudit(db, "ext-a", "1.0.0");
    expect(a.rows).toHaveLength(512);
    expect(a.coverage?.dropped).toBe(3);
    expect(a.rows.find((r) => r.destination === "h0.example.com")?.count).toBe(5);
    expect(a.rows.some((r) => r.destination === "new.example.com")).toBe(false);
  });

  test("a different version has its own 512", () => {
    const many = Array.from({ length: 512 }, (_, i) => ({
      outcome: "used" as const,
      destination: `h${i}.example.com`,
      port: 443,
      count: 1,
    }));
    applyObservationWindow(db, win({ entries: many }));
    applyObservationWindow(db, win({ version: "2.0.0" }));
    expect(readExtensionAudit(db, "ext-a", "2.0.0").rows).toHaveLength(1);
    expect(readExtensionAudit(db, "ext-a", "2.0.0").coverage?.dropped).toBe(0);
  });

  test("rows are ordered by outcome, destination, port", () => {
    applyObservationWindow(
      db,
      win({
        entries: [
          { outcome: "used", destination: "b.com", port: 443, count: 1 },
          { outcome: "refused", destination: "z.com", port: 443, count: 1 },
          { outcome: "used", destination: "a.com", port: 8443, count: 1 },
          { outcome: "used", destination: "a.com", port: 443, count: 1 },
        ],
      }),
    );
    const keys = readExtensionAudit(db, "ext-a", "1.0.0").rows.map(
      (r) => `${r.outcome}|${r.destination}|${r.port}`,
    );
    expect(keys).toEqual([
      "refused|z.com|443",
      "used|a.com|443",
      "used|a.com|8443",
      "used|b.com|443",
    ]);
  });

  test("network_observed is sticky: a later window saying false never clears an earlier true", () => {
    // A run's observed flag is the OR of its windows, and so is the version's.
    applyObservationWindow(db, win({ networkObserved: false }));
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.network_observed).toBe(0);
    applyObservationWindow(db, win({ runStart: false, networkObserved: true }));
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.network_observed).toBe(1);
    applyObservationWindow(db, win({ runStart: true, networkObserved: false }));
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.network_observed).toBe(1);
  });

  test("the window is applied in an IMMEDIATE transaction, so the row count and the writes are atomic", () => {
    const modes: string[] = [];
    const original = db.transaction.bind(db);
    db.transaction = ((fn: (...a: never[]) => unknown) => {
      const t = original(fn);
      const wrapped = Object.assign(
        (...a: never[]) => {
          modes.push("deferred");
          return t(...a);
        },
        {
          deferred: (...a: never[]) => {
            modes.push("deferred");
            return t.deferred(...a);
          },
          immediate: (...a: never[]) => {
            modes.push("immediate");
            return t.immediate(...a);
          },
          exclusive: (...a: never[]) => {
            modes.push("exclusive");
            return t.exclusive(...a);
          },
        },
      );
      return wrapped;
    }) as typeof db.transaction;
    applyObservationWindow(db, win());
    expect(modes).toEqual(["immediate"]);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").rows).toHaveLength(1);
  });

  test("a (run, seq) already applied is a no-op that returns false and changes nothing", () => {
    expect(applyObservationWindow(db, win({ seq: 0, dropped: 1 }))).toBe(true);
    const before = readExtensionAudit(db, "ext-a", "1.0.0");
    expect(applyObservationWindow(db, win({ seq: 0, dropped: 1 }))).toBe(false);
    expect(readExtensionAudit(db, "ext-a", "1.0.0")).toEqual(before);
    expect(before.coverage).toMatchObject({ runs: 1, dropped: 1, observed_ms: 1000 });
    expect(before.rows[0]?.count).toBe(2);
    // The same seq of ANOTHER run is its own window.
    expect(applyObservationWindow(db, win({ runKey: "ext_a.2000.cafef00d", seq: 0 }))).toBe(true);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.runs).toBe(2);
  });

  test("the applied mark is written in the window's own transaction: a failed apply leaves none", () => {
    dbRun(db, "DROP TABLE extension_observation_coverage");
    expect(() => applyObservationWindow(db, win({ seq: 0 }))).toThrow();
    expect(db.query("SELECT 1 FROM extension_observation_applied").all()).toHaveLength(0);
    expect(db.query("SELECT 1 FROM extension_network_observation").all()).toHaveLength(0);
  });

  test("the applied mark records the extension and the time it was applied", () => {
    applyObservationWindow(db, win({ seq: 7 }), 12_345);
    expect(db.query("SELECT * FROM extension_observation_applied").all()).toEqual([
      { run_key: "ext_a.1000.deadbeef", seq: 7, extension_id: "ext-a", applied_at: 12_345 },
    ]);
  });

  test("stopped is recorded from a stopped window and stays set", () => {
    applyObservationWindow(db, win());
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.stopped).toBe(0);
    applyObservationWindow(db, win({ runStart: false, stopped: true }));
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.stopped).toBe(1);
    applyObservationWindow(db, win({ runStart: true }));
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.stopped).toBe(1);
  });

  test("a key repeated inside one window is one row with the counts added", () => {
    applyObservationWindow(
      db,
      win({
        entries: [
          { outcome: "used", destination: "api.example.com", port: 443, count: 2 },
          { outcome: "used", destination: "api.example.com", port: 443, count: 5 },
        ],
      }),
    );
    const a = readExtensionAudit(db, "ext-a", "1.0.0");
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.count).toBe(7);
    expect(a.coverage?.dropped).toBe(0);
  });

  test("the 512 bound can be reached inside one window: the rest of it is dropped and counted", () => {
    const pre = Array.from({ length: 510 }, (_, i) => ({
      outcome: "used" as const,
      destination: `h${i}.example.com`,
      port: 443,
      count: 1,
    }));
    applyObservationWindow(db, win({ entries: pre }));
    const five = Array.from({ length: 5 }, (_, i) => ({
      outcome: "refused" as const,
      destination: `n${i}.example.com`,
      port: 0,
      count: 1,
    }));
    applyObservationWindow(db, win({ runStart: false, entries: five }));
    const a = readExtensionAudit(db, "ext-a", "1.0.0");
    expect(a.rows).toHaveLength(512);
    expect(a.rows.filter((r) => r.outcome === "refused").map((r) => r.destination)).toEqual([
      "n0.example.com",
      "n1.example.com",
    ]);
    expect(a.coverage?.dropped).toBe(3);
  });

  const fill = (outcome: "unmatched" | "refused" | "used", n: number, port = 443) =>
    Array.from({ length: n }, (_, i) => ({
      outcome,
      destination:
        outcome === "unmatched" ? `10.0.${Math.floor(i / 256)}.${i % 256}` : `h${i}.test`,
      port,
      count: 1,
    }));

  test("at the bound a new `used` row evicts the oldest `unmatched` row and counts it as dropped", () => {
    applyObservationWindow(db, win({ fromMs: 1000, toMs: 2000, entries: fill("unmatched", 1) }));
    applyObservationWindow(
      db,
      win({ runStart: false, fromMs: 3000, toMs: 4000, entries: fill("unmatched", 512).slice(1) }),
    );
    applyObservationWindow(
      db,
      win({
        runStart: false,
        fromMs: 5000,
        toMs: 6000,
        entries: [{ outcome: "used", destination: "api.example.com", port: 443, count: 2 }],
      }),
    );
    const a = readExtensionAudit(db, "ext-a", "1.0.0");
    expect(a.rows).toHaveLength(512);
    expect(a.rows.filter((r) => r.outcome === "used").map((r) => r.destination)).toEqual([
      "api.example.com",
    ]);
    // 10.0.0.0 was the one last seen earliest.
    expect(a.rows.some((r) => r.destination === "10.0.0.0")).toBe(false);
    expect(a.coverage?.dropped).toBe(1);
  });

  test("at the bound with no `unmatched` row, a new `used` row evicts the oldest `refused` row", () => {
    applyObservationWindow(db, win({ fromMs: 1000, toMs: 2000, entries: fill("refused", 1, 0) }));
    applyObservationWindow(
      db,
      win({ runStart: false, fromMs: 3000, toMs: 4000, entries: fill("refused", 512, 0).slice(1) }),
    );
    applyObservationWindow(db, win({ runStart: false, fromMs: 5000, toMs: 6000 }));
    const a = readExtensionAudit(db, "ext-a", "1.0.0");
    expect(a.rows).toHaveLength(512);
    expect(a.rows.some((r) => r.outcome === "used")).toBe(true);
    expect(a.rows.some((r) => r.destination === "h0.test")).toBe(false);
    expect(a.coverage?.dropped).toBe(1);
  });

  test("at the bound a new `unmatched` or `refused` row is dropped, and a full table of `used` drops a new `used`", () => {
    applyObservationWindow(db, win({ entries: fill("used", 512) }));
    applyObservationWindow(
      db,
      win({
        runStart: false,
        entries: [
          { outcome: "unmatched", destination: "10.9.9.9", port: 443, count: 1 },
          { outcome: "refused", destination: "evil.test", port: 0, count: 1 },
          { outcome: "used", destination: "api.example.com", port: 443, count: 1 },
        ],
      }),
    );
    const a = readExtensionAudit(db, "ext-a", "1.0.0");
    expect(a.rows).toHaveLength(512);
    expect(a.rows.every((r) => r.outcome === "used" && r.destination !== "api.example.com")).toBe(
      true,
    );
    expect(a.coverage?.dropped).toBe(3);
  });

  test("eviction never crosses into another version's rows", () => {
    applyObservationWindow(
      db,
      win({ version: "2.0.0", fromMs: 1, toMs: 1, entries: fill("unmatched", 1) }),
    );
    applyObservationWindow(db, win({ entries: fill("used", 512) }));
    applyObservationWindow(
      db,
      win({
        runStart: false,
        entries: [{ outcome: "used", destination: "x.test", port: 443, count: 1 }],
      }),
    );
    expect(readExtensionAudit(db, "ext-a", "2.0.0").rows).toHaveLength(1);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").rows).toHaveLength(512);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage?.dropped).toBe(1);
  });

  test("a CHECK rejects outcome 'other'", () => {
    expect(() =>
      dbRun(
        db,
        "INSERT INTO extension_network_observation VALUES ('ext-a','1.0.0','x',1,'other',1,1,1)",
      ),
    ).toThrow();
  });
});

describe("ageOutObservations / delete", () => {
  test("removes only rows older than 90 days, with their coverage", () => {
    const now = 200 * DAY;
    applyObservationWindow(db, win({ fromMs: 1 * DAY, toMs: 1 * DAY }));
    addExt("ext-b");
    applyObservationWindow(db, win({ extensionId: "ext-b", fromMs: 190 * DAY, toMs: 190 * DAY }));
    expect(ageOutObservations(db, now)).toBe(1);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").rows).toHaveLength(0);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage).toBeUndefined();
    expect(readExtensionAudit(db, "ext-b", "1.0.0").rows).toHaveLength(1);
    expect(readExtensionAudit(db, "ext-b", "1.0.0").coverage).toBeDefined();
  });

  test("a row last seen exactly 90 days ago is kept; one millisecond older goes", () => {
    const now = 200 * DAY;
    applyObservationWindow(db, win({ fromMs: now - 90 * DAY, toMs: now - 90 * DAY }));
    expect(ageOutObservations(db, now)).toBe(0);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").rows).toHaveLength(1);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage).toBeDefined();
    expect(ageOutObservations(db, now + 1)).toBe(1);
    expect(readExtensionAudit(db, "ext-a", "1.0.0").coverage).toBeUndefined();
  });

  test("applied marks age out on the same 90 days, by when they were applied", () => {
    applyObservationWindow(db, win({ seq: 1 }), 1 * DAY);
    applyObservationWindow(db, win({ seq: 2 }), 150 * DAY);
    ageOutObservations(db, 200 * DAY);
    expect(db.query("SELECT seq FROM extension_observation_applied").all()).toEqual([{ seq: 2 }]);
  });

  test("deleteExtensionById leaves no V81 rows, even with foreign_keys off", () => {
    dbRun(db, "PRAGMA foreign_keys = OFF");
    applyObservationWindow(db, win());
    deleteExtensionById(db, "ext-a");
    expect(db.query("SELECT 1 FROM extension_network_observation").all()).toHaveLength(0);
    expect(db.query("SELECT 1 FROM extension_observation_coverage").all()).toHaveLength(0);
    expect(db.query("SELECT 1 FROM extension_observation_applied").all()).toHaveLength(0);
  });

  test("deleteObservationsFor removes one extension only", () => {
    addExt("ext-b");
    applyObservationWindow(db, win());
    applyObservationWindow(db, win({ extensionId: "ext-b" }));
    deleteObservationsFor(db, "ext-a");
    expect(readExtensionAudit(db, "ext-a", "1.0.0").rows).toHaveLength(0);
    expect(readExtensionAudit(db, "ext-b", "1.0.0").rows).toHaveLength(1);
    expect(db.query("SELECT extension_id FROM extension_observation_applied").all()).toEqual([
      { extension_id: "ext-b" },
    ]);
  });
});
