import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { computeDeployPreflight } from "../../../src/preflight/preflight.ts";
import {
  PREFLIGHT_FIXTURE_NOW_MS,
  seedPaymentServicePreflightFixture,
} from "../../fixtures/preflight/payment-service/seed.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

describe("preflight integration: payment-service fixture (real SQLite)", () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-int-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("computes the envelope exactly against the hand-computed expected values", async () => {
    const { config } = await seedPaymentServicePreflightFixture(db);
    const out = computeDeployPreflight(db, config, "main", PREFLIGHT_FIXTURE_NOW_MS, 10);
    const expected = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "..",
          "..",
          "fixtures",
          "preflight",
          "payment-service",
          "expected-envelope.json",
        ),
        "utf8",
      ),
    ) as {
      service: string;
      target_ref: string;
      verdict: "ok" | "warn";
      checks: Record<
        string,
        { count: number; gap: string | null; first_finding_id: string | null }
      >;
    };

    expect(out.service).toBe(expected.service);
    expect(out.target_ref).toBe(expected.target_ref);
    expect(out.verdict).toBe(expected.verdict);

    for (const key of ["active_p1_incidents", "failing_ci_runs", "merge_conflicts"] as const) {
      const got = out.checks[key];
      const want = expected.checks[key];
      if (want === undefined) throw new Error(`missing expected for ${key}`);
      expect(got.count, `${key} count`).toBe(want.count);
      expect(got.gap, `${key} gap`).toBe(want.gap);
      if (want.first_finding_id !== null) {
        expect(got.findings[0]?.id, `${key} first finding`).toBe(want.first_finding_id);
      }
    }
  });
});
