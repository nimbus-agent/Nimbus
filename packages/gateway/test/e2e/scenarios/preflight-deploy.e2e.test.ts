import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchPreflightRpc } from "../../../src/ipc/preflight-rpc.ts";
import {
  PREFLIGHT_FIXTURE_NOW_MS,
  seedPaymentServicePreflightFixture,
} from "../../fixtures/preflight/payment-service/seed.ts";

describe("E2E (in-process): deploy.preflight", () => {
  let db: Database;

  // `:memory:`, not a temp-dir file — matching every sibling scenario in this directory
  // (catchup / decisions / expert / glossary / impact all do the same).
  //
  // This hook runs the whole migration chain, and it does so once PER TEST. Against a file it
  // measured 145-161 ms locally versus 12-13 ms in memory, and the CI runner is ~13-18x slower
  // at exactly this work — temp-dir SQLite. That put the hook at ~3 s on Windows with nothing
  // between it and Bun's 5 s hook budget, so the suite did not fail on an assertion, it failed
  // with "a beforeEach/afterEach hook timed out for this test" on `main` (runs 32611067170 and
  // 32638974730). The sibling test was passing at 2970 ms — over half the budget — which is the
  // shape of a flake, not a pass.
  //
  // Nothing here needs a file: `dispatchPreflightRpc` takes the handle, never a path. Dropping
  // the temp dir also drops the afterEach that existed solely to survive Windows file locking
  // (#972, #973) — an unfinalized statement can make `db.close()` a silent no-op that pins the
  // file open, and that hook was itself competing for the same timeout budget.
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });

  afterEach(() => {
    db.close();
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

  // F24a: was "returns ok+gaps envelope". An unknown service verdicts `warn` so `--mode block`
  // blocks; see `unconfiguredEnvelope` in `ipc/preflight-rpc.ts`.
  it("returns a warn+unknown_service envelope when the service has no config", async () => {
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
    expect(out.value.verdict).toBe("warn");
    expect(out.value.checks.active_p1_incidents.gap).toBe("unknown_service");
  });
});
