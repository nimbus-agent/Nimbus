import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createSemgrepSyncable } from "../../../src/connectors/semgrep-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  search: URLSearchParams;
}

interface FakeSemgrep {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeSemgrep(): FakeSemgrep {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
        search: u.searchParams,
      });
      if (req.method === "GET" && u.pathname === "/api/v1/deployments") {
        return Response.json({
          deployments: [{ id: 1, slug: "acme-corp", name: "Acme Corp" }],
        });
      }
      const findingsMatch = /^\/api\/v1\/deployments\/([^/]+)\/findings$/.exec(u.pathname);
      if (req.method === "GET" && findingsMatch !== null) {
        return Response.json({
          findings: [
            {
              id: "f-1001",
              rule_name: "javascript.lang.security.audit.xss.direct-response-write",
              rule_message: "User input flows into HTTP response without escaping.",
              severity: "high",
              confidence: "high",
              categories: ["security"],
              location: { file_path: "src/api/user.js", line: 42 },
              repository: { name: "acme/payments" },
              ref: "main",
              triage_state: "untriaged",
              status: "open",
              created_at: "2024-03-15T12:00:00.000Z",
              relevant_since: "2024-03-16T09:30:00.000Z",
            },
            {
              id: "f-1002",
              rule_name: "python.django.security.audit.sql-injection",
              rule_message: "Unsanitized SQL — possible injection.",
              severity: "critical",
              confidence: "high",
              categories: ["security"],
              location: { file_path: "backend/views.py", line: 99 },
              repository: { name: "acme/payments" },
              ref: "main",
              triage_state: "untriaged",
              status: "open",
              created_at: "2024-03-14T08:00:00.000Z",
              relevant_since: "2024-03-14T08:00:00.000Z",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return {
    baseUrl,
    requests,
    stop: () => server?.stop(true),
  };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeSemgrep;
  cleanup: () => void;
}

function startHarness(): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeSemgrep();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://semgrep.dev", fake.baseUrl);
    return originalFetch(rewritten, init);
  };
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "semgrep"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(),
    },
  };
}

describe("semgrep-sync against Bun.serve fake API", () => {
  let h: Harness;
  beforeEach(async () => {
    h = startHarness();
    await h.vault.set("semgrep.token", "fake-semgrep-token");
  });
  afterEach(() => h.cleanup());

  test("discovers deployment slug → walks findings and upserts well-formed rows", async () => {
    const syncable = createSemgrepSyncable({ ensureSemgrepMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-semgrep1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.auth).toBe("Bearer fake-semgrep-token");
    }
    const deploymentCalls = h.fake.requests.filter((r) => r.path === "/api/v1/deployments");
    expect(deploymentCalls).toHaveLength(1);

    const rows = h.db
      .query<{ external_id: string; title: string; metadata: string }, []>(
        "SELECT external_id, title, metadata FROM item WHERE service = 'semgrep' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["f-1001", "f-1002"]);
    const xss = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(xss["severity"]).toBe("high");
    expect(xss["rule_name"]).toBe("javascript.lang.security.audit.xss.direct-response-write");
    expect(xss["file_path"]).toBe("src/api/user.js");
    expect(xss["deployment_slug"]).toBe("acme-corp");
    const sqli = JSON.parse(rows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(sqli["severity"]).toBe("critical");
  });

  test("when deployment_slug is preset, skips the /deployments discovery round-trip", async () => {
    await h.vault.set("semgrep.deployment_slug", "acme-corp");
    const syncable = createSemgrepSyncable({ ensureSemgrepMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);
    const deploymentCalls = h.fake.requests.filter((r) => r.path === "/api/v1/deployments");
    expect(deploymentCalls).toHaveLength(0);
  });

  test("findings endpoint receives open-status + page_size filters", async () => {
    const syncable = createSemgrepSyncable({ ensureSemgrepMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);
    const findingsCalls = h.fake.requests.filter(
      (r) => r.path === "/api/v1/deployments/acme-corp/findings",
    );
    expect(findingsCalls.length).toBeGreaterThan(0);
    const call = findingsCalls[0];
    if (call === undefined) throw new Error("expected findings call");
    expect(call.search.get("statuses")).toBe("open");
    expect(call.search.get("page_size")).toBe("100");
  });

  test("noop when semgrep.token is unset", async () => {
    await h.vault.delete("semgrep.token");
    const syncable = createSemgrepSyncable({ ensureSemgrepMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });
});
