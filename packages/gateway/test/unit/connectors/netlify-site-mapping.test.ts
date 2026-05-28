import { describe, expect, test } from "bun:test";

import { mapNetlifySiteToItem, siteUrl } from "../../../src/connectors/netlify-site-mapping.ts";

function makeSite(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "site_abc123",
    name: "my-app",
    url: "http://my-app.netlify.app",
    admin_url: "https://app.netlify.com/sites/my-app",
    ssl_url: "https://my-app.netlify.app",
    account_name: "Acme Inc",
    created_at: "2024-01-15T08:30:00.000Z",
    updated_at: "2024-03-01T12:00:00.000Z",
    build_settings: {
      repo_url: "https://github.com/acme/my-app",
      repo_branch: "main",
      cmd: "npm run build",
    },
    published_deploy: {
      id: "deploy_xyz789",
      state: "ready",
      branch: "main",
      commit_ref: "abcdef1234567890",
      commit_url: "https://github.com/acme/my-app/commit/abcdef1",
      title: "Ship the redesigned checkout flow",
      deploy_ssl_url: "https://deploy-preview-42--my-app.netlify.app",
      review_url: "https://github.com/acme/my-app/pull/42",
      created_at: "2024-03-01T11:59:00.000Z",
    },
    ...over,
  };
}

const NOW = 1_700_009_999_999;

