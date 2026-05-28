import { describe, expect, test } from "bun:test";

import {
  applicationUrl,
  mapArgocdApplicationToItem,
} from "../../../src/connectors/argocd-application-mapping.ts";

const NOW = 1_700_009_999_999;
const BASE_URL = "https://argocd.example.com";

function makeApp(
  over: {
    metadata?: Record<string, unknown>;
    spec?: Record<string, unknown>;
    status?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    metadata: {
      name: "payments-api",
      namespace: "argocd",
      creationTimestamp: "2021-02-10T20:03:11Z",
      ...over.metadata,
    },
    spec: {
      project: "team-payments",
      source: {
        repoURL: "https://github.com/acme/payments",
        path: "manifests/prod",
        targetRevision: "main",
      },
      destination: {
        server: "https://kubernetes.default.svc",
        namespace: "payments-prod",
      },
      ...over.spec,
    },
    status: {
      sync: { status: "Synced", revision: "abc123" },
      health: { status: "Healthy" },
      ...over.status,
    },
  };
}

function ctx(over: Partial<Parameters<typeof mapArgocdApplicationToItem>[1]> = {}) {
  return { baseUrl: BASE_URL, syncedAt: NOW, ...over };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapArgocdApplicationToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapArgocdApplicationToItem(null, ctx())).toBeNull();
    expect(mapArgocdApplicationToItem("nope", ctx())).toBeNull();
    expect(mapArgocdApplicationToItem(42, ctx())).toBeNull();
  });

  test("returns null when metadata.name is missing or empty", () => {
    const noName = makeApp({ metadata: { name: undefined } });
    delete (noName["metadata"] as Record<string, unknown>)["name"];
    expect(mapArgocdApplicationToItem(noName, ctx())).toBeNull();
    expect(mapArgocdApplicationToItem(makeApp({ metadata: { name: "" } }), ctx())).toBeNull();
  });

  test("returns null when metadata is entirely missing", () => {
    expect(mapArgocdApplicationToItem({ spec: {}, status: {} }, ctx())).toBeNull();
  });

  test("service/type fixed; externalId is the application name", () => {
    const row = mapArgocdApplicationToItem(makeApp(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("argocd");
    expect(row.type).toBe("application");
    expect(row.externalId).toBe("payments-api");
  });

  test("title is the name; bodyPreview summarizes sync/health", () => {
    const row = mapArgocdApplicationToItem(makeApp(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("payments-api");
    expect(row.bodyPreview).toBe("payments-api — Synced/Healthy");
  });

  test("bodyPreview falls back to ? when sync/health absent", () => {
    const app = makeApp();
    app["status"] = {};
    const row = mapArgocdApplicationToItem(app, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("payments-api — ?/?");
    const m = (row as { metadata: Record<string, unknown> }).metadata;
    expect(m["sync_status"]).toBeNull();
    expect(m["health_status"]).toBeNull();
  });

  test("extracts nested spec / status fields into metadata", () => {
    const row = mapArgocdApplicationToItem(makeApp(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["name"]).toBe("payments-api");
    expect(m["namespace"]).toBe("argocd");
    expect(m["project"]).toBe("team-payments");
    expect(m["repo_url"]).toBe("https://github.com/acme/payments");
    expect(m["path"]).toBe("manifests/prod");
    expect(m["target_revision"]).toBe("main");
    expect(m["dest_server"]).toBe("https://kubernetes.default.svc");
    expect(m["dest_namespace"]).toBe("payments-prod");
    expect(m["sync_status"]).toBe("Synced");
    expect(m["health_status"]).toBe("Healthy");
    expect(m["revision"]).toBe("abc123");
  });

  test("sync_status / health_status pass through arbitrary strings (not enum-restricted)", () => {
    const row = mapArgocdApplicationToItem(
      makeApp({
        status: {
          sync: { status: "OutOfSync" },
          health: { status: "Degraded" },
        },
      }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["sync_status"]).toBe("OutOfSync");
    expect(meta(row)["health_status"]).toBe("Degraded");

    const weird = mapArgocdApplicationToItem(
      makeApp({ status: { health: { status: "SOME_FUTURE_STATE" } } }),
      ctx(),
    );
    if (weird === null) throw new Error("expected mapping to succeed");
    expect(meta(weird)["health_status"]).toBe("SOME_FUTURE_STATE");
  });

  test("missing spec/status sub-objects still map (nulls, no throw)", () => {
    const row = mapArgocdApplicationToItem({ metadata: { name: "lonely-app" } }, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["namespace"]).toBeNull();
    expect(m["project"]).toBeNull();
    expect(m["repo_url"]).toBeNull();
    expect(m["path"]).toBeNull();
    expect(m["target_revision"]).toBeNull();
    expect(m["dest_server"]).toBeNull();
    expect(m["dest_namespace"]).toBeNull();
    expect(m["sync_status"]).toBeNull();
    expect(m["health_status"]).toBeNull();
    expect(m["revision"]).toBeNull();
    expect(m["created_at"]).toBeNull();
  });

  test("created_at parses ISO-8601; modifiedAt uses it", () => {
    const row = mapArgocdApplicationToItem(makeApp(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const expectedMs = Date.parse("2021-02-10T20:03:11Z");
    expect(meta(row)["created_at"]).toBe(expectedMs);
    expect(row.modifiedAt).toBe(expectedMs);
  });

  test("unparseable / missing creationTimestamp → created_at null; modifiedAt falls back to syncedAt", () => {
    const bad = mapArgocdApplicationToItem(
      makeApp({ metadata: { creationTimestamp: "not-a-date" } }),
      ctx(),
    );
    if (bad === null) throw new Error("expected mapping to succeed");
    expect(meta(bad)["created_at"]).toBeNull();
    expect(bad.modifiedAt).toBe(NOW);

    const noTs = makeApp();
    delete (noTs["metadata"] as Record<string, unknown>)["creationTimestamp"];
    const row2 = mapArgocdApplicationToItem(noTs, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["created_at"]).toBeNull();
    expect(row2.modifiedAt).toBe(NOW);
  });

  test("canonical url points at the application page; url === canonicalUrl", () => {
    const row = mapArgocdApplicationToItem(makeApp(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://argocd.example.com/applications/payments-api");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("syncedAt propagates", () => {
    const row = mapArgocdApplicationToItem(makeApp(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("applicationUrl", () => {
  test("builds the application page URL from the base", () => {
    expect(applicationUrl("https://argocd.example.com", "my-app")).toBe(
      "https://argocd.example.com/applications/my-app",
    );
  });

  test("trims a trailing slash off the base", () => {
    expect(applicationUrl("https://argocd.example.com/", "my-app")).toBe(
      "https://argocd.example.com/applications/my-app",
    );
  });

  test("encodes the application name", () => {
    expect(applicationUrl("https://argocd.example.com", "team/app name")).toBe(
      "https://argocd.example.com/applications/team%2Fapp%20name",
    );
  });
});
