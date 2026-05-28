/**
 * Integration test: GET /v1/metrics/dora HTTP route (Phase 5 T4 PR 2 — Task 7).
 *
 * Verifies the read-only HTTP server dispatches `/v1/metrics/dora` to the
 * shared `dispatchMetricsRpc` handler, threading the optional `configDir`
 * and `nowMs` options. Uses the payment-service fixture from Task 5.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReadOnlyHttpServer } from "../../../src/ipc/http-server.ts";
import {
  FIXTURE_NOW_MS,
  seedPaymentServiceFixture,
} from "../../fixtures/dora/payment-service/seed.ts";
import { seedDbFile } from "../../helpers/migrated-db-seed.ts";

describe("GET /v1/metrics/dora", () => {
  let dir: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-dora-http-"));
    const dbPath = join(dir, "nimbus.db");
    seedDbFile(dbPath, 28);
    const db = new Database(dbPath);
    await seedPaymentServiceFixture(db);
    db.close();
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[metrics.dora.payment-service]
repos = ["github:nimbus-agent/payments", "gitlab:nimbus-agent/payments", "jenkins:payment-service/deploy-prod"]
pagerduty_services = ["P12ABCD"]
`,
    );
    // Pass port = 0 so the OS picks a free port; reading `handle.port` after
    // start eliminates the random-port-collision flake that hit this test on
    // shared CI runners (port 40370 in use → `Failed to start server`).
    handle = startReadOnlyHttpServer(dbPath, 0, {
      configDir: dir,
      nowMs: () => FIXTURE_NOW_MS,
    });
    port = handle.port;
  });

  afterEach(() => {
    handle?.stop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("returns the four-metric envelope for a configured service", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/metrics/dora?service=payment-service&since=30d`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      service: string;
      since_ms: number;
      computed_at: string;
      metrics: Record<string, unknown>;
    };
    expect(body.service).toBe("payment-service");
    expect(body.metrics).toHaveProperty("deployment_frequency");
    expect(body.metrics).toHaveProperty("lead_time_for_changes");
    expect(body.metrics).toHaveProperty("change_failure_rate");
    expect(body.metrics).toHaveProperty("mttr");
  });

  it("returns 400 when service param is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/metrics/dora`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  });

  it("returns generic 500 (no message leak) when the config loader throws", async () => {
    // Replace the valid config with one that fails to parse — bad regex causes
    // `loadNimbusDoraFromConfigDir` to throw, which must bubble up to the
    // outer `fetch` catch and return a generic "internal_error" — never the
    // raw exception message (CodeQL: information exposure through stack trace).
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[metrics.dora.payment-service]
repos = ["github:nimbus-agent/payments"]
deploy_workflow_pattern = "["
`,
    );
    const res = await fetch(`http://127.0.0.1:${port}/v1/metrics/dora?service=payment-service`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("internal_error");
  });
});
