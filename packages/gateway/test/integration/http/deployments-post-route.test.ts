import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import {
  type ReadOnlyHttpServerHandle,
  startReadOnlyHttpServer,
} from "../../../src/ipc/http-server.ts";
import { seedDbFile } from "../../helpers/migrated-db-seed.ts";

const TOKEN = "hunter2";
const NOW = 1747142641204;

const VALID_BODY = {
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

function authHeaders(token = TOKEN): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

describe("POST /v1/deployments (integration)", () => {
  let dir: string;
  let dbPath: string;
  let handle: ReadOnlyHttpServerHandle | null = null;

  function startServer(o: { token?: string } = {}): ReadOnlyHttpServerHandle {
    return startReadOnlyHttpServer(dbPath, 0, {
      configDir: dir,
      nowMs: () => NOW,
      resolveDeploymentToken: async () => o.token ?? TOKEN,
    });
  }

  function urlFor(h: ReadOnlyHttpServerHandle): string {
    return `http://127.0.0.1:${h.port}/v1/deployments`;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deploy-post-"));
    dbPath = join(dir, "nimbus.db");
    // CURRENT_SCHEMA_VERSION: the route calls annotateDeployment, which writes item.resolve_key
    // (added at V52).
    seedDbFile(dbPath, CURRENT_SCHEMA_VERSION);
    writeFileSync(
      join(dir, "nimbus.toml"),
      [
        "[ci.service.payment-service]",
        'repos = ["github:acme/payments"]',
        "pagerduty_services = []",
        'deploy_workflow_pattern = "^Deploy"',
        "incident_window_minutes = 60",
        "exclude_pr_labels = []",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    if (handle !== null) {
      handle.stop();
      handle = null;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  test("200 on first valid POST with X-RateLimit-Limit header", async () => {
    handle = startServer();
    const res = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    const body = (await res.json()) as {
      external_id: string;
      service: string;
      is_new: boolean;
      dora_eligible: boolean;
      stored_at_ms: number;
    };
    expect(body.service).toBe("payment-service");
    expect(body.is_new).toBe(true);
    expect(body.dora_eligible).toBe(true);
    expect(typeof body.external_id).toBe("string");
    expect(body.external_id.length).toBeGreaterThan(0);
  });

  test("200 is_new=false on retry of the same payload", async () => {
    handle = startServer();
    const first = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(VALID_BODY),
    });
    expect(first.status).toBe(200);

    const second = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(VALID_BODY),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { is_new: boolean };
    expect(body.is_new).toBe(false);
  });

  test("401 when bearer is missing", async () => {
    handle = startServer();
    const res = await fetch(urlFor(handle), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });

  test("401 when bearer is wrong", async () => {
    handle = startServer();
    const res = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders("wrong-token"),
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });

  test("503 write_surface_disabled when vault key is absent (token resolves to '')", async () => {
    handle = startServer({ token: "" });
    const res = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; hint?: string };
    expect(body.error).toBe("write_surface_disabled");
    expect(typeof body.hint).toBe("string");
  });

  test("400 invalid_request on bad sha", async () => {
    handle = startServer();
    const badBody = { ...VALID_BODY, sha: "not-a-hex-sha" };
    const res = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(badBody),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      details?: Array<{ field?: string; reason?: string }>;
    };
    expect(body.error).toBe("invalid_request");
    expect(Array.isArray(body.details)).toBe(true);
  });

  test("400 unknown_service includes known_services list", async () => {
    handle = startServer();
    const badBody = { ...VALID_BODY, service: "ghost-service" };
    const res = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(badBody),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      service?: string;
      known_services?: string[];
    };
    expect(body.error).toBe("unknown_service");
    expect(body.service).toBe("ghost-service");
    expect(Array.isArray(body.known_services)).toBe(true);
    expect(body.known_services).toContain("payment-service");
  });

  test("405 on GET /v1/deployments with Allow: POST", async () => {
    handle = startServer();
    const res = await fetch(urlFor(handle), { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  test("413 on oversize body (10 KiB ref)", async () => {
    handle = startServer();
    const oversize = { ...VALID_BODY, ref: "x".repeat(10 * 1024) };
    const res = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(oversize),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("payload_too_large");
  });

  test("429 after exceeding 60 requests in the window with Retry-After header", async () => {
    handle = startServer();
    for (let i = 0; i < 60; i++) {
      const res = await fetch(urlFor(handle), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ...VALID_BODY, sha: `a1b2c3${i.toString(16).padStart(2, "0")}` }),
      });
      expect(res.status).toBe(200);
    }
    const limited = await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(VALID_BODY),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).not.toBeNull();
    const body = (await limited.json()) as { error?: string };
    expect(body.error).toBe("rate_limited");
    // 61 sequential HTTP round-trips: slow on Windows CI runners (~5s), so the
    // default 5000ms bun-test timeout is too tight. Allow generous headroom.
  }, 30_000);

  test("401 writes a deployment.annotation_rejected audit row", async () => {
    handle = startServer();
    await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders("wrong-token"),
      body: JSON.stringify(VALID_BODY),
    });
    handle.stop();
    handle = null;
    const reader = new Database(dbPath, { readonly: true });
    const rows = reader
      .query(
        `SELECT action_type, action_json
           FROM audit_log
          WHERE action_type = 'deployment.annotation_rejected'
          ORDER BY id DESC`,
      )
      .all() as Array<{ action_type: string; action_json: string }>;
    reader.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(rows[0].action_json) as {
      result_code: number;
      reason: string;
    };
    expect(parsed.result_code).toBe(401);
    expect(parsed.reason).toBe("unauthorized");
  });

  test("429 writes a deployment.annotation_rejected audit row", async () => {
    handle = startServer();
    for (let i = 0; i < 60; i++) {
      await fetch(urlFor(handle), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ...VALID_BODY, sha: `b1c2d3${i.toString(16).padStart(2, "0")}` }),
      });
    }
    await fetch(urlFor(handle), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(VALID_BODY),
    });
    handle.stop();
    handle = null;
    const reader = new Database(dbPath, { readonly: true });
    const rows = reader
      .query(
        `SELECT action_type, action_json
           FROM audit_log
          WHERE action_type = 'deployment.annotation_rejected'
            AND action_json LIKE '%"reason":"rate_limited"%'
          ORDER BY id DESC`,
      )
      .all() as Array<{ action_type: string; action_json: string }>;
    reader.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(rows[0].action_json) as {
      result_code: number;
      reason: string;
    };
    expect(parsed.result_code).toBe(429);
    expect(parsed.reason).toBe("rate_limited");
    // 61 sequential HTTP round-trips: slow on Windows CI runners; see note above.
  }, 30_000);
});
