import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { PlatformPaths } from "../paths.ts";
import type { NotificationService } from "../types.ts";
import { startFinopsSidecars } from "./finops-sidecars.ts";

const logger = { warn: () => undefined } as never;
const notifications = {} as NotificationService;

function stopCount(toml: string, demo: boolean): number {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-finops-sidecar-"));
  const db = new Database(":memory:");
  try {
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    writeFileSync(join(dir, "nimbus.toml"), toml);
    const stops: Array<() => void> = [];
    startFinopsSidecars({
      db,
      paths: { configDir: dir, ...(demo ? { demo: true } : {}) } as PlatformPaths,
      notifications,
      logger,
      sidecarStops: stops,
      intervalMs: 3_600_000,
    });
    const n = stops.length;
    for (const s of stops) s();
    return n;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("startFinopsSidecars", () => {
  test("retention always starts; the notice timer starts on a non-demo gateway only (I41)", () => {
    expect(stopCount("[finops]\nnotify = true\n", false)).toBe(2);
    expect(stopCount("[finops]\nnotify = true\n", true)).toBe(1);
  });
});
