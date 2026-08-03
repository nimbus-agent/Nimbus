import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchPreflightRpc } from "../../../src/ipc/preflight-rpc.ts";
import {
  PREFLIGHT_FIXTURE_NOW_MS,
  seedPaymentServicePreflightFixture,
} from "../../fixtures/preflight/payment-service/seed.ts";

describe("E2E (in-process): deploy.preflight", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-e2e-"));
    db = new Database(join(dir, "nimbus.db"));
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });

  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — an unfinalized statement can make db.close() a
      // silent no-op that pins the file open, and Windows will otherwise burn the hook's
      // timeout budget retrying the delete. Fail fast and leak the temp dir instead: it's
      // the accepted trade-off (#972, #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("returns a warn-verdict envelope on the fixture", async () => {
    const { config } = await seedPaymentServicePreflightFixture(db);
    const out = await dispatchPreflightRpc(
      "deploy.preflight",
      { service: "payment-service", target_ref: "main" },
      {
        db,
        loadConfig: () => new Map([[config.serviceId, config]]),
        nowMs: () => PREFLIGHT_FIXTURE_NOW_MS,
      },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.value.verdict).toBe("warn");
    expect(out.value.checks.active_p1_incidents.count).toBe(1);
    expect(out.value.checks.failing_ci_runs.count).toBe(1);
    expect(out.value.checks.merge_conflicts.count).toBe(1);
  });

  it("returns ok+gaps envelope when the service has no config", async () => {
    const out = await dispatchPreflightRpc(
      "deploy.preflight",
      { service: "unknown-service", target_ref: "main" },
      {
        db,
        loadConfig: () => new Map(),
        nowMs: () => PREFLIGHT_FIXTURE_NOW_MS,
      },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.value.verdict).toBe("ok");
    expect(out.value.checks.active_p1_incidents.gap).toBe("no_pagerduty_mapping");
  });
});
