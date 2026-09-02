import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { clearCursor, readCursor, writeCursor } from "./media-pass-state.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

describe("media pass cursor", () => {
  test("reads null when no cursor exists", () => {
    expect(readCursor(db, "default")).toBeNull();
  });

  test("round-trips a cursor", () => {
    writeCursor(db, "default", { lastItemId: "filesystem:/m/a.mp4", processedCount: 1, nowMs: 10 });
    expect(readCursor(db, "default")).toBe("filesystem:/m/a.mp4");
  });

  test("advancing overwrites rather than inserting a second row", () => {
    writeCursor(db, "default", { lastItemId: "a", processedCount: 1, nowMs: 10 });
    writeCursor(db, "default", { lastItemId: "b", processedCount: 2, nowMs: 20 });
    expect(readCursor(db, "default")).toBe("b");
    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_pass_cursor")
      .get()?.n;
    expect(count).toBe(1);
  });

  test("clearing removes it so the next run starts from the beginning", () => {
    writeCursor(db, "default", { lastItemId: "a", processedCount: 1, nowMs: 10 });
    clearCursor(db, "default");
    expect(readCursor(db, "default")).toBeNull();
  });

  test("separate pass ids do not collide", () => {
    writeCursor(db, "images", { lastItemId: "i", processedCount: 1, nowMs: 10 });
    writeCursor(db, "av", { lastItemId: "v", processedCount: 1, nowMs: 10 });
    expect(readCursor(db, "images")).toBe("i");
    expect(readCursor(db, "av")).toBe("v");
  });
});
