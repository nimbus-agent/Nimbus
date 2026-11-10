/**
 * GitHub Enterprise Server, end to end at the seams (no GHES can be reached from a test, and the
 * base is https-only, so there is no loopback server to point at): the REAL `connector.auth github`
 * handler stores `github.api_base`, the REAL GitHub sync indexes a PR whose URL is on the GHES host
 * (fetch stubbed for that host only), and the REAL `GET /v1/items/resolve` route, with the same
 * `deriveFetchHostMap` boundary the gateway wires, finds it, while github.com is not fetchable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { syncTestContext } from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createGithubSyncable } from "../../../src/connectors/github-sync.ts";
import type { LazyConnectorMesh } from "../../../src/connectors/lazy-mesh/mesh.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { handleConnectorAuth } from "../../../src/ipc/connector-rpc-handlers/auth.ts";
import type { ConnectorRpcHandlerContext } from "../../../src/ipc/connector-rpc-handlers/context.ts";
import { startServerWithClipToken } from "../../../src/ipc/http-api-test-server.ts";
import { deriveFetchHostMap, serviceForHost } from "../../../src/sync/fetch-host-boundary.ts";
import { setSchedulerCursor } from "../../../src/sync/scheduler-store.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import type { NimbusVault } from "../../../src/vault/nimbus-vault.ts";

const GHES_API = "https://ghe.example.com/api/v3";
const GHES_PR = "https://ghe.example.com/acme/web/pull/7";
const DOTCOM_PR = "https://github.com/acme/web/pull/7";

const realFetch = globalThis.fetch;
let ghesCalls: string[] = [];
let restarts = 0;

beforeEach(() => {
  ghesCalls = [];
  restarts = 0;
  // Only the GHES / api.github.com hosts are stubbed; the test's own loopback HTTP goes through.
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : ((input as { url?: string }).url ?? String(input));
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    ghesCalls.push(url);
    if (url === `${GHES_API}/user`) {
      return Promise.resolve(new Response(JSON.stringify({ login: "octo" }), { status: 200 }));
    }
    if (url.startsWith(`${GHES_API}/users/octo/events`)) {
      const events = [
        {
          id: "1",
          type: "PullRequestEvent",
          repo: { name: "acme/web", full_name: "acme/web" },
          created_at: "2026-11-01T00:00:00Z",
          payload: {
            action: "opened",
            pull_request: {
              number: 7,
              title: "Fix the thing",
              body: "",
              html_url: GHES_PR,
              user: { login: "octo" },
              state: "open",
            },
          },
        },
      ];
      return Promise.resolve(new Response(JSON.stringify(events), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function authCtx(
  vault: NimbusVault,
  localIndex: LocalIndex,
  fields: Record<string, unknown>,
): ConnectorRpcHandlerContext {
  return {
    rec: { service: "github", personalAccessToken: "ghp_e2e", ...fields },
    vault,
    localIndex,
    openUrl: async () => {},
    syncScheduler: undefined,
    connectorMesh: {
      restartGithub: () => {
        restarts += 1;
      },
    } as unknown as LazyConnectorMesh,
    appendProbeEgress: () => {},
    runCredentialProbe: async () => ({ kind: "valid", scopes: ["repo"] }),
  };
}

async function resolve(port: number, token: string, url: string): Promise<unknown> {
  const res = await realFetch(
    `http://127.0.0.1:${port}/v1/items/resolve?url=${encodeURIComponent(url)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(res.status).toBe(200);
  return res.json();
}

describe("GitHub Enterprise Server end to end (the seams)", () => {
  test("auth with --api-base, sync indexes a PR with a GHES canonical url, resolve finds it, and github.com is not fetchable", async () => {
    const vault = createMockVault();
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"], {
      resolveFetchable: async () => {
        const map = await deriveFetchHostMap(vault);
        return (host: string) => serviceForHost(map, host) !== null;
      },
    });
    try {
      const localIndex = new LocalIndex(db);
      await handleConnectorAuth(
        authCtx(vault, localIndex, { apiBaseUrl: "https://ghe.example.com" }),
      );
      expect(await vault.get("github.api_base")).toBe(GHES_API);
      expect(restarts).toBe(1);

      const ctx = syncTestContext(db, vault, "github");
      const result = await createGithubSyncable({
        ensureGithubMcpRunning: async (): Promise<void> => {},
      }).sync(ctx, null);
      expect(result.itemsUpserted).toBeGreaterThan(0);
      expect(ghesCalls.every((u) => u.startsWith("https://ghe.example.com/"))).toBe(true);
      const row = db
        .query("SELECT url, canonical_url FROM item WHERE external_id = 'acme/web#7'")
        .get() as { url: string; canonical_url: string };
      expect(row.url).toBe(GHES_PR);
      expect(row.canonical_url).toBe(GHES_PR);

      expect(await resolve(port, token, GHES_PR)).toMatchObject({
        found: true,
        item: { id: "github:acme/web#7", service: "github" },
      });
      // A github.com URL is neither indexed nor fetchable: the PAT is the GHES one.
      expect(await resolve(port, token, DOTCOM_PR)).toEqual({
        found: false,
        reason: "not_indexed",
        service: null,
        fetchable: false,
      });
      // An unindexed PR on the GHES host IS fetchable.
      expect(await resolve(port, token, "https://ghe.example.com/acme/web/pull/99")).toMatchObject({
        found: false,
        fetchable: true,
      });
    } finally {
      stop();
    }
  });

  test("re-auth without --api-base returns to github.com, clears the cursor, and swaps what is fetchable", async () => {
    const vault = createMockVault();
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"], {
      resolveFetchable: async () => {
        const map = await deriveFetchHostMap(vault);
        return (host: string) => serviceForHost(map, host) !== null;
      },
    });
    try {
      const localIndex = new LocalIndex(db);
      await handleConnectorAuth(
        authCtx(vault, localIndex, { apiBaseUrl: "https://ghe.example.com" }),
      );
      setSchedulerCursor(db, "github", "nimbus-ghub1:abc");
      setSchedulerCursor(db, "github_actions", "nimbus-gha1:abc");

      await handleConnectorAuth(authCtx(vault, localIndex, {}));
      expect(await vault.get("github.api_base")).toBeNull();
      const cursors = db
        .query("SELECT service_id, cursor FROM scheduler_state WHERE service_id LIKE 'github%'")
        .all() as Array<{ service_id: string; cursor: string | null }>;
      expect(cursors.every((c) => c.cursor === null)).toBe(true);

      expect(await resolve(port, token, DOTCOM_PR)).toMatchObject({ fetchable: true });
      expect(await resolve(port, token, GHES_PR)).toMatchObject({ fetchable: false });
    } finally {
      stop();
    }
  });
});
