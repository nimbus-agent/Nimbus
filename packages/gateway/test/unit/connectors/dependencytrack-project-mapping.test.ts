import { describe, expect, test } from "bun:test";

import {
  mapDependencyTrackProjectToItem,
  projectUrl,
} from "../../../src/connectors/dependencytrack-project-mapping.ts";

const NOW = 1_700_009_999_999;
const BASE_URL = "https://dtrack.example.com";

function makeProject(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "b1c2d3e4-0000-4000-8000-000000000001",
    name: "payment-service",
    version: "2.3.1",
    classifier: "APPLICATION",
    active: true,
    lastBomImport: 1_700_000_000_000,
    tags: [{ name: "tier-1" }, { name: "pci" }],
    metrics: { critical: 2, high: 5, medium: 9, low: 3, vulnerabilities: 19, components: 142 },
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof mapDependencyTrackProjectToItem>[1]> = {}) {
  return { baseUrl: BASE_URL, syncedAt: NOW, ...over };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapDependencyTrackProjectToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapDependencyTrackProjectToItem(null, ctx())).toBeNull();
    expect(mapDependencyTrackProjectToItem("nope", ctx())).toBeNull();
    expect(mapDependencyTrackProjectToItem(42, ctx())).toBeNull();
  });

  test("returns null when uuid is missing or empty", () => {
    const noId = makeProject();
    delete noId["uuid"];
    expect(mapDependencyTrackProjectToItem(noId, ctx())).toBeNull();
    expect(mapDependencyTrackProjectToItem(makeProject({ uuid: "" }), ctx())).toBeNull();
    expect(mapDependencyTrackProjectToItem(makeProject({ uuid: 123 }), ctx())).toBeNull();
  });

  test("returns null when name is missing or empty", () => {
    const noName = makeProject();
    delete noName["name"];
    expect(mapDependencyTrackProjectToItem(noName, ctx())).toBeNull();
    expect(mapDependencyTrackProjectToItem(makeProject({ name: "" }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is the uuid", () => {
    const row = mapDependencyTrackProjectToItem(makeProject(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("dependencytrack");
    expect(row.type).toBe("project");
    expect(row.externalId).toBe("b1c2d3e4-0000-4000-8000-000000000001");
  });

  test("title includes name + version; url === canonicalUrl", () => {
    const row = mapDependencyTrackProjectToItem(makeProject(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("payment-service 2.3.1");
    expect(row.url).toBe(row.canonicalUrl);
    expect(row.canonicalUrl).toBe(
      "https://dtrack.example.com/projects/b1c2d3e4-0000-4000-8000-000000000001",
    );
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("title is just the name when version absent", () => {
    const row = mapDependencyTrackProjectToItem(makeProject({ version: undefined }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("payment-service");
    expect(meta(row)["version"]).toBeNull();
  });

  test("extracts flat fields into metadata", () => {
    const row = mapDependencyTrackProjectToItem(makeProject(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["uuid"]).toBe("b1c2d3e4-0000-4000-8000-000000000001");
    expect(m["name"]).toBe("payment-service");
    expect(m["version"]).toBe("2.3.1");
    expect(m["classifier"]).toBe("APPLICATION");
    expect(m["active"]).toBe(true);
    expect(m["last_bom_import"]).toBe(1_700_000_000_000);
    expect(m["tags"]).toEqual(["tier-1", "pci"]);
  });

  test("surfaces the embedded vulnerability metrics", () => {
    const row = mapDependencyTrackProjectToItem(makeProject(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["critical"]).toBe(2);
    expect(m["high"]).toBe(5);
    expect(m["medium"]).toBe(9);
    expect(m["low"]).toBe(3);
    expect(m["vulnerabilities"]).toBe(19);
    expect(m["components"]).toBe(142);
  });

  test("missing metrics object → all metric fields null", () => {
    const row = mapDependencyTrackProjectToItem(makeProject({ metrics: undefined }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["critical"]).toBeNull();
    expect(m["high"]).toBeNull();
    expect(m["vulnerabilities"]).toBeNull();
    expect(m["components"]).toBeNull();
  });

  test("partial metrics object → present fields kept, absent fields null", () => {
    const row = mapDependencyTrackProjectToItem(makeProject({ metrics: { critical: 1 } }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["critical"]).toBe(1);
    expect(m["high"]).toBeNull();
  });

  test("active is true only when literally true", () => {
    const truthy = mapDependencyTrackProjectToItem(makeProject({ active: "yes" }), ctx());
    if (truthy === null) throw new Error("expected mapping to succeed");
    expect(meta(truthy)["active"]).toBe(false);
  });

  test("tolerates non-array / non-object tags", () => {
    const a = mapDependencyTrackProjectToItem(makeProject({ tags: "nope" }), ctx());
    if (a === null) throw new Error("expected mapping to succeed");
    expect(meta(a)["tags"]).toEqual([]);

    const b = mapDependencyTrackProjectToItem(
      makeProject({ tags: [null, 7, { foo: "bar" }, { name: "ok" }] }),
      ctx(),
    );
    if (b === null) throw new Error("expected mapping to succeed");
    expect(meta(b)["tags"]).toEqual(["ok"]);
  });

  test("modifiedAt prefers lastBomImport, falls back to syncedAt", () => {
    const row = mapDependencyTrackProjectToItem(makeProject(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(1_700_000_000_000);

    const noBom = mapDependencyTrackProjectToItem(makeProject({ lastBomImport: undefined }), ctx());
    if (noBom === null) throw new Error("expected mapping to succeed");
    expect(meta(noBom)["last_bom_import"]).toBeNull();
    expect(noBom.modifiedAt).toBe(NOW);
  });

  test("syncedAt propagates", () => {
    const row = mapDependencyTrackProjectToItem(makeProject(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });

  test("long name+version title is truncated with an ellipsis", () => {
    const longName = "x".repeat(300);
    const row = mapDependencyTrackProjectToItem(
      makeProject({ name: longName, version: undefined }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.title.length).toBe(201);
  });
});

describe("projectUrl", () => {
  test("builds the project page URL from the base", () => {
    expect(projectUrl("https://dtrack.example.com", "abc")).toBe(
      "https://dtrack.example.com/projects/abc",
    );
  });

  test("trims a trailing slash off the base", () => {
    expect(projectUrl("https://dtrack.example.com/", "abc")).toBe(
      "https://dtrack.example.com/projects/abc",
    );
  });
});
