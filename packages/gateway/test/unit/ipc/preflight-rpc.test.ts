import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { dispatchPreflightRpc, PreflightRpcError } from "../../../src/ipc/preflight-rpc.ts";
import {
  PREFLIGHT_FIXTURE_NOW_MS,
  seedPaymentServicePreflightFixture,
} from "../../fixtures/preflight/payment-service/seed.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

describe("preflight-rpc: deploy.preflight", () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-rpc-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("returns a configured envelope for a fixture-seeded service", async () => {
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
    expect(out.value.service).toBe("payment-service");
    expect(out.value.verdict).toBe("warn");
  });

  it("returns an unconfigured envelope (all checks gapped) when service has no config", async () => {
    const out = await dispatchPreflightRpc(
      "deploy.preflight",
      { service: "unknown", target_ref: "main" },
      {
        db,
        loadConfig: () => new Map(),
        nowMs: () => PREFLIGHT_FIXTURE_NOW_MS,
      },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.value.verdict).toBe("ok");
    expect(out.value.checks.active_p1_incidents.gap).toBe("no_pagerduty_mapping");
    expect(out.value.checks.failing_ci_runs.gap).toBe("no_repos");
    expect(out.value.checks.merge_conflicts.gap).toBe("no_repos");
  });

  it("rejects array params with -32602", async () => {
    await expect(
      dispatchPreflightRpc("deploy.preflight", [{ service: "x", target_ref: "main" }], {
        db,
        loadConfig: () => new Map(),
        nowMs: () => PREFLIGHT_FIXTURE_NOW_MS,
      }),
    ).rejects.toThrow(PreflightRpcError);
  });

  it("rejects missing service param", async () => {
    await expect(
      dispatchPreflightRpc(
        "deploy.preflight",
        { target_ref: "main" },
        {
          db,
          loadConfig: () => new Map(),
          nowMs: () => PREFLIGHT_FIXTURE_NOW_MS,
        },
      ),
    ).rejects.toThrow(/service/);
  });

  it("rejects missing target_ref param", async () => {
    await expect(
      dispatchPreflightRpc(
        "deploy.preflight",
        { service: "x" },
        {
          db,
          loadConfig: () => new Map(),
          nowMs: () => PREFLIGHT_FIXTURE_NOW_MS,
        },
      ),
    ).rejects.toThrow(/target_ref/);
  });

  it("rejects out-of-range max_findings", async () => {
    await expect(
      dispatchPreflightRpc(
        "deploy.preflight",
        { service: "x", target_ref: "main", max_findings: 100 },
        { db, loadConfig: () => new Map(), nowMs: () => PREFLIGHT_FIXTURE_NOW_MS },
      ),
    ).rejects.toThrow(/max_findings/);
    await expect(
      dispatchPreflightRpc(
        "deploy.preflight",
        { service: "x", target_ref: "main", max_findings: 0 },
        { db, loadConfig: () => new Map(), nowMs: () => PREFLIGHT_FIXTURE_NOW_MS },
      ),
    ).rejects.toThrow(/max_findings/);
  });

  it("returns miss for an unknown method", async () => {
    const out = await dispatchPreflightRpc(
      "deploy.unknown",
      {},
      { db, loadConfig: () => new Map(), nowMs: () => PREFLIGHT_FIXTURE_NOW_MS },
    );
    expect(out.kind).toBe("miss");
  });
});
