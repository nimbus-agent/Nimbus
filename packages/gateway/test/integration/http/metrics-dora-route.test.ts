import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
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
    seedDbFile(dbPath, CURRENT_SCHEMA_VERSION);
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
    handle = startReadOnlyHttpServer(dbPath, 0, {
      configDir: dir,
      nowMs: () => FIXTURE_NOW_MS,
    });
    port = handle.port;
  });

  afterEach(() => {
    handle?.stop();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
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
