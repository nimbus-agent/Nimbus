/**
 * GitHub Enterprise Server: the gateway's own GitHub fetches follow the stored `github.api_base`,
 * never leave that origin with the PAT, fail closed on an invalid stored base, and only turn rows
 * from the CURRENT instance into requests.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino, { type Logger } from "pino";

import { upsertIndexedItem } from "../index/item-store.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createGithubActionsSyncable } from "./github-actions-sync.ts";
import { createGithubSyncable } from "./github-sync.ts";

const ENSURE_MCP = { ensureGithubMcpRunning: async (): Promise<void> => {} };
const GHES_BASE = "https://ghe.example.com/api/v3";
const GHES_ORIGIN = "https://ghe.example.com";

const realFetch = globalThis.fetch;
let seen: string[] = [];
let handler: (url: string) => Response = () => new Response("{}", { status: 404 });

beforeEach(() => {
  seen = [];
  handler = () => new Response("{}", { status: 404 });
  globalThis.fetch = ((input: unknown) => {
    const url =
      typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    seen.push(url);
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function vaultWith(extra: Record<string, string>): ReturnType<typeof createStubVault> {
  return createStubVault({ "github.pat": "pat-test", ...extra });
}

function ctxFor(db: Database, extra: Record<string, string>, service: "github" | "github_actions") {
  const logLines: string[] = [];
  const logger: Logger = pino({ level: "debug" }, { write: (s: string) => logLines.push(s) });
  const ctx: SyncContext = { ...syncTestContext(db, vaultWith(extra), service), logger };
  return { ctx, logLines };
}

function seedPr(db: Database, externalId: string, url: string | null, title = "PR #1"): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId,
    title,
    bodyPreview: "",
    url,
    canonicalUrl: null,
    modifiedAt: 1000,
    metadata: { repo: externalId.replace(/#.*/, ""), number: 1 },
    syncedAt: 1000,
  });
}

const JSON_OK = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

