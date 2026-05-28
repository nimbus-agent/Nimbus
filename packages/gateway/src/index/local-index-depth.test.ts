import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "./local-index.ts";

function makeIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const idx = new LocalIndex(db);
  db.run(
    `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token) VALUES (?, NULL, NULL)`,
    ["github"],
  );
  return idx;
}

describe("LocalIndex.setConnectorDepth / getConnectorDepth", () => {
  test("default depth on a freshly registered connector is 'summary'", () => {
    const idx = makeIndex();
    expect(idx.getConnectorDepth("github")).toBe("summary");
  });

  test("setConnectorDepth persists a new depth value", () => {
    const idx = makeIndex();
    idx.setConnectorDepth("github", "full");
    expect(idx.getConnectorDepth("github")).toBe("full");
  });

  test("setConnectorDepth is idempotent for the same value", () => {
    const idx = makeIndex();
    idx.setConnectorDepth("github", "metadata_only");
    idx.setConnectorDepth("github", "metadata_only");
    expect(idx.getConnectorDepth("github")).toBe("metadata_only");
  });

  test("getConnectorDepth for an unknown connector throws", () => {
    const idx = makeIndex();
    expect(() => idx.getConnectorDepth("notexist")).toThrow(/unknown|not registered/i);
  });
});
