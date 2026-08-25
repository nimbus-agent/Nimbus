import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createSonarqubeSyncable } from "../../../src/connectors/sonarqube-sync.ts";
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

interface FakeSonar {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeSonar(): FakeSonar {
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
      if (req.method === "GET" && u.pathname === "/api/components/search") {
        return Response.json({
          components: [
            { key: "myorg_web", name: "Web", qualifier: "TRK" },
            { key: "myorg_api", name: "API", qualifier: "TRK" },
          ],
          paging: { pageIndex: 1, pageSize: 100, total: 2 },
        });
      }
      if (req.method === "GET" && u.pathname === "/api/issues/search") {
        const componentKeysParam = u.searchParams.get("componentKeys") ?? "";
        const projectKeys = componentKeysParam.split(",");

        const issues = projectKeys.map((projectKey) => {
          const issueKey = projectKey === "myorg_web" ? "AYxr-web-1" : "AYxr-api-1";
          return {
            key: issueKey,
            rule: "java:S1234",
            severity: projectKey === "myorg_web" ? "MAJOR" : "CRITICAL",
            component: `${projectKey}:src/main/java/Foo.java`,
            project: projectKey,
            line: 42,
            status: "OPEN",
            message:
              projectKey === "myorg_web"
                ? "Replace null check with Optional"
                : "Use parameterized query to avoid SQL injection",
            effort: "10min",
            debt: "10min",
            tags: ["security"],
            creationDate: "2024-03-15T12:00:00+0000",
            updateDate: "2024-03-16T09:30:00+0000",
            type: projectKey === "myorg_web" ? "CODE_SMELL" : "VULNERABILITY",
          };
        });

        return Response.json({
          issues: issues,
          paging: { pageIndex: 1, pageSize: 100, total: issues.length },
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
  fake: FakeSonar;
  cleanup: () => void;
}

function startHarness(): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeSonar();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://sonarcloud.io", fake.baseUrl);
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
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "sonarqube"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(),
    },
  };
}

describe("sonarqube-sync against Bun.serve fake API", () => {
  let h: Harness;
  beforeEach(async () => {
    h = startHarness();
    await h.vault.set("sonarqube.token", "fake-sq-token");
    await h.vault.set("sonarqube.organization", "myorg");
  });
  afterEach(() => h.cleanup());

  test("walks projects → issues and upserts well-formed rows (SaaS)", async () => {
    const syncable = createSonarqubeSyncable({ ensureSonarqubeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-sonarqube1:")).toBe(true);

    expect(h.fake.requests.length).toBeGreaterThan(0);
    for (const r of h.fake.requests) {
      expect(r.auth).toBe("Bearer fake-sq-token");
    }

    const projectCalls = h.fake.requests.filter((r) => r.path === "/api/components/search");
    expect(projectCalls).toHaveLength(1);
    expect(projectCalls[0]?.search.get("organization")).toBe("myorg");
    expect(projectCalls[0]?.search.get("qualifiers")).toBe("TRK");

    const rows = h.db
      .query<{ external_id: string; title: string; metadata: string }, []>(
        "SELECT external_id, title, metadata FROM item WHERE service = 'sonarqube' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["AYxr-api-1", "AYxr-web-1"]);
    const api = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(api["severity"]).toBe("CRITICAL");
    expect(api["type"]).toBe("VULNERABILITY");
    expect(api["status"]).toBe("OPEN");
    expect(api["project_key"]).toBe("myorg_api");
    expect(api["file_path"]).toBe("src/main/java/Foo.java");
    expect(api["organization"]).toBe("myorg");
    const web = JSON.parse(rows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(web["severity"]).toBe("MAJOR");
    expect(web["type"]).toBe("CODE_SMELL");
  });

  test("issues endpoint receives the open-status + type filter as query params", async () => {
    const syncable = createSonarqubeSyncable({ ensureSonarqubeMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const issueCalls = h.fake.requests.filter((r) => r.path === "/api/issues/search");
    expect(issueCalls.length).toBeGreaterThan(0);
    const call = issueCalls[0];
    if (call === undefined) throw new Error("expected issue call");
    expect(call.search.get("statuses")).toBe("OPEN,CONFIRMED,REOPENED");
    expect(call.search.get("types")).toBe("BUG,VULNERABILITY,CODE_SMELL");
    expect(call.search.get("ps")).toBe("100");
    expect(call.search.get("p")).toBe("1");
  });

  test("noop when sonarqube.token is unset", async () => {
    await h.vault.delete("sonarqube.token");
    const syncable = createSonarqubeSyncable({ ensureSonarqubeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("HTTP 4xx on components/search returns a fresh pass cursor and no rows", async () => {
    h.fake.stop();
    let server: Server | undefined;
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/api/components/search") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const newBase = `http://${server.hostname}:${server.port}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const rewritten = url.replace("https://sonarcloud.io", newBase);
      return originalFetch(rewritten, init);
    };
    try {
      const syncable = createSonarqubeSyncable({ ensureSonarqubeMcpRunning: async () => {} });
      const result = await syncable.sync(h.ctx, null);
      expect(result.itemsUpserted).toBe(0);
      expect(result.cursor?.startsWith("nimbus-sonarqube1:")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      server?.stop(true);
    }
  });
});
