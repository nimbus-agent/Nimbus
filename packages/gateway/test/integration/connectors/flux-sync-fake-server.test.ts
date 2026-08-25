import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createFluxSyncable } from "../../../src/connectors/flux-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
}

interface FakeFluxConfig {
  lists: Record<string, unknown[]>;
  statusByPlural?: Record<string, number>;
}

interface FakeFlux {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function pluralFromPath(pathname: string): string | null {
  const m = /^\/apis\/[^/]+\/[^/]+\/([^/]+)$/.exec(pathname);
  return m === null ? null : (m[1] ?? null);
}

function startFakeFlux(config: FakeFluxConfig): FakeFlux {
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
      });
      const plural = pluralFromPath(u.pathname);
      if (plural !== null) {
        const override = config.statusByPlural?.[plural];
        if (override !== undefined && override !== 200) {
          return new Response("error", { status: override });
        }
        const items = config.lists[plural];
        if (items === undefined) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({ apiVersion: "v1", kind: "List", items });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeFlux;
  cleanup: () => void;
}

function startHarness(config: FakeFluxConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeFlux(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "flux"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        flux: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function ksItem(
  name: string,
  over: { ready?: string; reason?: string; namespace?: string } = {},
): Record<string, unknown> {
  return {
    metadata: {
      name,
      namespace: over.namespace ?? "flux-system",
      creationTimestamp: "2021-02-10T20:03:11Z",
    },
    spec: { path: "./kustomize", suspend: false },
    status: {
      conditions: [
        {
          type: "Ready",
          status: over.ready ?? "True",
          reason: over.reason ?? "ReconciliationSucceeded",
          message: "ok",
          lastTransitionTime: "2021-03-01T10:00:00Z",
        },
      ],
      lastAppliedRevision: "main@sha1:abc",
    },
  };
}

function hrItem(name: string, ready: string): Record<string, unknown> {
  return {
    metadata: { name, namespace: "apps", creationTimestamp: "2021-02-11T00:00:00Z" },
    spec: {},
    status: {
      conditions: [{ type: "Ready", status: ready, reason: "InstallFailed", message: "boom" }],
    },
  };
}

function gitRepoItem(name: string): Record<string, unknown> {
  return {
    metadata: { name, namespace: "flux-system", creationTimestamp: "2021-01-01T00:00:00Z" },
    spec: { url: "https://github.com/acme/podinfo" },
    status: { conditions: [{ type: "Ready", status: "True", reason: "Succeeded" }] },
  };
}

describe("flux-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: walks CRDs, upserts well-formed rows with Bearer auth", async () => {
    h = startHarness({
      lists: {
        kustomizations: [ksItem("podinfo", { ready: "True" })],
        helmreleases: [hrItem("redis", "False")],
        gitrepositories: [gitRepoItem("podinfo-src")],
      },
    });
    await h.vault.set("flux.api_url", h.fake.baseUrl);
    await h.vault.set("flux.token", "sa-jwt-token");

    const syncable = createFluxSyncable({ ensureFluxMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-flux1:")).toBe(true);

    expect(h.fake.requests.length).toBeGreaterThan(0);
    for (const r of h.fake.requests) {
      expect(r.auth).toBe("Bearer sa-jwt-token");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'flux' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "git_repository/flux-system/podinfo-src",
      "helm_release/apps/redis",
      "kustomization/flux-system/podinfo",
    ]);

    const ks = rows.find((r) => r.external_id === "kustomization/flux-system/podinfo");
    const ksMeta = JSON.parse(ks?.metadata ?? "{}") as Record<string, unknown>;
    expect(ksMeta["kind"]).toBe("kustomization");
    expect(ksMeta["namespace"]).toBe("flux-system");
    expect(ksMeta["ready_status"]).toBe("True");

    const hr = rows.find((r) => r.external_id === "helm_release/apps/redis");
    const hrMeta = JSON.parse(hr?.metadata ?? "{}") as Record<string, unknown>;
    expect(hrMeta["kind"]).toBe("helm_release");
    expect(hrMeta["ready_status"]).toBe("False");
  });

  test("noop when flux.api_url set but flux.token unset — no requests", async () => {
    h = startHarness({ lists: { kustomizations: [ksItem("x")] } });
    await h.vault.set("flux.api_url", h.fake.baseUrl);
    const syncable = createFluxSyncable({ ensureFluxMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("noop when flux.token set but flux.api_url unset — no requests", async () => {
    h = startHarness({ lists: { kustomizations: [ksItem("x")] } });
    await h.vault.set("flux.token", "tok");
    const syncable = createFluxSyncable({ ensureFluxMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 5xx on one CRD endpoint is non-fatal — other kinds still upsert", async () => {
    h = startHarness({
      lists: { kustomizations: [ksItem("podinfo")] },
      statusByPlural: { helmreleases: 500 },
    });
    await h.vault.set("flux.api_url", h.fake.baseUrl);
    await h.vault.set("flux.token", "tok");

    const syncable = createFluxSyncable({ ensureFluxMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-flux1:")).toBe(true);

    const row = h.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'flux'")
      .get();
    expect(row?.external_id).toBe("kustomization/flux-system/podinfo");
  });

  test("a 401 on one CRD endpoint is non-fatal — no throw", async () => {
    h = startHarness({
      lists: { kustomizations: [ksItem("podinfo")] },
      statusByPlural: { gitrepositories: 401 },
    });
    await h.vault.set("flux.api_url", h.fake.baseUrl);
    await h.vault.set("flux.token", "tok");

    const syncable = createFluxSyncable({ ensureFluxMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
  });

  test("a resource with no status.conditions still maps (ready_status null)", async () => {
    const bare: Record<string, unknown> = {
      metadata: { name: "bare-ks", namespace: "flux-system" },
      spec: {},
      status: {},
    };
    h = startHarness({ lists: { kustomizations: [bare] } });
    await h.vault.set("flux.api_url", h.fake.baseUrl);
    await h.vault.set("flux.token", "tok");

    const syncable = createFluxSyncable({ ensureFluxMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);

    const row = h.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE external_id = 'kustomization/flux-system/bare-ks'",
      )
      .get();
    const m = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["ready_status"]).toBeNull();
  });
});
