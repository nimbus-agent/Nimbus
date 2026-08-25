import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createSnykSyncable } from "../../../src/connectors/snyk-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface FakeSnyk {
  baseUrl: string;
  requests: { method: string; path: string; auth: string | null; body: string | null }[];
  stop(): void;
}

function startFakeSnyk(): FakeSnyk {
  const requests: { method: string; path: string; auth: string | null; body: string | null }[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      const body = req.method === "GET" ? null : await req.text();
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
        body: body === "" ? null : body,
      });
      if (req.method === "GET" && u.pathname === "/v1/orgs") {
        return Response.json({
          orgs: [
            { id: "org-acme", name: "Acme" },
            { id: "org-globex", name: "Globex" },
          ],
        });
      }
      const projMatch = /^\/v1\/org\/([^/]+)\/projects$/.exec(u.pathname);
      if (req.method === "GET" && projMatch !== null) {
        const orgId = decodeURIComponent(projMatch[1] ?? "");
        return Response.json({
          projects:
            orgId === "org-acme"
              ? [{ id: "proj-web", name: "acme/web" }]
              : [{ id: "proj-api", name: "globex/api" }],
        });
      }
      const issuesMatch = /^\/v1\/org\/([^/]+)\/project\/([^/]+)\/aggregated-issues$/.exec(
        u.pathname,
      );
      if (req.method === "POST" && issuesMatch !== null) {
        const orgId = decodeURIComponent(issuesMatch[1] ?? "");
        const issueId =
          orgId === "org-acme" ? "SNYK-JS-LODASH-1018905" : "SNYK-LINUX-OPENSSL-7654321";
        return Response.json({
          issues: [
            {
              id: issueId,
              issueType: "vuln",
              pkgName: orgId === "org-acme" ? "lodash" : "openssl",
              pkgVersions: [orgId === "org-acme" ? "4.17.20" : "1.1.1k"],
              issueData: {
                id: issueId,
                title:
                  orgId === "org-acme"
                    ? "Prototype Pollution in lodash"
                    : "Heap overflow in openssl",
                severity: orgId === "org-acme" ? "high" : "critical",
                url: `https://security.snyk.io/vuln/${issueId}`,
                description: "Detailed paragraph-shaped vulnerability description.",
                identifiers: {
                  CVE: orgId === "org-acme" ? ["CVE-2020-8203"] : ["CVE-2022-0778"],
                },
                publicationTime: "2022-01-01T00:00:00.000Z",
                disclosureTime: "2021-12-31T00:00:00.000Z",
              },
              fixInfo: { isFixable: true, fixedIn: ["NEXT"] },
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
  fake: FakeSnyk;
  originalFetch: typeof globalThis.fetch;
  cleanup: () => void;
}

function startHarness(): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeSnyk();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://api.snyk.io", fake.baseUrl);
    return originalFetch(rewritten, init);
  };
  return {
    db,
    vault,
    fake,
    originalFetch,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "snyk"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(),
    },
  };
}

describe("snyk-sync against Bun.serve fake API", () => {
  let h: Harness;
  beforeEach(async () => {
    h = startHarness();
    await h.vault.set("snyk.token", "fake-token-xyz");
  });
  afterEach(() => h.cleanup());

  test("walks orgs → projects → issues and upserts well-formed rows", async () => {
    const syncable = createSnykSyncable({ ensureSnykMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-snyk1:")).toBe(true);

    expect(h.fake.requests.length).toBeGreaterThan(0);
    for (const r of h.fake.requests) {
      expect(r.auth).toBe("token fake-token-xyz");
    }
    const orgCalls = h.fake.requests.filter((r) => r.path === "/v1/orgs");
    expect(orgCalls).toHaveLength(1);

    const rows = h.db
      .query<{ external_id: string; title: string; metadata: string }, []>(
        "SELECT external_id, title, metadata FROM item WHERE service = 'snyk' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "org-acme/proj-web/SNYK-JS-LODASH-1018905",
      "org-globex/proj-api/SNYK-LINUX-OPENSSL-7654321",
    ]);
    const acme = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(acme["severity"]).toBe("high");
    expect(acme["cve_id"]).toBe("CVE-2020-8203");
    expect(acme["affected_package"]).toBe("lodash");
    const globex = JSON.parse(rows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(globex["severity"]).toBe("critical");
    expect(globex["cve_id"]).toBe("CVE-2022-0778");
  });
});