describe("github sync against a GitHub Enterprise Server base", () => {
  test("requests <base>/user and <base>/users/<login>/events when api_base is stored", async () => {
    const db = createMemoryIndexDb();
    handler = (url) => {
      if (url === `${GHES_BASE}/user`) return JSON_OK({ login: "octo" });
      if (url.startsWith(`${GHES_BASE}/users/octo/events`)) return JSON_OK([]);
      return new Response("{}", { status: 404 });
    };
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github");
    await createGithubSyncable(ENSURE_MCP).sync(ctx, null);
    expect(seen[0]).toBe(`${GHES_BASE}/user`);
    expect(seen[1]).toBe(`${GHES_BASE}/users/octo/events?per_page=100`);
    expect(seen.every((u) => u.startsWith(`${GHES_ORIGIN}/`))).toBe(true);
    db.close();
  });

  test("requests api.github.com when no api_base is stored (regression pin)", async () => {
    const db = createMemoryIndexDb();
    handler = (url) => (url.endsWith("/user") ? JSON_OK({ login: "octo" }) : JSON_OK([]));
    const { ctx } = ctxFor(db, {}, "github");
    await createGithubSyncable(ENSURE_MCP).sync(ctx, null);
    expect(seen[0]).toBe("https://api.github.com/user");
    expect(seen.every((u) => u.startsWith("https://api.github.com/"))).toBe(true);
    db.close();
  });

  test("a stored but INVALID api_base fails closed: no request at all, and the value is not logged", async () => {
    for (const bad of ["http://ghe.example.com", "not a url", "https://u:p@ghe.example.com"]) {
      const db = createMemoryIndexDb();
      const { ctx, logLines } = ctxFor(db, { "github.api_base": bad }, "github");
      const syncable = createGithubSyncable(ENSURE_MCP);
      const res = await syncable.sync(ctx, null);
      expect(res.itemsUpserted).toBe(0);
      expect(seen).toEqual([]);
      const fetched = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/7");
      expect(fetched).toEqual({ status: "not_found", reason: "no_credential" });
      expect(seen).toEqual([]);
      expect(logLines.join("")).not.toContain("ghe.example.com");
      db.close();
    }
  });

  test("a cross-origin 302 from the instance is refused and the PAT never reaches the second host", async () => {
    const db = createMemoryIndexDb();
    handler = () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example.net/x" } });
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github");
    await expect(createGithubSyncable(ENSURE_MCP).sync(ctx, null)).rejects.toThrow(/refused/);
    expect(seen).toEqual([`${GHES_BASE}/user`]);
    db.close();
  });

  test("a 307 to http: is refused", async () => {
    const db = createMemoryIndexDb();
    handler = () =>
      new Response(null, {
        status: 307,
        headers: { location: "http://ghe.example.com/api/v3/user" },
      });
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github");
    await expect(createGithubSyncable(ENSURE_MCP).sync(ctx, null)).rejects.toThrow(/refused/);
    expect(seen).toHaveLength(1);
    db.close();
  });

  test("a same-origin redirect (a renamed repo) is followed", async () => {
    const db = createMemoryIndexDb();
    handler = (url) => {
      if (url === `${GHES_BASE}/user`) {
        return new Response(null, { status: 301, headers: { location: "/api/v3/user2" } });
      }
      if (url === `${GHES_BASE}/user2`) return JSON_OK({ login: "octo" });
      return JSON_OK([]);
    };
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github");
    await createGithubSyncable(ENSURE_MCP).sync(ctx, null);
    expect(seen.slice(0, 2)).toEqual([`${GHES_BASE}/user`, `${GHES_BASE}/user2`]);
    db.close();
  });

  test("a GHES PR upserts url and canonicalUrl from the caller URL on the GHES host", async () => {
    const db = createMemoryIndexDb();
    handler = (url) =>
      url === `${GHES_BASE}/repos/o/r/pulls/7`
        ? JSON_OK({ number: 7, title: "Fix", html_url: "https://ghe.example.com/o/r/pull/7" })
        : new Response("{}", { status: 404 });
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github");
    const callerUrl = "https://ghe.example.com/o/r/pull/7";
    const out = await createGithubSyncable(ENSURE_MCP).fetchOne?.(ctx, callerUrl);
    expect(out?.status).toBe("indexed");
    expect(seen).toEqual([`${GHES_BASE}/repos/o/r/pulls/7`]);
    const row = db
      .query("SELECT url, canonical_url FROM item WHERE external_id = 'o/r#7'")
      .get() as { url: string; canonical_url: string };
    expect(row.url).toBe(callerUrl);
    expect(row.canonical_url).toBe(callerUrl);
    db.close();
  });

  test("fetchOne refuses a github.com URL while GHES is configured (the PAT never goes to the wrong host)", async () => {
    const db = createMemoryIndexDb();
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github");
    const out = await createGithubSyncable(ENSURE_MCP).fetchOne?.(
      ctx,
      "https://github.com/o/r/pull/7",
    );
    expect(out).toEqual({ status: "unsupported_url" });
    expect(seen).toEqual([]);
    db.close();
  });

  test("fetchOne for a GHES URL never sends a request to another host", async () => {
    const db = createMemoryIndexDb();
    handler = () => new Response("{}", { status: 404 });
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github");
    await createGithubSyncable(ENSURE_MCP).fetchOne?.(ctx, "https://ghe.example.com/o/r/pull/7");
    expect(seen.every((u) => u.startsWith(`${GHES_ORIGIN}/`))).toBe(true);
    db.close();
  });
});

