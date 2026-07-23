import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { syncGraphFromIndexedItem } from "./graph-populator.ts";
import { isItemLinkedGraphType } from "./relationship-graph.ts";

test("api_endpoint is recognised as an item-linked graph type", () => {
  expect(isItemLinkedGraphType("api_endpoint")).toBe(true);
});

test("syncing an api_endpoint item creates an api_endpoint entity and a `targets` relation to its service", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 25);
  syncGraphFromIndexedItem(db, {
    id: "openapi:abcdef0#GET:/v1/payments",
    service: "openapi",
    type: "api_endpoint",
    title: "GET /v1/payments",
    bodyPreview: null,
    authorId: null,
    metadata: { service_name: "payments-api", spec_file: "/tmp/openapi.yaml" },
  });
  const ent = db
    .query("SELECT type, label FROM graph_entity WHERE external_id = ?")
    .get("openapi:abcdef0#GET:/v1/payments") as { type: string; label: string } | null;
  expect(ent?.type).toBe("api_endpoint");
  const rels = db
    .query(
      "SELECT type FROM graph_relation WHERE from_id = (SELECT id FROM graph_entity WHERE external_id = ?)",
    )
    .all("openapi:abcdef0#GET:/v1/payments") as Array<{ type: string }>;
  expect(rels.some((r) => r.type === "targets")).toBe(true);
});
