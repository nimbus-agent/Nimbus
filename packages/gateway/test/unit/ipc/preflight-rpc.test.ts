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
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
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

  // F24a: an unknown service must NOT verdict `ok`. `nimbus deploy preflight --mode block`
  // blocks on `warn` alone (`commands/deploy.ts`), and the first-party Action's `safeVerdict`
  // coerces every value that is not literally "warn" to "ok" — so a third verdict value would
  // be silently downgraded by an already-published Action. "warn" is therefore the only value
  // that fails closed in every consumer, old and new; the `unknown_service` gap on all three
  // checks carries the reason.
  //
  // This assertion is the INVERSE of the one it replaces, which pinned `verdict: "ok"` for an
  // unconfigured service. That was the fail-open contract, asserted; it is changed on purpose.
  it("verdicts `warn` with an unknown_service gap when the service has no config", async () => {
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
    expect(out.value.verdict).toBe("warn");
    expect(out.value.checks.active_p1_incidents.gap).toBe("unknown_service");
    expect(out.value.checks.failing_ci_runs.gap).toBe("unknown_service");
    expect(out.value.checks.merge_conflicts.gap).toBe("unknown_service");
  });

  // The count half: a `warn` from an unknown service must still carry zero findings, so a
  // reader cannot mistake "could not evaluate" for "found three problems".
  it("reports zero counts and no findings for an unknown service", async () => {
    const out = await dispatchPreflightRpc(
      "deploy.preflight",
      { service: "unknown", target_ref: "main" },
      { db, loadConfig: () => new Map(), nowMs: () => PREFLIGHT_FIXTURE_NOW_MS },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.value.checks.active_p1_incidents.count).toBe(0);
    expect(out.value.checks.failing_ci_runs.findings).toEqual([]);
    expect(out.value.checks.merge_conflicts.count).toBe(0);
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
