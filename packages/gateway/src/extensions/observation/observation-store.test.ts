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

function win(over: Partial<ObservationWindow> = {}): ObservationWindow {
  return {
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
    // File 0 of every run says false (the runner marks after the writer exists), so a run's
    // observed flag is the OR of its windows, and so is the version's.
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

  test("deleteExtensionById leaves no V81 rows, even with foreign_keys off", () => {
    dbRun(db, "PRAGMA foreign_keys = OFF");
    applyObservationWindow(db, win());
    deleteExtensionById(db, "ext-a");
    expect(db.query("SELECT 1 FROM extension_network_observation").all()).toHaveLength(0);
    expect(db.query("SELECT 1 FROM extension_observation_coverage").all()).toHaveLength(0);
  });

  test("deleteObservationsFor removes one extension only", () => {
    addExt("ext-b");
    applyObservationWindow(db, win());
    applyObservationWindow(db, win({ extensionId: "ext-b" }));
    deleteObservationsFor(db, "ext-a");
    expect(readExtensionAudit(db, "ext-a", "1.0.0").rows).toHaveLength(0);
    expect(readExtensionAudit(db, "ext-b", "1.0.0").rows).toHaveLength(1);
  });
});
