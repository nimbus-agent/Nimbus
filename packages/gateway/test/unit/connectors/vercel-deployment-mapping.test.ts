import { describe, expect, test } from "bun:test";

import {
  deploymentUrl,
  mapVercelDeploymentToItem,
} from "../../../src/connectors/vercel-deployment-mapping.ts";

function makeDeployment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "dpl_abc123",
    name: "my-app",
    url: "my-app-abc123.vercel.app",
    created: 1_700_000_000_000,
    state: "READY",
    readyState: "READY",
    target: "production",
    inspectorUrl: "https://vercel.com/acme/my-app/abc123",
    creator: { uid: "u1", username: "alice", email: "alice@acme.com" },
    meta: {
      githubCommitSha: "abcdef1234567890",
      githubCommitMessage: "Ship the redesigned checkout flow",
      githubCommitRef: "main",
      githubPrId: "42",
      githubCommitAuthorName: "Alice",
    },
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapVercelDeploymentToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapVercelDeploymentToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapVercelDeploymentToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapVercelDeploymentToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when uid is missing or empty", () => {
    const noUid = makeDeployment();
    delete (noUid as Record<string, unknown>)["uid"];
    expect(mapVercelDeploymentToItem(noUid, { syncedAt: NOW })).toBeNull();
    expect(mapVercelDeploymentToItem(makeDeployment({ uid: "" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the verbatim uid", () => {
    const row = mapVercelDeploymentToItem(makeDeployment(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("vercel");
    expect(row.type).toBe("deployment");
    expect(row.externalId).toBe("dpl_abc123");
  });

  test("title is `<name> — <state>`; falls back to `Deployment <uid>` when name missing", () => {
    const withName = mapVercelDeploymentToItem(makeDeployment(), { syncedAt: NOW });
    if (withName === null) throw new Error("expected mapping to succeed");
    expect(withName.title).toBe("my-app — READY");

    const noName = makeDeployment();
    delete (noName as Record<string, unknown>)["name"];
    const row = mapVercelDeploymentToItem(noName, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Deployment dpl_abc123");
  });

  test("state prefers readyState over state", () => {
    const row = mapVercelDeploymentToItem(
      makeDeployment({ state: "BUILDING", readyState: "READY" }),
      { syncedAt: NOW },
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["state"]).toBe("READY");

    const noReady = makeDeployment({ state: "ERROR" });
    delete (noReady as Record<string, unknown>)["readyState"];
    const fallback = mapVercelDeploymentToItem(noReady, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(meta(fallback)["state"]).toBe("ERROR");
  });

  test("bodyPreview is the commit message; empty string when meta/message missing", () => {
    const row = mapVercelDeploymentToItem(makeDeployment(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Ship the redesigned checkout flow");

    const noMeta = makeDeployment();
    delete (noMeta as Record<string, unknown>)["meta"];
    const bare = mapVercelDeploymentToItem(noMeta, { syncedAt: NOW });
    if (bare === null) throw new Error("expected mapping to succeed");
    expect(bare.bodyPreview).toBe("");
  });

  test("commit + creator metadata flows through; nested-object misses → null", () => {
    const row = mapVercelDeploymentToItem(makeDeployment(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["uid"]).toBe("dpl_abc123");
    expect(m["name"]).toBe("my-app");
    expect(m["target"]).toBe("production");
    expect(m["url"]).toBe("my-app-abc123.vercel.app");
    expect(m["commit_sha"]).toBe("abcdef1234567890");
    expect(m["commit_message"]).toBe("Ship the redesigned checkout flow");
    expect(m["commit_ref"]).toBe("main");
    expect(m["pr_id"]).toBe("42");
    expect(m["creator"]).toBe("alice");
    expect(m["created_at"]).toBe(1_700_000_000_000);

    const noMetaNoCreator = makeDeployment();
    delete (noMetaNoCreator as Record<string, unknown>)["meta"];
    delete (noMetaNoCreator as Record<string, unknown>)["creator"];
    const sparse = mapVercelDeploymentToItem(noMetaNoCreator, { syncedAt: NOW });
    if (sparse === null) throw new Error("expected mapping to succeed");
    expect(meta(sparse)["commit_sha"]).toBeNull();
    expect(meta(sparse)["commit_message"]).toBeNull();
    expect(meta(sparse)["commit_ref"]).toBeNull();
    expect(meta(sparse)["pr_id"]).toBeNull();
    expect(meta(sparse)["creator"]).toBeNull();
  });

  test("creator falls back to email when username absent", () => {
    const row = mapVercelDeploymentToItem(
      makeDeployment({ creator: { uid: "u1", email: "bob@acme.com" } }),
      { syncedAt: NOW },
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["creator"]).toBe("bob@acme.com");
  });

  test("target is null-passthrough when absent", () => {
    const noTarget = makeDeployment();
    delete (noTarget as Record<string, unknown>)["target"];
    const row = mapVercelDeploymentToItem(noTarget, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["target"]).toBeNull();
  });

  test("canonicalUrl prefers inspectorUrl over the deploy host", () => {
    const row = mapVercelDeploymentToItem(makeDeployment(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://vercel.com/acme/my-app/abc123");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("canonicalUrl falls back to https://<host> when inspectorUrl missing", () => {
    const noInspector = makeDeployment();
    delete (noInspector as Record<string, unknown>)["inspectorUrl"];
    const row = mapVercelDeploymentToItem(noInspector, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://my-app-abc123.vercel.app");
  });

  test("canonicalUrl is null when both inspectorUrl and host are missing", () => {
    const bare = makeDeployment();
    delete (bare as Record<string, unknown>)["inspectorUrl"];
    delete (bare as Record<string, unknown>)["url"];
    const row = mapVercelDeploymentToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
    expect(row.url).toBeNull();
  });

  test("modifiedAt = created (epoch ms); falls back to syncedAt when created missing", () => {
    const row = mapVercelDeploymentToItem(makeDeployment(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(1_700_000_000_000);

    const noCreated = makeDeployment();
    delete (noCreated as Record<string, unknown>)["created"];
    const fallback = mapVercelDeploymentToItem(noCreated, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
  });

  test("syncedAt propagates", () => {
    const row = mapVercelDeploymentToItem(makeDeployment(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("deploymentUrl", () => {
  test("prefers the inspector URL", () => {
    expect(deploymentUrl("https://vercel.com/x/y", "host.vercel.app")).toBe(
      "https://vercel.com/x/y",
    );
  });

  test("prepends https:// to the bare deploy host when inspector absent", () => {
    expect(deploymentUrl(null, "host.vercel.app")).toBe("https://host.vercel.app");
    expect(deploymentUrl("", "host.vercel.app")).toBe("https://host.vercel.app");
  });

  test("returns null when both inputs are empty", () => {
    expect(deploymentUrl(null, null)).toBeNull();
    expect(deploymentUrl("", "")).toBeNull();
  });
});
