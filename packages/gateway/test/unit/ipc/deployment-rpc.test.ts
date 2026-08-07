import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { DeploymentRpcError, dispatchDeploymentRpc } from "../../../src/ipc/deployment-rpc.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

const NOW = 1747142641204;
const valid = {
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

function fresh(): Database {
  const dir = mkdtempSync(join(tmpdir(), "drpc-"));
  // CURRENT_SCHEMA_VERSION: dispatchDeploymentRpc calls annotateDeployment, which writes
  // item.resolve_key (added at V52).
  return openSeededDbFile(join(dir, "nimbus.db"), CURRENT_SCHEMA_VERSION);
}

describe("dispatchDeploymentRpc", () => {
  test("misses on a non-deployment method", async () => {
    const db = fresh();
    const out = await dispatchDeploymentRpc("metrics.dora", {}, { db, nowMs: () => NOW });
    expect(out.kind).toBe("miss");
    db.close();
  });

  test("hits on deployment.annotate and returns the result envelope", async () => {
    const db = fresh();
    const out = await dispatchDeploymentRpc("deployment.annotate", valid, {
      db,
      nowMs: () => NOW,
    });
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect(out.value.external_id).toBe("github-actions:run-12345:job-67890");
      expect(out.value.is_new).toBe(true);
    }
    db.close();
  });

  test("throws DeploymentRpcError(-32602) on params that are not an object", async () => {
    const db = fresh();
    let err: unknown;
    try {
      await dispatchDeploymentRpc("deployment.annotate", null, { db, nowMs: () => NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeploymentRpcError);
    expect((err as DeploymentRpcError).rpcCode).toBe(-32602);
    db.close();
  });

  test("rejects array params", async () => {
    const db = fresh();
    let err: unknown;
    try {
      await dispatchDeploymentRpc("deployment.annotate", [valid], { db, nowMs: () => NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeploymentRpcError);
    db.close();
  });

  test("translates AnnotateError into DeploymentRpcError -32602", async () => {
    const db = fresh();
    let err: unknown;
    try {
      await dispatchDeploymentRpc(
        "deployment.annotate",
        { ...valid, sha: "bad" },
        { db, nowMs: () => NOW },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeploymentRpcError);
    expect((err as DeploymentRpcError).field).toBe("sha");
    db.close();
  });
});
