import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { startReadOnlyHttpServer } from "../../../src/ipc/http-server.ts";
import {
  PREFLIGHT_FIXTURE_NOW_MS,
  seedPaymentServicePreflightFixture,
} from "../../fixtures/preflight/payment-service/seed.ts";
import { seedDbFile } from "../../helpers/migrated-db-seed.ts";

describe("GET /v1/preflight/deploy", () => {
  let dir: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-http-"));
    const dbPath = join(dir, "nimbus.db");
    seedDbFile(dbPath, CURRENT_SCHEMA_VERSION);
    const db = new Database(dbPath);
    await seedPaymentServicePreflightFixture(db);
    db.close();
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[metrics.dora.payment-service]
repos = ["github:nimbus-agent/payments"]
pagerduty_services = ["P12ABCD"]
`,
    );
    handle = startReadOnlyHttpServer(dbPath, 0, {
      configDir: dir,
      nowMs: () => PREFLIGHT_FIXTURE_NOW_MS,
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

  it("returns the preflight envelope for a configured service", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/preflight/deploy?service=payment-service&target_ref=main`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      service: string;
      target_ref: string;
      verdict: string;
      checks: Record<string, unknown>;
    };
    expect(body.service).toBe("payment-service");
    expect(body.target_ref).toBe("main");
    expect(body.verdict).toBe("warn");
    expect(body.checks).toHaveProperty("active_p1_incidents");
    expect(body.checks).toHaveProperty("failing_ci_runs");
    expect(body.checks).toHaveProperty("merge_conflicts");
  });

  it("returns 400 when service param is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/preflight/deploy?target_ref=main`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  });

  it("returns 400 when target_ref param is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/preflight/deploy?service=payment-service`);
    expect(res.status).toBe(400);
  });

  it("returns generic 500 (no message leak) when the config loader throws", async () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[metrics.dora.payment-service]
repos = ["github:nimbus-agent/payments"]
deploy_workflow_pattern = "["
`,
    );
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/preflight/deploy?service=payment-service&target_ref=main`,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("internal_error");
  });
});
