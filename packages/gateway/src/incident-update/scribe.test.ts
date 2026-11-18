import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import { upsertIncidentRecord } from "../incident/incident-store.ts";
import {
  createIncidentScribe,
  listQueuedDrafts,
  SCRIBE_DIR,
  SCRIBE_NOTIFY_INTERVAL_MS,
  SCRIBE_QUEUE_MAX,
  type ScribeDeps,
} from "./scribe.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const d of dbs.splice(0)) d.close();
});

const ID_A = "inc_00000000000000aa";
const ID_B = "inc_00000000000000bb";

function harness(over: Partial<ScribeDeps> = {}): {
  dataDir: string;
  events: Array<{ recordId: string; version: number; queued: number }>;
  toasts: Array<{ title: string; body: string }>;
  clock: { t: number };
  scribe: ReturnType<typeof createIncidentScribe>;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "nimbus-scribe-"));
  dirs.push(dataDir);
  const events: Array<{ recordId: string; version: number; queued: number }> = [];
  const toasts: Array<{ title: string; body: string }> = [];
  const clock = { t: 1_000_000 };
  const scribe = createIncidentScribe({
    dataDir,
    enabled: () => true,
    now: () => clock.t,
    emit: (p) => events.push(p),
    notify: async (title, body) => {
      toasts.push({ title, body });
    },
    logger: { warn: () => {} },
    ...over,
  });
  return { dataDir, events, toasts, clock, scribe };
}

