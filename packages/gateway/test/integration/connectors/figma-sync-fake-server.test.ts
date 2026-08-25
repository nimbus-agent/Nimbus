import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { createFigmaSyncable } from "../../../src/connectors/figma-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { installHostInterceptFetch } from "../../helpers/host-intercept-fetch.ts";

const BASE = "https://api.figma.com";
const TEAM_ID = "1234567890";

interface RecordedReq {
  method: string;
  pathname: string;
  auth: string | null;
}

interface FakeConfig {
  // pathname → response JSON body
  routes?: Record<string, unknown>;
  // pathname → forced HTTP status (overrides routes for that path)
  status?: Record<string, number>;
  // global forced status (applies to every figma request)
  globalStatus?: number;
}

interface FakeServer {
  requests: RecordedReq[];
  fetch: typeof globalThis.fetch;
  restore: () => void;
}

function installFakeFetch(config: FakeConfig): FakeServer {
  return installHostInterceptFetch<RecordedReq>({
    base: BASE,
    record: (u, init) => ({
      method: init?.method ?? "GET",
      pathname: u.pathname,
      auth: new Headers(init?.headers).get("authorization"),
    }),
    respond: (req) => {
      if (config.globalStatus !== undefined && config.globalStatus !== 200) {
        return new Response("error", { status: config.globalStatus });
      }
      const forced = config.status?.[req.pathname];
      if (forced !== undefined && forced !== 200) {
        return new Response("error", { status: forced });
      }
      const body = config.routes?.[req.pathname] ?? {};
      return Response.json(body);
    },
  });
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeServer;
  cleanup: () => void;
}

function startHarness(config: FakeConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = installFakeFetch(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.restore();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "figma"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        figma: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function projectsPath(): string {
  return `/v1/teams/${TEAM_ID}/projects`;
}

function filesPath(projectId: string): string {
  return `/v1/projects/${projectId}/files`;
}

function fileObj(key: string, name: string): unknown {
  return {
    key,
    name,
    thumbnail_url: `https://s3-alpha.figma.com/thumb/${key}`,
    last_modified: "2026-05-20T00:00:00Z",
  };
}

/** Set a non-expired figma.oauth payload + the team id so both keys are present. */
async function setCreds(h: Harness): Promise<void> {
  await h.vault.set(
    "figma.oauth",
    JSON.stringify({
      accessToken: "figma-access",
      refreshToken: "figma-refresh",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["files:read"],
    }),
  );
  await h.vault.set("figma.team_id", TEAM_ID);
}

describe("figma-sync against a fake api.figma.com", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: two-level fetch flattens files across 2 projects, Bearer header, pass-1 cursor", async () => {
    h = startHarness({
      routes: {
        [projectsPath()]: {
          name: "Acme",
          projects: [
            { id: "p1", name: "Design System" },
            { id: "p2", name: "Marketing" },
          ],
        },
        [filesPath("p1")]: {
          name: "Design System",
          files: [fileObj("k1", "Buttons"), fileObj("k2", "Colors")],
        },
        [filesPath("p2")]: { name: "Marketing", files: [fileObj("k3", "Landing")] },
      },
    });
    await setCreds(h);

    const syncable = createFigmaSyncable({ ensureFigmaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-figma1:")).toBe(true);

    // One projects call + one files call per project.
    expect(h.fake.requests.filter((r) => r.pathname === projectsPath())).toHaveLength(1);
    expect(h.fake.requests.filter((r) => r.pathname === filesPath("p1"))).toHaveLength(1);
    expect(h.fake.requests.filter((r) => r.pathname === filesPath("p2"))).toHaveLength(1);
    expect(h.fake.requests[0]?.auth).toBe("Bearer figma-access");

    const rows = h.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'figma' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["k1", "k2", "k3"]);
  });

  test("noop when figma.oauth set but figma.team_id missing — no requests", async () => {
    h = startHarness({ routes: { [projectsPath()]: { projects: [] } } });
    await h.vault.set(
      "figma.oauth",
      JSON.stringify({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["files:read"],
      }),
    );
    // team_id intentionally unset
    const syncable = createFigmaSyncable({ ensureFigmaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("noop when neither key is set — no requests", async () => {
    h = startHarness({ routes: { [projectsPath()]: { projects: [] } } });
    const syncable = createFigmaSyncable({ ensureFigmaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 (rate-limited) on the projects call degrades gracefully — no throw, zero upserts, pass-1 cursor", async () => {
    h = startHarness({ globalStatus: 429 });
    await setCreds(h);
    const syncable = createFigmaSyncable({ ensureFigmaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-figma1:")).toBe(true);
  });

  test("a 401 (auth failure) on the projects call degrades gracefully — cursor preserved", async () => {
    h = startHarness({ globalStatus: 401 });
    await setCreds(h);
    const syncable = createFigmaSyncable({ ensureFigmaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, "nimbus-figma1:prev");
    expect(result.itemsUpserted).toBe(0);
    // First-page (projects) http error preserves the incoming cursor.
    expect(result.cursor).toBe("nimbus-figma1:prev");
  });

  test("a failing files call for one project is skipped; other projects still upsert", async () => {
    h = startHarness({
      routes: {
        [projectsPath()]: {
          projects: [
            { id: "p1", name: "Design System" },
            { id: "p2", name: "Marketing" },
          ],
        },
        [filesPath("p2")]: { files: [fileObj("k3", "Landing")] },
      },
      // p1's files call 500s; p2 succeeds.
      status: { [filesPath("p1")]: 500 },
    });
    await setCreds(h);

    const syncable = createFigmaSyncable({ ensureFigmaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    // Only p2's file lands; the p1 failure is skipped, not thrown.
    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-figma1:")).toBe(true);

    const rows = h.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'figma'")
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["k3"]);
  });

  test("empty team (no projects) yields zero upserts and a pass-1 cursor", async () => {
    h = startHarness({ routes: { [projectsPath()]: { projects: [] } } });
    await setCreds(h);
    const syncable = createFigmaSyncable({ ensureFigmaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-figma1:")).toBe(true);
    // Only the projects call fired; no files calls.
    expect(h.fake.requests.filter((r) => r.pathname === projectsPath())).toHaveLength(1);
    expect(h.fake.requests.filter((r) => r.pathname.startsWith("/v1/projects/"))).toHaveLength(0);
  });
});
