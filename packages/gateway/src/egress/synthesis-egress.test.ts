// packages/gateway/src/egress/synthesis-egress.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { THIS_BINARY_COVERAGE } from "./egress-coverage.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { listEgress, verifyEgressChain } from "./egress-verify.ts";
import { recordSynthesisEgress } from "./synthesis-egress.ts";

describe("model coverage", () => {
  test("model is raised to per-call now that brief synthesis appends", () => {
    expect(THIS_BINARY_COVERAGE.model).toBe("per-call");
  });
});

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

describe("recordSynthesisEgress", () => {
  test("appends one authorized `model` row for a remote-provider brief synthesis", () => {
    recordSynthesisEgress(db, { briefKind: "catchup", model: "gpt-5", now: 1_000, remote: true });
    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "model",
      sourceId: "gpt-5",
      destination: "model",
      method: "agents.catchup.synthesis",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });
    // Pinned so replacing `args.now` with `Date.now()`, or dropping the
    // `redactEgressSummary` call, would fail this test rather than staying green.
    expect(rows[0]?.timestamp).toBe(1_000);
    expect(rows[0]?.payloadSummary).toBe(
      redactEgressSummary({ briefKind: "catchup", model: "gpt-5" }),
    );
  });

  test("a local-provider synthesis (`remote: false`) appends NOTHING — not even a blocked row", () => {
    recordSynthesisEgress(db, {
      briefKind: "catchup",
      model: "local-test-model:latest",
      now: 1_000,
      remote: false,
    });
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("two remote appends chain correctly (BLAKE3, I10-verifiable)", () => {
    recordSynthesisEgress(db, { briefKind: "catchup", model: "gpt-5", now: 1_000, remote: true });
    recordSynthesisEgress(db, {
      briefKind: "expert",
      model: "claude-opus",
      now: 2_000,
      remote: true,
    });
    const result = verifyEgressChain(db);
    expect(result.ok).toBe(true);
    expect(listEgress(db, {})).toHaveLength(2);
  });

  test("a throwing appendEgressEntry (e.g. a closed db) propagates rather than swallowing", () => {
    db.close();
    expect(() =>
      recordSynthesisEgress(db, { briefKind: "catchup", model: "gpt-5", now: 1, remote: true }),
    ).toThrow();
  });
});