describe("the incident scribe", () => {
  test("off by default in config means nothing is queued, emitted or shown", () => {
    const h = harness({ enabled: () => false });
    h.scribe.onAssembled({ recordId: ID_A, version: 1 });
    expect(existsSync(join(h.dataDir, SCRIBE_DIR))).toBe(false);
    expect(h.events).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test("a new version queues ONE metadata file holding no text, an event and a counts-only toast", () => {
    const h = harness();
    h.scribe.onAssembled({ recordId: ID_A, version: 2 });
    const files = readdirSync(join(h.dataDir, SCRIBE_DIR));
    expect(files).toEqual([`${ID_A}.v2.json`]);
    const body = JSON.parse(readFileSync(join(h.dataDir, SCRIBE_DIR, files[0] as string), "utf8"));
    expect(Object.keys(body).sort()).toEqual(["queuedAtMs", "recordId", "version"]);
    expect(h.events).toEqual([{ recordId: ID_A, version: 2, queued: 1 }]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]?.body).toBe("1 new draft, 1 waiting: nimbus incident update --queued");
  });

  test("toasts are coalesced: one per interval, the next one counts what was queued meanwhile", () => {
    const h = harness();
    h.scribe.onAssembled({ recordId: ID_A, version: 1 });
    h.clock.t += 1_000;
    h.scribe.onAssembled({ recordId: ID_A, version: 2 });
    h.clock.t += 1_000;
    h.scribe.onAssembled({ recordId: ID_B, version: 1 });
    expect(h.toasts).toHaveLength(1);
    expect(h.events).toHaveLength(3);
    h.clock.t += SCRIBE_NOTIFY_INTERVAL_MS;
    h.scribe.onAssembled({ recordId: ID_B, version: 2 });
    expect(h.toasts).toHaveLength(2);
    expect(h.toasts[1]?.body).toBe("3 new drafts, 4 waiting: nimbus incident update --queued");
  });

  test("an id that is not the engine's shape never becomes a path", () => {
    const h = harness();
    for (const recordId of ["../../evil", "inc_XYZ", "inc_00000000000000aa/../x", ""]) {
      h.scribe.onAssembled({ recordId, version: 1 });
    }
    h.scribe.onAssembled({ recordId: ID_A, version: 0 });
    h.scribe.onAssembled({ recordId: ID_A, version: 1.5 });
    expect(existsSync(join(h.dataDir, SCRIBE_DIR))).toBe(false);
    expect(h.events).toEqual([]);
  });

  test("the queue keeps the newest entries only", () => {
    const h = harness();
    for (let v = 1; v <= SCRIBE_QUEUE_MAX + 5; v++) {
      h.clock.t += 1;
      h.scribe.onAssembled({ recordId: ID_A, version: v });
    }
    const files = readdirSync(join(h.dataDir, SCRIBE_DIR));
    expect(files).toHaveLength(SCRIBE_QUEUE_MAX);
    expect(files).not.toContain(`${ID_A}.v1.json`);
    expect(files).toContain(`${ID_A}.v${String(SCRIBE_QUEUE_MAX + 5)}.json`);
  });

  test("a failure to write is logged, never thrown", () => {
    const warnings: unknown[] = [];
    const h = harness({
      // A data dir that is a FILE: mkdir under it fails.
      logger: { warn: (o) => warnings.push(o) },
    });
    rmSync(h.dataDir, { recursive: true, force: true });
    writeFileSync(h.dataDir, "x");
    expect(() => h.scribe.onAssembled({ recordId: ID_A, version: 1 })).not.toThrow();
    expect(warnings).toHaveLength(1);
    rmSync(h.dataDir, { force: true });
  });
});

describe("listQueuedDrafts", () => {
  test("lists what is stored and deletes the entry of an erased record", () => {
    const h = harness();
    const db = createMemoryIndexDb();
    dbs.push(db);
    const rec = buildRecord({ itemId: "pagerduty:PDQ" });
    const stored = upsertIncidentRecord(db, {
      record: rec,
      markdown: "# x",
      recordSha256: "a".repeat(64),
      citedServices: ["pagerduty"],
      nowMs: 1,
    });
    h.scribe.onAssembled({ recordId: stored.recordId, version: stored.version });
    h.clock.t += 1;
    h.scribe.onAssembled({ recordId: ID_B, version: 1 }); // no such record
    const live = listQueuedDrafts(db, h.dataDir);
    expect(live.map((e) => e.recordId)).toEqual([stored.recordId]);
    expect(readdirSync(join(h.dataDir, SCRIBE_DIR))).toEqual([
      `${stored.recordId}.v${String(stored.version)}.json`,
    ]);
    db.run("DELETE FROM incident_record WHERE id = ?", [stored.recordId]);
    expect(listQueuedDrafts(db, h.dataDir)).toEqual([]);
    expect(readdirSync(join(h.dataDir, SCRIBE_DIR))).toEqual([]);
  });

  test("a missing queue directory lists nothing", () => {
    const db = createMemoryIndexDb();
    dbs.push(db);
    expect(listQueuedDrafts(db, join(tmpdir(), "nimbus-no-such-dir-ic9b"))).toEqual([]);
  });
});

describe("the queue reader is defensive", () => {
  test("ignores foreign and malformed files, falls back to the file time, and survives an emit that throws", () => {
    const h = harness({
      emit: () => {
        throw new Error("observer failed");
      },
    });
    h.scribe.onAssembled({ recordId: ID_A, version: 1 });
    expect(h.toasts).toHaveLength(1); // the throwing emit did not stop the toast
    const dir = join(h.dataDir, SCRIBE_DIR);
    writeFileSync(join(dir, "notes.txt"), "x");
    writeFileSync(join(dir, `${ID_B}.v1.json`), "{not json");
    writeFileSync(join(dir, `${ID_B}.v2.json`), JSON.stringify({ recordId: ID_B, version: 2 }));
    const db = createMemoryIndexDb();
    dbs.push(db);
    // Nothing is stored, so every well-formed entry is dropped; the foreign and malformed files are left alone.
    expect(listQueuedDrafts(db, h.dataDir)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([`${ID_B}.v1.json`, "notes.txt"]);
  });

  test("entries order newest first, then by id and version", () => {
    const h = harness();
    const db = createMemoryIndexDb();
    dbs.push(db);
    const ids: string[] = [];
    for (const item of ["pagerduty:Q1", "pagerduty:Q2"]) {
      const s = upsertIncidentRecord(db, {
        record: buildRecord({ itemId: item }),
        markdown: "# x",
        recordSha256: "e".repeat(64),
        citedServices: ["pagerduty"],
        nowMs: 1,
      });
      ids.push(s.recordId);
      h.scribe.onAssembled({ recordId: s.recordId, version: 1 }); // same clock: a tie on time
    }
    const listed = listQueuedDrafts(db, h.dataDir).map((e) => e.recordId);
    expect(listed).toEqual([...ids].sort());
  });
});
