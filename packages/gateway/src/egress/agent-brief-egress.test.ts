// packages/gateway/src/egress/agent-brief-egress.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { recordAgentBriefEgress } from "./agent-brief-egress.ts";
import { verifyEgressChain } from "./egress-verify.ts";

/**
 * The REAL V44 `egress_ledger`, built by the migration runner rather than a hand-copied
 * `CREATE TABLE`. A local copy would drift from the shipped schema silently, and this appender's
 * whole job is to write rows the shipped reader/verifier can read.
 */
function ledgerDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

test("appends exactly one row with source_type 'mcp'", () => {
  const db = ledgerDb();
  recordAgentBriefEgress(db, {
    sourceType: "mcp",
    method: "agents.why",
    params: { fileOrPrUrl: "src/a.ts" },
    clientId: "c1",
    now: 1000,
  });
  const rows = db
    .query(`SELECT source_type, method, destination, source_id, timestamp FROM egress_ledger`)
    .all() as Array<{
    source_type: string;
    method: string;
    destination: string;
    source_id: string | null;
    timestamp: number;
  }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.source_type).toBe("mcp");
  expect(rows[0]?.method).toBe("agents.why");
  expect(rows[0]?.destination).toBe("mcp");
  expect(rows[0]?.source_id).toBe("c1");
  expect(rows[0]?.timestamp).toBe(1000);
  db.close();
});

test("the appended row participates in the BLAKE3 chain like any other", () => {
  const db = ledgerDb();
  recordAgentBriefEgress(db, {
    sourceType: "mcp",
    method: "agents.why",
    params: {},
    clientId: "c1",
    now: 1,
  });
  recordAgentBriefEgress(db, {
    sourceType: "mcp",
    method: "agents.catchup",
    params: {},
    clientId: "c1",
    now: 2,
  });
  expect(verifyEgressChain(db).ok).toBe(true);
  db.close();
});

test("federation-touching agents record a distinguishable destination", () => {
  const db = ledgerDb();
  recordAgentBriefEgress(db, {
    sourceType: "mcp",
    method: "agents.ghost",
    params: {},
    clientId: "c1",
    now: 1,
  });
  recordAgentBriefEgress(db, {
    sourceType: "mcp",
    method: "agents.huddle",
    params: {},
    clientId: "c1",
    now: 2,
  });
  recordAgentBriefEgress(db, {
    sourceType: "mcp",
    method: "agents.why",
    params: {},
    clientId: "c1",
    now: 3,
  });
  const dests = (
    db.query(`SELECT destination FROM egress_ledger ORDER BY id`).all() as Array<{
      destination: string;
    }>
  ).map((r) => r.destination);
  expect(dests).toEqual(["mcp+federation", "mcp+federation", "mcp"]);
  db.close();
});

test("the payload summary is redacted and capped", () => {
  const db = ledgerDb();
  recordAgentBriefEgress(db, {
    sourceType: "mcp",
    method: "agents.expert",
    params: { topicOrFile: "x", token: "ghp_averysecretvaluethatmustnotsurvive" },
    clientId: "c1",
    now: 1,
  });
  const row = db.query(`SELECT payload_summary FROM egress_ledger`).get() as {
    payload_summary: string;
  };
  expect(row.payload_summary).not.toContain("ghp_averysecretvaluethatmustnotsurvive");
  expect(row.payload_summary.length).toBeLessThanOrEqual(300);
  db.close();
});

test("hitl status is not_required and result is authorized", () => {
  const db = ledgerDb();
  recordAgentBriefEgress(db, {
    sourceType: "mcp",
    method: "agents.why",
    params: {},
    clientId: "c1",
    now: 1,
  });
  const row = db.query(`SELECT hitl_status, result_status FROM egress_ledger`).get() as {
    hitl_status: string;
    result_status: string;
  };
  expect(row.hitl_status).toBe("not_required");
  expect(row.result_status).toBe("authorized");
  db.close();
});

test("the sourceType drives BOTH the column and the destination", () => {
  // The parameterisation is the whole point of the rename: one appender, two transports, and the
  // federation-touching distinction preserved on each. A bare "http" destination here would hide
  // outbound peer traffic inside a local-looking record — the exact failure the mcp destinations
  // were split to avoid.
  const db = ledgerDb();
  recordAgentBriefEgress(db, {
    sourceType: "http",
    method: "agents.ghost",
    params: {},
    clientId: "chrome",
    now: 1,
  });
  recordAgentBriefEgress(db, {
    sourceType: "http",
    method: "agents.why",
    params: {},
    clientId: "chrome",
    now: 2,
  });
  const rows = db
    .query(`SELECT source_type, destination, source_id FROM egress_ledger ORDER BY id`)
    .all() as Array<{ source_type: string; destination: string; source_id: string }>;
  expect(rows.map((r) => r.source_type)).toEqual(["http", "http"]);
  expect(rows.map((r) => r.destination)).toEqual(["http+federation", "http"]);
  expect(rows[0]?.source_id).toBe("chrome");
  db.close();
});

test("an append failure propagates so the caller can fail closed", () => {
  const db = new Database(":memory:"); // no egress_ledger table
  expect(() =>
    recordAgentBriefEgress(db, {
      sourceType: "mcp",
      method: "agents.why",
      params: {},
      clientId: "c1",
      now: 1,
    }),
  ).toThrow();
  db.close();
});
