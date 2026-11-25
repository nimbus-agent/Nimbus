import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SECTION_LOADERS } from "../../config/config-explain.ts";
import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { resolverFor, serviceConfig } from "../../incident/__fixtures__/index-writers.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import type { PlatformPaths } from "../paths.ts";
import { startIndexRetentionSidecars } from "./index-retention-sidecars.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("startIndexRetentionSidecars", () => {
  test("starts both passes against the real config reader, prunes an old run at boot and registers its stops", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nimbus-idx-ret-"));
    dirs.push(configDir);
    const db = createMemoryIndexDb();
    upsertIndexedItem(
      db,
      {
        service: "airflow",
        type: "dag_run",
        externalId: "d|r",
        title: "r",
        bodyPreview: "",
        modifiedAt: 1,
        syncedAt: 1,
        metadata: { end_ms: 1 },
      },
      resolverFor(serviceConfig()),
    );
    const stops: Array<() => void> = [];
    startIndexRetentionSidecars({ db, paths: { configDir } as PlatformPaths, sidecarStops: stops });
    expect(stops).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 50));
    expect((db.query("SELECT COUNT(*) AS n FROM item").get() as { n: number }).n).toBe(0);
    for (const stop of stops) stop();
    db.close();
  });

  test("`nimbus config explain` can load the orchestration and openapi sections", () => {
    const configDir = mkdtempSync(join(tmpdir(), "nimbus-idx-ret-"));
    dirs.push(configDir);
    expect(SECTION_LOADERS["orchestration"]?.(configDir)).toEqual({ runRetentionDays: 30 });
    expect(SECTION_LOADERS["openapi"]?.(configDir)).toBeDefined();
  });
});
