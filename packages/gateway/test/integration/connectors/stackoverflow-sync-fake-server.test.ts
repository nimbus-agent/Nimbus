import { afterEach, describe, expect, test } from "bun:test";
import { createStackOverflowSyncable } from "../../../src/connectors/stackoverflow-sync.ts";
import {
  fullPage,
  type Harness,
  question,
  startHarness,
  TEAM,
  withRewrittenFetch,
} from "../../helpers/stackoverflow-fake-server.ts";

describe("stackoverflow-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with stackoverflow:<id> ids + Bearer auth + team-slug-in-path", async () => {
    h = startHarness({ pages: [[question(1), question(2)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "so_test_token");
    await h.vault.set("stackoverflow.team", TEAM);

    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);

    const expectedPath = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;
    const reqs = h.fake.requests.filter((r) => r.path === expectedPath);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("pagesize=100");
    expect(reqs[0]?.query).toContain("page=1");
    expect(reqs[0]?.query).toContain("sort=creation");
    expect(expectedPath).toContain("%20");
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer so_test_token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'stackoverflow' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2"]);
    expect(rows.map((r) => r.id)).toEqual(["stackoverflow:1", "stackoverflow:2"]);
  });

  test("page-number walk: continues while page < totalPages, stops at the last page", async () => {
    h = startHarness({ pages: [fullPage(1), [question(1000)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);

    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(101);
    const expectedPath = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;
    const reqs = h.fake.requests.filter((r) => r.path === expectedPath);
    expect(reqs.map((r) => new URL(`https://x${r.query}`).searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
  });

  test("MAX_PAGES cap halts the walk", async () => {
    const pages = Array.from({ length: 25 }, (_, i) => fullPage(i * 100 + 1));
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);

    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const expectedPath = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;
    const reqs = h.fake.requests.filter((r) => r.path === expectedPath);
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20 * 100);
  });

  test("the webUrl is the canonical url; missing-webUrl questions → null", async () => {
    h = startHarness({ pages: [[question(1), question(2, { webUrl: null })]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);

    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const web = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'stackoverflow' AND external_id = '1'",
      )
      .get();
    expect(web?.canonical_url).toBe("https://stackoverflowteams.com/c/acme/questions/1");
    const noUrl = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'stackoverflow' AND external_id = '2'",
      )
      .get();
    expect(noUrl?.canonical_url).toBeNull();
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ pages: [[question(1)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.team", TEAM);
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("noop when team unset — no requests (both keys required)", async () => {
    h = startHarness({ pages: [[question(1)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty question list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);
  });
});