describe("every follow-up loop is pinned to the CURRENT instance (switching the base)", () => {
  function eventsAndDetail(): void {
    handler = (url) => {
      if (url.endsWith("/user")) return JSON_OK({ login: "octo" });
      if (url.includes("/events")) return new Response(null, { status: 304 });
      return new Response("{}", { status: 404 });
    };
  }

  test("PR detail enrichment and PR files request only repos indexed from the current instance", async () => {
    const db = createMemoryIndexDb();
    // Rows indexed while github.com was configured, then the base switched to GHES.
    seedPr(db, "old/dotcom-repo#1", "https://github.com/old/dotcom-repo/pull/1");
    seedPr(db, "old/nourl-repo#2", null);
    seedPr(db, "new/ghes-repo#3", "https://ghe.example.com/new/ghes-repo/pull/3");
    eventsAndDetail();
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github");
    await createGithubSyncable(ENSURE_MCP).sync(ctx, null);
    const repoRequests = seen.filter((u) => u.includes("/repos/"));
    expect(repoRequests.length).toBeGreaterThan(0);
    expect(repoRequests.some((u) => u.includes("old/"))).toBe(false);
    expect(repoRequests.every((u) => u.startsWith(`${GHES_BASE}/repos/new/ghes-repo/`))).toBe(true);
    // Both the detail pass (/pulls/3) and the files pass (/pulls/3/files) ran.
    expect(repoRequests.some((u) => u.endsWith("/pulls/3"))).toBe(true);
    expect(repoRequests.some((u) => u.includes("/pulls/3/files"))).toBe(true);
    db.close();
  });

  test("with github.com configured, a GHES-indexed row produces no request", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "new/ghes-repo#3", "https://ghe.example.com/new/ghes-repo/pull/3");
    eventsAndDetail();
    const { ctx } = ctxFor(db, {}, "github");
    await createGithubSyncable(ENSURE_MCP).sync(ctx, null);
    expect(seen.filter((u) => u.includes("/repos/"))).toEqual([]);
    db.close();
  });

  test("github_actions requests runs only for repos from the current instance, at <base>/repos", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "old/dotcom-repo#1", "https://github.com/old/dotcom-repo/pull/1");
    seedPr(db, "new/ghes-repo#3", "https://ghe.example.com/new/ghes-repo/pull/3");
    handler = () => JSON_OK({ workflow_runs: [] });
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github_actions");
    await createGithubActionsSyncable(ENSURE_MCP).sync(ctx, null);
    expect(seen).toEqual([`${GHES_BASE}/repos/new/ghes-repo/actions/runs?per_page=30`]);
    db.close();
  });

  test("github_actions without api_base requests api.github.com and skips GHES-only repos", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "old/dotcom-repo#1", "https://github.com/old/dotcom-repo/pull/1");
    seedPr(db, "new/ghes-repo#3", "https://ghe.example.com/new/ghes-repo/pull/3");
    handler = () => JSON_OK({ workflow_runs: [] });
    const { ctx } = ctxFor(db, {}, "github_actions");
    await createGithubActionsSyncable(ENSURE_MCP).sync(ctx, null);
    expect(seen).toEqual(["https://api.github.com/repos/old/dotcom-repo/actions/runs?per_page=30"]);
    db.close();
  });

  test("github_actions with an INVALID stored base makes no request (never api.github.com)", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "old/dotcom-repo#1", "https://github.com/old/dotcom-repo/pull/1");
    handler = () => JSON_OK({ workflow_runs: [] });
    const { ctx } = ctxFor(db, { "github.api_base": "http://ghe.example.com" }, "github_actions");
    const res = await createGithubActionsSyncable(ENSURE_MCP).sync(ctx, null);
    expect(res.itemsUpserted).toBe(0);
    expect(seen).toEqual([]);
    db.close();
  });

  test("github_actions: a cross-origin 302 is refused and no second request is made", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "new/ghes-repo#3", "https://ghe.example.com/new/ghes-repo/pull/3");
    handler = () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example.net/x" } });
    const { ctx } = ctxFor(db, { "github.api_base": GHES_BASE }, "github_actions");
    await expect(createGithubActionsSyncable(ENSURE_MCP).sync(ctx, null)).rejects.toThrow(
      /refused/,
    );
    expect(seen).toHaveLength(1);
    db.close();
  });
});