const CREATED_MS = Date.parse("2024-01-15T08:30:00.000Z");
const UPDATED_MS = Date.parse("2024-03-01T12:00:00.000Z");

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapNetlifySiteToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapNetlifySiteToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapNetlifySiteToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapNetlifySiteToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    const noId = makeSite();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapNetlifySiteToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapNetlifySiteToItem(makeSite({ id: "" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the verbatim site id", () => {
    const row = mapNetlifySiteToItem(makeSite(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("netlify");
    expect(row.type).toBe("site");
    expect(row.externalId).toBe("site_abc123");
  });

  test("title is the site name; falls back to `Site <id>` when name missing", () => {
    const withName = mapNetlifySiteToItem(makeSite(), { syncedAt: NOW });
    if (withName === null) throw new Error("expected mapping to succeed");
    expect(withName.title).toBe("my-app");

    const noName = makeSite();
    delete (noName as Record<string, unknown>)["name"];
    const row = mapNetlifySiteToItem(noName, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Site site_abc123");

    const emptyName = mapNetlifySiteToItem(makeSite({ name: "" }), { syncedAt: NOW });
    if (emptyName === null) throw new Error("expected mapping to succeed");
    expect(emptyName.title).toBe("Site site_abc123");
  });

  test("bodyPreview is the published_deploy title; empty string when deploy/title missing", () => {
    const row = mapNetlifySiteToItem(makeSite(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Ship the redesigned checkout flow");

    const noDeploy = makeSite();
    delete (noDeploy as Record<string, unknown>)["published_deploy"];
    const bare = mapNetlifySiteToItem(noDeploy, { syncedAt: NOW });
    if (bare === null) throw new Error("expected mapping to succeed");
    expect(bare.bodyPreview).toBe("");
  });

  test("build_settings + published_deploy metadata flows through", () => {
    const row = mapNetlifySiteToItem(makeSite(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["site_id"]).toBe("site_abc123");
    expect(m["name"]).toBe("my-app");
    expect(m["url"]).toBe("http://my-app.netlify.app");
    expect(m["admin_url"]).toBe("https://app.netlify.com/sites/my-app");
    expect(m["ssl_url"]).toBe("https://my-app.netlify.app");
    expect(m["repo_url"]).toBe("https://github.com/acme/my-app");
    expect(m["repo_branch"]).toBe("main");
    expect(m["deploy_state"]).toBe("ready");
    expect(m["deploy_id"]).toBe("deploy_xyz789");
    expect(m["deploy_branch"]).toBe("main");
    expect(m["commit_ref"]).toBe("abcdef1234567890");
    expect(m["commit_url"]).toBe("https://github.com/acme/my-app/commit/abcdef1");
    expect(m["deploy_url"]).toBe("https://deploy-preview-42--my-app.netlify.app");
    expect(m["account_name"]).toBe("Acme Inc");
  });

  test("missing build_settings → repo fields null", () => {
    const noBuild = makeSite();
    delete (noBuild as Record<string, unknown>)["build_settings"];
    const row = mapNetlifySiteToItem(noBuild, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["repo_url"]).toBeNull();
    expect(meta(row)["repo_branch"]).toBeNull();
  });

  test("missing published_deploy → deploy fields null", () => {
    const noDeploy = makeSite();
    delete (noDeploy as Record<string, unknown>)["published_deploy"];
    const row = mapNetlifySiteToItem(noDeploy, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["deploy_state"]).toBeNull();
    expect(meta(row)["deploy_id"]).toBeNull();
    expect(meta(row)["deploy_branch"]).toBeNull();
    expect(meta(row)["commit_ref"]).toBeNull();
    expect(meta(row)["commit_url"]).toBeNull();
    expect(meta(row)["deploy_url"]).toBeNull();
  });

  test("canonicalUrl prefers admin_url over ssl_url over url", () => {
    const row = mapNetlifySiteToItem(makeSite(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://app.netlify.com/sites/my-app");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("canonicalUrl falls back to ssl_url when admin_url missing", () => {
    const noAdmin = makeSite();
    delete (noAdmin as Record<string, unknown>)["admin_url"];
    const row = mapNetlifySiteToItem(noAdmin, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://my-app.netlify.app");
  });

  test("canonicalUrl falls back to url when admin_url + ssl_url missing", () => {
    const bare = makeSite();
    delete (bare as Record<string, unknown>)["admin_url"];
    delete (bare as Record<string, unknown>)["ssl_url"];
    const row = mapNetlifySiteToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("http://my-app.netlify.app");
  });

  test("canonicalUrl is null when admin_url, ssl_url, and url are all missing", () => {
    const bare = makeSite();
    delete (bare as Record<string, unknown>)["admin_url"];
    delete (bare as Record<string, unknown>)["ssl_url"];
    delete (bare as Record<string, unknown>)["url"];
    const row = mapNetlifySiteToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
    expect(row.url).toBeNull();
  });

  test("ISO-8601 timestamps parse to epoch ms in metadata", () => {
    const row = mapNetlifySiteToItem(makeSite(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
    // The values must be numbers, not the raw ISO strings.
    expect(typeof meta(row)["created_at"]).toBe("number");
    expect(typeof meta(row)["updated_at"]).toBe("number");
  });

  test("modifiedAt = updated_at; falls back to created_at then syncedAt", () => {
    const row = mapNetlifySiteToItem(makeSite(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdated = makeSite();
    delete (noUpdated as Record<string, unknown>)["updated_at"];
    const onlyCreated = mapNetlifySiteToItem(noUpdated, { syncedAt: NOW });
    if (onlyCreated === null) throw new Error("expected mapping to succeed");
    expect(onlyCreated.modifiedAt).toBe(CREATED_MS);

    const noTimestamps = makeSite();
    delete (noTimestamps as Record<string, unknown>)["updated_at"];
    delete (noTimestamps as Record<string, unknown>)["created_at"];
    const fallback = mapNetlifySiteToItem(noTimestamps, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
    expect(meta(fallback)["updated_at"]).toBeNull();
  });

  test("non-string / unparseable timestamps become null", () => {
    const bad = makeSite({ created_at: 1_700_000_000_000, updated_at: "not-a-date" });
    const row = mapNetlifySiteToItem(bad, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBeNull();
    expect(meta(row)["updated_at"]).toBeNull();
    expect(row.modifiedAt).toBe(NOW);
  });

  test("syncedAt propagates", () => {
    const row = mapNetlifySiteToItem(makeSite(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("siteUrl", () => {
  test("prefers admin_url", () => {
    expect(siteUrl("https://app.netlify.com/sites/x", "https://x.netlify.app", "http://x")).toBe(
      "https://app.netlify.com/sites/x",
    );
  });

  test("falls back to ssl_url then url", () => {
    expect(siteUrl(null, "https://x.netlify.app", "http://x")).toBe("https://x.netlify.app");
    expect(siteUrl("", "", "http://x")).toBe("http://x");
  });

  test("returns null when all inputs are empty", () => {
    expect(siteUrl(null, null, null)).toBeNull();
    expect(siteUrl("", "", "")).toBeNull();
  });
});
