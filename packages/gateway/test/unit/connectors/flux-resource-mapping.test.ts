import { describe, expect, test } from "bun:test";

import { mapFluxResourceToItem } from "../../../src/connectors/flux-resource-mapping.ts";

const NOW = 1_700_009_999_999;

function makeRes(
  over: {
    metadata?: Record<string, unknown>;
    spec?: Record<string, unknown>;
    status?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    metadata: {
      name: "podinfo",
      namespace: "flux-system",
      creationTimestamp: "2021-02-10T20:03:11Z",
      ...over.metadata,
    },
    spec: {
      url: "https://github.com/acme/podinfo",
      path: "./kustomize",
      ...over.spec,
    },
    status: {
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "ReconciliationSucceeded",
          message: "Applied revision: main@sha1:abc",
          lastTransitionTime: "2021-03-01T10:00:00Z",
        },
      ],
      lastAppliedRevision: "main@sha1:abc",
      lastAttemptedRevision: "main@sha1:abc",
      ...over.status,
    },
  };
}

function ctx(over: Partial<Parameters<typeof mapFluxResourceToItem>[1]> = {}) {
  return { kind: "kustomization", syncedAt: NOW, ...over };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapFluxResourceToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapFluxResourceToItem(null, ctx())).toBeNull();
    expect(mapFluxResourceToItem("nope", ctx())).toBeNull();
    expect(mapFluxResourceToItem(42, ctx())).toBeNull();
  });

  test("returns null when metadata.name is missing or empty", () => {
    const noName = makeRes({ metadata: { name: undefined } });
    delete (noName["metadata"] as Record<string, unknown>)["name"];
    expect(mapFluxResourceToItem(noName, ctx())).toBeNull();
    expect(mapFluxResourceToItem(makeRes({ metadata: { name: "" } }), ctx())).toBeNull();
  });

  test("returns null when metadata is entirely missing", () => {
    expect(mapFluxResourceToItem({ spec: {}, status: {} }, ctx())).toBeNull();
  });

  test("service/type fixed; type is a single `resource` with kind in metadata", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("flux");
    expect(row.type).toBe("resource");
    expect(meta(row)["kind"]).toBe("kustomization");
  });

  test("externalId is `<kind>/<namespace>/<name>`", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.externalId).toBe("kustomization/flux-system/podinfo");
  });

  test("externalId uses `_` for a missing namespace (cluster-scoped)", () => {
    const noNs = makeRes();
    delete (noNs["metadata"] as Record<string, unknown>)["namespace"];
    const row = mapFluxResourceToItem(noNs, ctx({ kind: "helm_repository" }));
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.externalId).toBe("helm_repository/_/podinfo");
    expect(meta(row)["namespace"]).toBeNull();
  });

  test("title is the name; bodyPreview summarizes kind/ns/name and Ready", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("podinfo");
    expect(row.bodyPreview).toBe("kustomization flux-system/podinfo — Ready=True");
  });

  test("extracts the Ready condition (status/reason/message) into metadata", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["ready_status"]).toBe("True");
    expect(m["ready_reason"]).toBe("ReconciliationSucceeded");
    expect(m["ready_message"]).toBe("Applied revision: main@sha1:abc");
  });

  test("Ready=False / Unknown pass through verbatim", () => {
    const failing = mapFluxResourceToItem(
      makeRes({
        status: {
          conditions: [
            { type: "Ready", status: "False", reason: "BuildFailed", message: "kustomize error" },
          ],
        },
      }),
      ctx(),
    );
    if (failing === null) throw new Error("expected mapping to succeed");
    expect(meta(failing)["ready_status"]).toBe("False");
    expect(meta(failing)["ready_reason"]).toBe("BuildFailed");
    expect(failing.bodyPreview).toBe("kustomization flux-system/podinfo — Ready=False");

    const unknown = mapFluxResourceToItem(
      makeRes({ status: { conditions: [{ type: "Ready", status: "Unknown" }] } }),
      ctx(),
    );
    if (unknown === null) throw new Error("expected mapping to succeed");
    expect(meta(unknown)["ready_status"]).toBe("Unknown");
  });

  test("picks the Ready condition out of a multi-condition array", () => {
    const row = mapFluxResourceToItem(
      makeRes({
        status: {
          conditions: [
            { type: "Healthy", status: "True", reason: "HealthCheckPassed" },
            { type: "Ready", status: "True", reason: "ReconciliationSucceeded" },
            { type: "Stalled", status: "False" },
          ],
        },
      }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["ready_status"]).toBe("True");
    expect(meta(row)["ready_reason"]).toBe("ReconciliationSucceeded");
  });

  test("missing status.conditions → ready_status null, no throw", () => {
    const bare = makeRes();
    bare["status"] = {};
    const row = mapFluxResourceToItem(bare, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["ready_status"]).toBeNull();
    expect(m["ready_reason"]).toBeNull();
    expect(m["ready_message"]).toBeNull();
    expect(row.bodyPreview).toBe("kustomization flux-system/podinfo — Ready=?");
  });

  test("conditions array with no Ready entry → ready_status null", () => {
    const row = mapFluxResourceToItem(
      makeRes({ status: { conditions: [{ type: "Healthy", status: "True" }] } }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["ready_status"]).toBeNull();
  });

  test("suspend is true only when spec.suspend === true", () => {
    const suspended = mapFluxResourceToItem(makeRes({ spec: { suspend: true } }), ctx());
    if (suspended === null) throw new Error("expected mapping to succeed");
    expect(meta(suspended)["suspend"]).toBe(true);

    const def = mapFluxResourceToItem(makeRes(), ctx());
    if (def === null) throw new Error("expected mapping to succeed");
    expect(meta(def)["suspend"]).toBe(false);

    const weird = mapFluxResourceToItem(makeRes({ spec: { suspend: "yes" } }), ctx());
    if (weird === null) throw new Error("expected mapping to succeed");
    expect(meta(weird)["suspend"]).toBe(false);
  });

  test("source url vs kustomization path both surface (when present)", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["url"]).toBe("https://github.com/acme/podinfo");
    expect(meta(row)["path"]).toBe("./kustomize");
  });

  test("reconciler with no spec.url → url null", () => {
    const reconciler = makeRes();
    reconciler["spec"] = { path: "./apps" };
    const row = mapFluxResourceToItem(reconciler, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["url"]).toBeNull();
    expect(meta(row)["path"]).toBe("./apps");
  });

  test("last_applied / last_attempted revision surface from status", () => {
    const row = mapFluxResourceToItem(
      makeRes({
        status: {
          conditions: [{ type: "Ready", status: "False" }],
          lastAppliedRevision: "main@sha1:old",
          lastAttemptedRevision: "main@sha1:new",
        },
      }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["last_applied_revision"]).toBe("main@sha1:old");
    expect(meta(row)["last_attempted_revision"]).toBe("main@sha1:new");
  });

  test("created_at parses ISO-8601 creationTimestamp", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(Date.parse("2021-02-10T20:03:11Z"));
  });

  test("modifiedAt prefers Ready lastTransitionTime", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(Date.parse("2021-03-01T10:00:00Z"));
  });

  test("modifiedAt falls back to creationTimestamp when no Ready lastTransitionTime", () => {
    const row = mapFluxResourceToItem(
      makeRes({ status: { conditions: [{ type: "Ready", status: "True" }] } }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(Date.parse("2021-02-10T20:03:11Z"));
  });

  test("modifiedAt falls back to syncedAt when neither timestamp is present", () => {
    const noTs = makeRes();
    noTs["status"] = {};
    delete (noTs["metadata"] as Record<string, unknown>)["creationTimestamp"];
    const row = mapFluxResourceToItem(noTs, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBeNull();
    expect(row.modifiedAt).toBe(NOW);
  });

  test("canonicalUrl is the resource locator; url field is null", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("kustomization/flux-system/podinfo");
    expect(meta(row)["canonical_url"]).toBe("kustomization/flux-system/podinfo");
    expect(row.url).toBeNull();
  });

  test("missing spec/status sub-objects still map (nulls, no throw)", () => {
    const row = mapFluxResourceToItem({ metadata: { name: "lonely-ks" } }, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["namespace"]).toBeNull();
    expect(m["ready_status"]).toBeNull();
    expect(m["suspend"]).toBe(false);
    expect(m["url"]).toBeNull();
    expect(m["path"]).toBeNull();
    expect(m["last_applied_revision"]).toBeNull();
    expect(m["last_attempted_revision"]).toBeNull();
    expect(m["created_at"]).toBeNull();
    expect(row.externalId).toBe("kustomization/_/lonely-ks");
  });

  test("syncedAt propagates", () => {
    const row = mapFluxResourceToItem(makeRes(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});
