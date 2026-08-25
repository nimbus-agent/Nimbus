import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { type ApiEndpointWrite, writeApiEndpointsForSpec } from "./api-endpoint-store.ts";
import { LocalIndex } from "./local-index.ts";

function db(): Database {
  const d = new Database(":memory:");
  LocalIndex.ensureSchema(d);
  return d;
}

function endpoint(path: string, spec = "openapi.yaml"): ApiEndpointWrite {
  const externalId = `${spec}#GET ${path}`;
  return {
    item: {
      service: "openapi",
      type: "api_endpoint",
      externalId,
      title: `GET ${path}`,
      bodyPreview: "",
      modifiedAt: 1,
      metadata: {},
      syncedAt: 1,
    },
    endpoint: {
      id: `openapi:${externalId}`,
      serviceName: "svc",
      path,
      method: "GET",
      operationId: null,
      tags: [],
      deprecated: false,
      specPath: spec,
      specVersion: "1.0.0",
      mtimeMs: 1,
    },
  };
}

const ids = (w: readonly ApiEndpointWrite[]) => new Set(w.map((x) => x.endpoint.id));

describe("writeApiEndpointsForSpec", () => {
  test("writes the item and its api_endpoint row together", () => {
    const d = db();
    const writes = [endpoint("/a")];
    const r = writeApiEndpointsForSpec(
      { db: d, depth: "full" },
      { specPath: "openapi.yaml", endpoints: writes, keepIds: ids(writes), syncedAt: 1 },
    );
    expect(r.upserted).toBe(1);
    expect(d.query("SELECT COUNT(*) AS n FROM api_endpoint").get()).toEqual({ n: 1 });
    expect(d.query("SELECT COUNT(*) AS n FROM item WHERE service = 'openapi'").get()).toEqual({
      n: 1,
    });
  });

  test("is idempotent for the same endpoint", () => {
    const d = db();
    const writes = [endpoint("/a")];
    const input = {
      specPath: "openapi.yaml",
      endpoints: writes,
      keepIds: ids(writes),
      syncedAt: 1,
    };
    writeApiEndpointsForSpec({ db: d, depth: "full" }, input);
    writeApiEndpointsForSpec({ db: d, depth: "full" }, input);
    expect(d.query("SELECT COUNT(*) AS n FROM api_endpoint").get()).toEqual({ n: 1 });
  });

  test("prunes an endpoint dropped from the spec, and its item with it", () => {
    const d = db();
    const first = [endpoint("/a"), endpoint("/b")];
    writeApiEndpointsForSpec(
      { db: d, depth: "full" },
      { specPath: "openapi.yaml", endpoints: first, keepIds: ids(first), syncedAt: 1 },
    );

    const second = [endpoint("/a")];
    const r = writeApiEndpointsForSpec(
      { db: d, depth: "full" },
      { specPath: "openapi.yaml", endpoints: second, keepIds: ids(second), syncedAt: 2 },
    );
    expect(r.deleted).toBe(1);
    expect(d.query("SELECT COUNT(*) AS n FROM api_endpoint").get()).toEqual({ n: 1 });
    expect(d.query("SELECT COUNT(*) AS n FROM item WHERE service = 'openapi'").get()).toEqual({
      n: 1,
    });
  });

  test("the prune is scoped to ONE spec file", () => {
    // Two specs share the table. A prune driven by spec A must not touch spec B's endpoints.
    const d = db();
    const a = [endpoint("/a", "a.yaml")];
    const b = [endpoint("/b", "b.yaml")];
    writeApiEndpointsForSpec(
      { db: d, depth: "full" },
      { specPath: "a.yaml", endpoints: a, keepIds: ids(a), syncedAt: 1 },
    );
    writeApiEndpointsForSpec(
      { db: d, depth: "full" },
      { specPath: "b.yaml", endpoints: b, keepIds: ids(b), syncedAt: 1 },
    );

    const r = writeApiEndpointsForSpec(
      { db: d, depth: "full" },
      { specPath: "a.yaml", endpoints: [], keepIds: new Set<string>(), syncedAt: 2 },
    );
    expect(r.deleted).toBe(1);
    expect(d.query("SELECT COUNT(*) AS n FROM api_endpoint").get()).toEqual({ n: 1 });
  });
});
