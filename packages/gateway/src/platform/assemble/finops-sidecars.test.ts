import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costAllocationItem, mapVantageCostRow } from "../../connectors/vantage-cost-mapping.ts";
import { type CostPoint, DAY_MS } from "../../finops/cost-item-contract.ts";
import { rollUpCostPoints } from "../../finops/cost-rollup.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
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
      ...(demo ? {} : { intervalMs: 3_600_000 }),
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

describe("startFinopsSidecars notice", () => {
  test("a real anomaly in the index reaches the notification service as one counts-only toast", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-finops-sidecar-"));
    const db = new Database(":memory:");
    const shown: string[] = [];
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      writeFileSync(join(dir, "nimbus.toml"), "[finops]\nnotify = true\n");
      const day0 = Date.UTC(2026, 10, 1);
      const synced = Date.UTC(2026, 10, 12, 6);
      const amounts = [10, 10, 10, 10, 10, 10, 10, 500];
      const points = amounts
        .map((a, d) =>
          mapVantageCostRow(
            {
              accrued_at: new Date(day0 + d * DAY_MS).toISOString().slice(0, 10),
              amount: String(a),
              currency: "USD",
              service: "Secret Svc",
            },
            { scopeId: "default", groupBy: ["service"] },
          ),
        )
        .filter((p): p is CostPoint => p !== null);
      const rolled = rollUpCostPoints(points, {
        service: "vantage",
        scopeId: "default",
        maxSeries: 500,
        existingSeriesHashes: new Set(),
        syncedAt: synced,
      });
      for (const r of rolled) upsertIndexedItem(db, costAllocationItem(r, synced));
      const stops: Array<() => void> = [];
      startFinopsSidecars({
        db,
        paths: { configDir: dir } as PlatformPaths,
        notifications: {
          show: (_t: string, b: string) => {
            shown.push(b);
            return Promise.resolve();
          },
          delivers: true,
        } as unknown as NotificationService,
        logger,
        sidecarStops: stops,
        now: () => synced,
      });
      await new Promise((r) => setTimeout(r, 20));
      for (const s of stops) s();
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain("1 unusual cost jump on vantage");
      expect(shown[0]).not.toContain("Secret");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
