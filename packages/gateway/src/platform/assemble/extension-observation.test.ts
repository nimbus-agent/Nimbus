import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { insertExtensionRow } from "../../automation/extension-store.ts";
import { ensureObservationDir } from "../../extensions/observation/observation-ingest.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { NotificationService } from "../types.ts";
import { startExtensionObservation } from "./extension-observation.ts";

const EXT = "com.example.a";
const RUN = "ext_com_example_a.1700000000000.deadbeef";

let root: string;
let db: Database;
let warnings: string[];
let toasts: Array<{ title: string; body: string }>;
let stops: Array<() => void>;

const logger = {
  warn: (...args: unknown[]) => {
    warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
} as unknown as Logger;

const notifications: NotificationService = {
  show: async (title, body) => {
    toasts.push({ title, body });
  },
};

function windowFile(entries: Array<{ o: string; h: string; p: number; n: number }>): string {
  const now = Date.now();
  return JSON.stringify({
    v: 1,
    label: { extensionId: EXT, version: "1.0.0" },
    seq: 0,
    runStart: true,
    os: "linux",
    networkObserved: true,
    fromMs: now - 60_000,
    toMs: now - 1000,
    final: false,
    entries,
    dropped: 0,
  });
}

async function until(cond: () => boolean): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
}

function observationCount(): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM extension_network_observation").get() as { n: number }
  ).n;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "assemble-obs-"));
  db = new Database(":memory:");
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
  warnings = [];
  toasts = [];
  stops = [];
});

afterEach(async () => {
  for (const s of stops) s();
  // Let a boot pass still in flight finish before the database goes away.
  await new Promise((r) => setTimeout(r, 50));
  db.close();
  rmDirWithRetry(root);
});

describe("startExtensionObservation", () => {
  test("creates the observation directory under the data dir and registers exactly one stop", () => {
    const dir = startExtensionObservation(db, root, logger, stops, notifications);
    expect(dir).toBe(join(root, "extension-observations"));
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(stops).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("a directory that cannot be created is logged, not fatal, and still returns its path", () => {
    // The data dir is a regular file, so mkdir beneath it fails.
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "x");
    const dir = startExtensionObservation(db, blocker, logger, stops, notifications);
    expect(dir).toBe(join(blocker, "extension-observations"));
    expect(existsSync(dir)).toBe(false);
    expect(warnings.some((w) => w.includes("could not be created"))).toBe(true);
    expect(stops).toHaveLength(1);
  });

  test("the boot pass ingests a window for an installed extension and toasts the undeclared lookup once", async () => {
    const dir = ensureObservationDir(root);
    writeFileSync(
      join(dir, `${RUN}.0.json`),
      windowFile([{ o: "refused", h: "undeclared.invalid", p: 0, n: 3 }]),
    );
    startExtensionObservation(db, root, logger, stops, notifications);
    await until(() => toasts.length > 0);
    expect(readdirSync(dir)).toEqual([]);
    const rows = db
      .query("SELECT outcome, destination, count FROM extension_network_observation")
      .all();
    expect(rows).toEqual([{ outcome: "refused", destination: "undeclared.invalid", count: 3 }]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toContain(EXT);
    expect(toasts[0]?.title).toContain("undeclared network lookup");
  });

  test("a window naming an extension that is not installed is rejected and nothing is stored", async () => {
    const dir = ensureObservationDir(root);
    writeFileSync(
      join(dir, `${RUN}.0.json`),
      windowFile([{ o: "refused", h: "x.invalid", p: 0, n: 1 }]).replace(EXT, "com.other.gone"),
    );
    startExtensionObservation(db, root, logger, stops, notifications);
    await until(() => readdirSync(dir).length === 0);
    expect(observationCount()).toBe(0);
    expect(toasts).toEqual([]);
  });

  test("a notification service that throws breaks nothing: the window is still stored", async () => {
    const dir = ensureObservationDir(root);
    writeFileSync(
      join(dir, `${RUN}.0.json`),
      windowFile([{ o: "refused", h: "undeclared.invalid", p: 0, n: 3 }]),
    );
    const failing: NotificationService = {
      show: () => {
        throw new Error("no toast backend");
      },
    };
    startExtensionObservation(db, root, logger, stops, failing);
    await until(() => observationCount() > 0);
    expect(observationCount()).toBe(1);
  });
});
