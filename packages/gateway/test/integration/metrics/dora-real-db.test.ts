import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { computeDoraMetrics } from "../../../src/metrics/dora.ts";
import {
  FIXTURE_NOW_MS,
  seedPaymentServiceFixture,
} from "../../fixtures/dora/payment-service/seed.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

const WINDOW_MS = 30 * 86_400_000;

type ExpectedEntry = { value: number; sample: number };
type ExpectedMetrics = {
  deployment_frequency: ExpectedEntry;
  lead_time_for_changes: ExpectedEntry;
  change_failure_rate: ExpectedEntry;
  mttr: ExpectedEntry;
};

describe("DORA real-db integration", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-dora-real-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), CURRENT_SCHEMA_VERSION);
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows EBUSY — OS cleans temp dir on reboot */
    }
  });

  it("computes all four metrics within ±5% of hand-computed values", async () => {
    const { config } = await seedPaymentServiceFixture(db);
    const result = computeDoraMetrics(db, config, FIXTURE_NOW_MS, WINDOW_MS);

    const expectedPath = join(
      import.meta.dir,
      "..",
      "..",
      "fixtures",
      "dora",
      "payment-service",
      "expected-metrics.json",
    );
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ExpectedMetrics;

    const keys = [
      "deployment_frequency",
      "lead_time_for_changes",
      "change_failure_rate",
      "mttr",
    ] as const;

    for (const key of keys) {
      const got = result.metrics[key];
      const want = expected[key];
      expect(got.sample, `sample mismatch for ${key}`).toBe(want.sample);
      expect(got.value, `${key} value should not be null`).not.toBeNull();
      const gotValue = got.value as number;
      const denom = Math.max(want.value, 0.001);
      const drift = Math.abs(gotValue - want.value) / denom;
      expect(drift, `${key}: got=${gotValue}, want=${want.value}, drift=${drift}`).toBeLessThan(
        0.05,
      );
    }
  });
});
