import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentAnnotateInput } from "../../../src/deployment/types.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchDeploymentRpc } from "../../../src/ipc/deployment-rpc.ts";

const NOW = 1747142641204;
const TARGET_SCHEMA_VERSION = 29;

describe("E2E (in-process): nimbus deploy annotate", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-deploy-annotate-e2e-"));
    db = new Database(join(dir, "nimbus.db"));
    runIndexedSchemaMigrations(db, TARGET_SCHEMA_VERSION);
  }, 30_000);

  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle (unfinalized statement) must fail
      // FAST rather than block the hook's timeout budget; a leaked temp dir is the accepted
      // trade-off (#972, #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  test("writes item + deployment_items + audit rows; retry returns is_new=false", async () => {
    const payload: DeploymentAnnotateInput = {
      service: "payment-service",
      provider: "github-actions",
      environment: "prod",
      sha: "a1b2c3d",
      ref: "refs/heads/main",
      status: "success",
      started_at_ms: NOW - 1000,
      run_id: "12345",
      job_id: "67890",
    };

    const first = await dispatchDeploymentRpc("deployment.annotate", payload, {
      db,
      nowMs: () => NOW,
    });
    if (first.kind !== "hit") throw new Error("expected hit on first call");
    expect(first.value.is_new).toBe(true);
    expect(first.value.dora_eligible).toBe(true);
    expect(first.value.external_id).toBe("github-actions:run-12345:job-67890");

    const second = await dispatchDeploymentRpc("deployment.annotate", payload, {
      db,
      nowMs: () => NOW + 1000,
    });
    if (second.kind !== "hit") throw new Error("expected hit on retry");
    expect(second.value.is_new).toBe(false);
    expect(second.value.external_id).toBe(first.value.external_id);

    const items = db.query("SELECT COUNT(*) AS c FROM item WHERE type = 'deployment'").get() as {
      c: number;
    };
    expect(items.c).toBe(1);

    const shadow = db.query("SELECT COUNT(*) AS c FROM deployment_items").get() as { c: number };
    expect(shadow.c).toBe(1);

    const audit = db
      .query("SELECT COUNT(*) AS c FROM audit_log WHERE action_type = 'deployment.annotated'")
      .get() as { c: number };
    expect(audit.c).toBe(2);
  });
});
