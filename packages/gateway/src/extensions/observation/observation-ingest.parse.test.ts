/** Strict-parser and ordering gaps of `observation-ingest.ts`. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  extensionServiceIdOf,
  listObservationFiles,
  parseObservationFile,
} from "./observation-ingest.ts";

const EXT = "com.example.a";

function good(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    label: { extensionId: EXT, version: "1.0.0" },
    seq: 0,
    runStart: true,
    os: "linux",
    networkObserved: true,
    fromMs: 1000,
    toMs: 2000,
    final: false,
    entries: [{ o: "used", h: "api.github.com", p: 443, n: 1 }],
    dropped: 0,
    ...over,
  };
}

function parse(b: unknown): ReturnType<typeof parseObservationFile> {
  return parseObservationFile(typeof b === "string" ? b : JSON.stringify(b), (id) => id === EXT);
}

function why(b: unknown): string {
  try {
    parse(b);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
}

describe("parseObservationFile", () => {
  test("a good body parses, with an empty run key", () => {
    expect(parse(good())).toMatchObject({ runKey: "", extensionId: EXT, stopped: false });
  });

  test("a missing key, an unknown key and a non-object label are named", () => {
    const { dropped: _dropped, ...lacking } = good();
    expect(why(lacking)).toBe("file lacks dropped");
    expect(why(good({ extra: 1 }))).toBe("file has an unknown key");
    expect(why(good({ label: "x" }))).toBe("label is not an object");
    expect(why(good({ label: { extensionId: EXT } }))).toBe("label lacks version");
    expect(why(good({ label: { extensionId: "other.id", version: "1" } }))).toContain(
      "not installed",
    );
  });

  test("entries must be an array within the cap, each an object with a valid outcome", () => {
    expect(why(good({ entries: "no" }))).toBe("entries is not an array");
    expect(why(good({ entries: Array.from({ length: 100_000 }, () => ({})) }))).toBe(
      "too many entries",
    );
    expect(why(good({ entries: [5] }))).toBe("entry is not an object");
    expect(why(good({ entries: [{ o: "weird", h: "a.com", p: 1, n: 1 }] }))).toBe(
      "entry outcome is not valid",
    );
    expect(why(good({ entries: [{ o: "used", h: "a.com", p: 1, n: 1, z: 1 }] }))).toBe(
      "entry has an unknown key",
    );
  });

  test("booleans and integers are checked by type", () => {
    expect(why(good({ final: "yes" }))).toBe("final is not a boolean");
    expect(why(good({ networkObserved: 1 }))).toBe("networkObserved is not a boolean");
    expect(why(good({ dropped: -1 }))).toBe("dropped is out of range");
    expect(why(good({ seq: "0" }))).toBe("seq is out of range");
  });

  test("an unmatched entry keeps an IP literal; stopped is valid only on the last file", () => {
    const w = parse(good({ entries: [{ o: "unmatched", h: "10.1.2.3", p: 443, n: 2 }] }));
    expect(w.entries).toEqual([
      { outcome: "unmatched", destination: "10.1.2.3", port: 443, count: 2 },
    ]);
    const stopped = parse(good({ seq: 1440, runStart: false, stopped: true }));
    expect(stopped.stopped).toBe(true);
  });
});

describe("listObservationFiles ordering", () => {
  test("several unparsable names sort among themselves after the parsable ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-list-"));
    try {
      for (const n of ["b.json", "a.json", "ext_a.1700000000000.deadbeef.0.json"]) {
        writeFileSync(join(dir, n), "{}");
      }
      expect(listObservationFiles(dir)).toEqual([
        "ext_a.1700000000000.deadbeef.0.json",
        "a.json",
        "b.json",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run name that sorts later comes after, whatever the sequence numbers", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-list-"));
    try {
      mkdirSync(join(dir, "sub"));
      for (const n of [
        "ext_b.1700000000000.00000000.0.json",
        "ext_a.1700000000000.00000000.5.json",
      ]) {
        writeFileSync(join(dir, n), "{}");
      }
      expect(listObservationFiles(dir)).toEqual([
        "ext_a.1700000000000.00000000.5.json",
        "ext_b.1700000000000.00000000.0.json",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extensionServiceIdOf", () => {
  test("derives the id for an ungranted extension and returns undefined for one that has none", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 82);
      expect(extensionServiceIdOf(db, EXT)).toBe("ext_com_example_a");
      expect(extensionServiceIdOf(db, "")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
