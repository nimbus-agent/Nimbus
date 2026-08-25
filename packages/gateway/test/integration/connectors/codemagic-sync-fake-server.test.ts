import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createCodemagicSyncable } from "../../../src/connectors/codemagic-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface FakeCodemagic {
  baseUrl: string;
  requests: { method: string; path: string; auth: string | null }[];
  stop(): void;
}

function startFakeCodemagic(): FakeCodemagic {
  const requests: { method: string; path: string; auth: string | null }[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("x-auth-token"),
      });
      if (req.method === "GET" && u.pathname === "/apps") {
        return Response.json({
          applications: [
            {
              _id: "ios-app-id",
              appName: "Acme iOS",
              repository: { url: "https://github.com/acme/ios.git" },
              workflowIds: ["primary"],
              branches: ["main"],
            },
            {
              _id: "android-app-id",
              appName: "Acme Android",
              repository: { url: "https://github.com/acme/android.git" },
              workflowIds: ["release"],
              branches: ["develop"],
            },
          ],
        });
      }
      if (req.method === "GET" && u.pathname === "/builds") {
        const appId = u.searchParams.get("appId") ?? "";
        const buildId = appId === "ios-app-id" ? "build-ios-1" : "build-android-1";
        return Response.json({
          builds: [
            {
              _id: buildId,
              appId,
              workflowId: appId === "ios-app-id" ? "primary" : "release",
              branch: appId === "ios-app-id" ? "main" : "feature/release",
              version: appId === "ios-app-id" ? "1.2.0" : "0.9.0",
              status: appId === "ios-app-id" ? "finished" : "failed",
              startedAt: "2026-05-21T10:00:30.000Z",
              finishedAt: "2026-05-21T10:08:30.000Z",
              message: appId === "ios-app-id" ? "Ship 1.2" : "Prep release",
              commit: { hash: appId === "ios-app-id" ? "deadbeef" : "cafebabe" },
            },
          ],
          applications: [],
          buildsTotal: 1,
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
  fake: FakeCodemagic;
  originalFetch: typeof globalThis.fetch;
  cleanup: () => void;
}

function startHarness(): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeCodemagic();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://api.codemagic.io", fake.baseUrl);
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
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "codemagic"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(),
    },
  };
}

describe("codemagic-sync against Bun.serve fake API", () => {
  let h: Harness;
  beforeEach(async () => {
    h = startHarness();
    await h.vault.set("codemagic.token", "fake-codemagic-token");
  });
  afterEach(() => h.cleanup());

  test("walks /apps → /builds?appId and upserts well-formed rows", async () => {
    const syncable = createCodemagicSyncable({ ensureCodemagicMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(4);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-codemagic1:")).toBe(true);

    expect(h.fake.requests.length).toBeGreaterThan(0);
    for (const r of h.fake.requests) {
      expect(r.auth).toBe("fake-codemagic-token");
    }

    const appsCalls = h.fake.requests.filter((r) => r.path === "/apps");
    expect(appsCalls).toHaveLength(1);

    const appRows = h.db
      .query<{ external_id: string; title: string }, []>(
        "SELECT external_id, title FROM item WHERE service = 'codemagic' AND type = 'app' ORDER BY external_id",
      )
      .all();
    expect(appRows.map((r) => r.external_id)).toEqual(["android-app-id", "ios-app-id"]);

    const buildRows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'codemagic' AND type = 'build' ORDER BY external_id",
      )
      .all();
    expect(buildRows.map((r) => r.external_id)).toEqual([
      "android-app-id/build-android-1",
      "ios-app-id/build-ios-1",
    ]);

    const ios = JSON.parse(buildRows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(ios["status"]).toBe("finished");
    expect(ios["workflow_id"]).toBe("primary");
    expect(ios["branch"]).toBe("main");
    expect(ios["app_id"]).toBe("ios-app-id");
    expect(ios["duration_ms"]).toBe(
      Date.parse("2026-05-21T10:08:30.000Z") - Date.parse("2026-05-21T10:00:30.000Z"),
    );

    const android = JSON.parse(buildRows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(android["status"]).toBe("failed");
    expect(android["workflow_id"]).toBe("release");
  });

  test("no-op when codemagic.token is unset", async () => {
    await h.vault.delete("codemagic.token");
    const syncable = createCodemagicSyncable({ ensureCodemagicMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });
});
