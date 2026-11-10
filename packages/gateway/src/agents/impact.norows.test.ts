/** `runImpact` sub-agents whose entity type exists but the start entity has no edge to it: no finding, no gap. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { runImpact } from "./impact.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
      "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
  );
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
      "('graph:symbol:s', 'symbol', 'item:filesystem:src/s.ts', 'src/s.ts', 'filesystem', '{}')",
  );
  return db;
}

describe("runImpact with entities of a type but no edge from the start", () => {
  test("an on-call rotation that exists but is not linked yields no oncall finding", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token) VALUES ('pagerduty', 0, '')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:oncall:r1', 'oncall_rotation', 'pagerduty:rot-1', 'Primary On-Call', 'pagerduty', '{}')",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "src/s.ts" },
      { db, sessionId: "t-oc-none", notify: () => {} },
    );
    expect(brief.affected.filter((f) => f.category === "oncall_rotation")).toEqual([]);
  });

  test("a dashboard that exists but is not referenced yields no dashboard finding", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:dash:1', 'dashboard', 'metabase:42', 'Revenue Dashboard', 'metabase', '{}')",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "src/s.ts" },
      { db, sessionId: "t-dash-none", notify: () => {} },
    );
    expect(brief.affected.filter((f) => f.category === "dashboard")).toEqual([]);
  });

  test("an entity with no repo or service neighbours yields no service finding", async () => {
    const db = freshDb();
    const brief = await runImpact(
      { fileOrPrUrl: "src/s.ts" },
      { db, sessionId: "t-svc-none", notify: () => {} },
    );
    expect(brief.affected.filter((f) => f.category === "service")).toEqual([]);
    expect(brief.startEntityId).toBe("graph:symbol:s");
  });
});
