import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createBitriseSyncable } from "../../../src/connectors/bitrise-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface FakeBitrise {
  baseUrl: string;
  requests: { method: string; path: string; auth: string | null }[];
  stop(): void;
}

function startFakeBitrise(): FakeBitrise {
  const requests: { method: string; path: string; auth: string | null }[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
      });
      if (req.method === "GET" && u.pathname === "/v0.1/me/apps") {
        return Response.json({
          data: [
            {
              slug: "ios-app-slug",
              title: "Acme iOS",
              project_type: "ios",
              repo_url: "https://github.com/acme/ios.git",
              default_branch_name: "main",
              is_disabled: false,
            },
            {
              slug: "android-app-slug",
              title: "Acme Android",
              project_type: "android",
              repo_url: "https://github.com/acme/android.git",
              default_branch_name: "develop",
              is_disabled: false,
            },
          ],
        });
      }
      const buildsMatch = /^\/v0\.1\/apps\/([^/]+)\/builds$/.exec(u.pathname);
      if (req.method === "GET" && buildsMatch !== null) {
        const slug = decodeURIComponent(buildsMatch[1] ?? "");
        const buildSlug = slug === "ios-app-slug" ? "build-ios-1" : "build-android-1";
        return Response.json({
          data: [
            {
              slug: buildSlug,
              build_number: slug === "ios-app-slug" ? 42 : 7,
              status: slug === "ios-app-slug" ? 1 : 2,
              status_text: slug === "ios-app-slug" ? "success" : "error",
              triggered_workflow: slug === "ios-app-slug" ? "primary" : "release",
              triggered_at: "2026-05-21T10:00:00.000Z",
              started_on_worker_at: "2026-05-21T10:00:30.000Z",
              finished_at: "2026-05-21T10:08:30.000Z",
              branch: slug === "ios-app-slug" ? "main" : "feature/release",
              commit_hash: slug === "ios-app-slug" ? "deadbeef" : "cafebabe",
              commit_message: slug === "ios-app-slug" ? "Ship 1.2" : "Prep release",
              triggered_by: "asaf@acme.example",
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
  fake: FakeBitrise;
  originalFetch: typeof globalThis.fetch;
  cleanup: () => void;
}

function startHarness(): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeBitrise();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://api.bitrise.io", fake.baseUrl);
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
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "bitrise"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(),
    },
  };
}

describe("bitrise-sync against Bun.serve fake API", () => {
  let h: Harness;
  beforeEach(async () => {
    h = startHarness();
    await h.vault.set("bitrise.token", "fake-bitrise-token");
  });
  afterEach(() => h.cleanup());

  test("walks me/apps → apps/<slug>/builds and upserts well-formed rows", async () => {
    const syncable = createBitriseSyncable({ ensureBitriseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(4);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-bitrise1:")).toBe(true);

    expect(h.fake.requests.length).toBeGreaterThan(0);
    for (const r of h.fake.requests) {
      expect(r.auth).toBe("fake-bitrise-token");
    }

    const meAppsCalls = h.fake.requests.filter((r) => r.path === "/v0.1/me/apps");
    expect(meAppsCalls).toHaveLength(1);

    const appRows = h.db
      .query<{ external_id: string; title: string }, []>(
        "SELECT external_id, title FROM item WHERE service = 'bitrise' AND type = 'app' ORDER BY external_id",
      )
      .all();
    expect(appRows.map((r) => r.external_id)).toEqual(["android-app-slug", "ios-app-slug"]);

    const buildRows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'bitrise' AND type = 'build' ORDER BY external_id",
      )
      .all();
    expect(buildRows.map((r) => r.external_id)).toEqual([
      "android-app-slug/build-android-1",
      "ios-app-slug/build-ios-1",
    ]);

    const ios = JSON.parse(buildRows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(ios["status"]).toBe("success");
    expect(ios["workflow_id"]).toBe("primary");
    expect(ios["branch"]).toBe("main");
    expect(ios["app_slug"]).toBe("ios-app-slug");
    expect(ios["duration_ms"]).toBe(
      Date.parse("2026-05-21T10:08:30.000Z") - Date.parse("2026-05-21T10:00:30.000Z"),
    );

    const android = JSON.parse(buildRows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(android["status"]).toBe("error");
    expect(android["workflow_id"]).toBe("release");
  });

  test("no-op when bitrise.token is unset", async () => {
    await h.vault.delete("bitrise.token");
    const syncable = createBitriseSyncable({ ensureBitriseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });
});
