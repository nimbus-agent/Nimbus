import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import {
  type CaptureGateDeps,
  captureStatus,
  getCapture,
  listCaptures,
  revokeCapture,
  submitCapture,
} from "./capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import { CaptureStore } from "./capture-store.ts";
import { CaptureError } from "./capture-types.ts";

const MCP = { clientId: "c-mcp", kind: "mcp" as const };
const OWNER = { clientId: "c-cli", kind: "unknown" as const };
const OPEN = { capabilitiesDisabled: new Set<string>() };

let db: Database;
let deps: CaptureGateDeps;
let cap: CaptureCapability;
let clock: number;
let seq: number;
let embedded: string[];

function onConfig(over: Partial<typeof DEFAULT_MCP_SINK_CONFIG> = {}): CaptureCapability {
  return resolveCaptureCapability(
    { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, ...over } },
    OPEN,
  );
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  clock = 1_000_000;
  seq = 0;
  embedded = [];
  cap = onConfig();
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () => cap,
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => clock,
    scheduleEmbedding: (id) => embedded.push(id),
  };
});
afterEach(() => db.close());

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected CaptureError");
}

function auditRows(): Array<{
  action_type: string;
  hitl_status: string;
  action_json: string;
  session_id: string | null;
}> {
  return db
    .query(
      "SELECT action_type, hitl_status, action_json, session_id FROM audit_log WHERE action_type LIKE 'capture.%' ORDER BY id",
    )
    .all() as Array<{
    action_type: string;
    hitl_status: string;
    action_json: string;
    session_id: string | null;
  }>;
}

const NOTE = {
  kind: "note",
  payload: { title: "Why WAL", body: "We chose WAL because…" },
  clientLabel: "claude-code",
};

describe("submitCapture — success", () => {
  test("writes row + item + one audit row in one go, schedules embedding, returns live", () => {
    expect(submitCapture(deps, MCP, NOTE)).toEqual({ id: "cap_1", state: "live" });
    const row = deps.store.get("cap_1");
    expect(row).toMatchObject({
      kind: "note",
      state: "live",
      itemId: "nimbus:cap_1",
      clientLabel: "claude-code",
      sessionId: "c-mcp",
    });
    const item = db
      .query("SELECT service, type, title, body FROM item WHERE id = 'nimbus:cap_1'")
      .get();
    expect(item).toEqual({
      service: "nimbus",
      type: "capture",
      title: "Why WAL",
      body: "We chose WAL because…",
    });
    const meta = JSON.parse(
      (
        db.query("SELECT metadata FROM item WHERE id = 'nimbus:cap_1'").get() as {
          metadata: string;
        }
      ).metadata,
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({
      captureKind: "note",
      captureId: "cap_1",
      agentAuthored: true,
      clientLabel: "claude-code",
    });
    expect(embedded).toEqual(["nimbus:cap_1"]);
    const a = auditRows();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      action_type: "capture.submit",
      hitl_status: "not_required",
      session_id: "c-mcp",
    });
    expect(JSON.parse(a[0]?.action_json ?? "{}")).toMatchObject({
      captureId: "cap_1",
      kind: "note",
      outcome: "captured",
    });
  });

  test("audit failure rolls the whole write back (fail-closed)", () => {
    db.run("DROP TABLE audit_log");
    expect(() => submitCapture(deps, MCP, NOTE)).toThrow();
    expect(deps.store.get("cap_1")).toBeUndefined();
    expect(db.query("SELECT 1 FROM item WHERE id = 'nimbus:cap_1'").get()).toBeNull();
    expect(embedded).toEqual([]);
  });
});

describe("submitCapture — ordered refusals", () => {
  test("1 disabled: refuses BEFORE reading the payload; counted, not audited", () => {
    cap = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    expect(
      codeOf(() => submitCapture(deps, MCP, { kind: "note", payload: "not even an object" })),
    ).toBe("ERR_CAPTURE_DISABLED");
    expect(auditRows()).toEqual([]);
    expect(deps.refusals.snapshot()).toEqual({ ERR_CAPTURE_DISABLED: 1 });
  });

  test("2 a non-mcp client cannot submit; counted, not audited", () => {
    expect(codeOf(() => submitCapture(deps, OWNER, NOTE))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(codeOf(() => submitCapture(deps, { clientId: "h", kind: "http" }, NOTE))).toBe(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
    );
    expect(auditRows()).toEqual([]);
  });

  test("3 attempt limit (4 × max_per_hour) fires before validation; counted, not audited", () => {
    cap = onConfig({ maxPerHour: 1 });
    for (let i = 0; i < 4; i++)
      codeOf(() => submitCapture(deps, MCP, { kind: "note", payload: {} }));
    expect(codeOf(() => submitCapture(deps, MCP, NOTE))).toBe("ERR_CAPTURE_RATE_LIMITED");
    expect(
      auditRows().every((r) => JSON.parse(r.action_json).outcome === "ERR_CAPTURE_INVALID"),
    ).toBe(true);
    expect(deps.refusals.snapshot()["ERR_CAPTURE_RATE_LIMITED"]).toBe(1);
  });

  test("4 a kind outside config ∩ submittable is refused and audited", () => {
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "decision", payload: {} }))).toBe(
      "ERR_CAPTURE_KIND_NOT_ALLOWED",
    );
    cap = onConfig({ kinds: ["term"] });
    expect(codeOf(() => submitCapture(deps, MCP, NOTE))).toBe("ERR_CAPTURE_KIND_NOT_ALLOWED");
    const a = auditRows();
    expect(a).toHaveLength(2);
    expect(a.every((r) => r.hitl_status === "rejected")).toBe(true);
  });

  test("5 invalid payload is refused and audited without the payload", () => {
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "note", payload: { body: "" } }))).toBe(
      "ERR_CAPTURE_INVALID",
    );
    const j = JSON.parse(auditRows()[0]?.action_json ?? "{}") as Record<string, unknown>;
    expect(j).toEqual({ kind: "note", clientLabel: null, outcome: "ERR_CAPTURE_INVALID" });
  });

  test("6 relatesTo must name existing items; a capture item only while live", () => {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "1",
      title: "PR",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(
      submitCapture(deps, MCP, { kind: "note", payload: { body: "b", relatesTo: ["github:1"] } })
        .state,
    ).toBe("live");
    expect(
      codeOf(() =>
        submitCapture(deps, MCP, {
          kind: "note",
          payload: { body: "b", relatesTo: ["github:404"] },
        }),
      ),
    ).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
    // Review Focus 5: a revoked note's former item id is gone.
    revokeCapture(deps, OWNER, "cap_1");
    expect(
      codeOf(() =>
        submitCapture(deps, MCP, {
          kind: "note",
          payload: { body: "b", relatesTo: ["nimbus:cap_1"] },
        }),
      ),
    ).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
  });

  test("7 durable hourly cap reads the TABLE, so a fresh limiter (restart) does not reset it", () => {
    cap = onConfig({ maxPerHour: 1 });
    submitCapture(deps, MCP, NOTE);
    deps = { ...deps, limiter: new CaptureAttemptLimiter() };
    expect(codeOf(() => submitCapture(deps, MCP, NOTE))).toBe("ERR_CAPTURE_RATE_LIMITED");
    clock += 3_600_001;
    expect(submitCapture(deps, MCP, NOTE).state).toBe("live");
  });

  test("the client label is sanitised before storage", () => {
    submitCapture(deps, MCP, { ...NOTE, clientLabel: "evil\u001b[2J" });
    expect(deps.store.get("cap_1")?.clientLabel).toBe("evil[2J");
  });

  test("a non-object input is refused as invalid", () => {
    expect(codeOf(() => submitCapture(deps, MCP, "x"))).toBe("ERR_CAPTURE_INVALID");
  });
});

describe("revokeCapture", () => {
  test("owner revokes a live note: item gone, tombstone kept, one audit row", () => {
    submitCapture(deps, MCP, NOTE);
    clock += 5;
    expect(revokeCapture(deps, OWNER, "cap_1")).toEqual({ id: "cap_1", state: "revoked" });
    expect(db.query("SELECT 1 FROM item WHERE id = 'nimbus:cap_1'").get()).toBeNull();
    expect(deps.store.get("cap_1")).toMatchObject({
      state: "revoked",
      payloadJson: null,
      decidedAt: clock,
    });
    const revokes = auditRows().filter((r) => r.action_type === "capture.revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]?.hitl_status).toBe("not_required");
  });

  test("Review Focus 2: revoking twice is a no-op success with no second audit row", () => {
    submitCapture(deps, MCP, NOTE);
    revokeCapture(deps, OWNER, "cap_1");
    expect(revokeCapture(deps, OWNER, "cap_1")).toEqual({ id: "cap_1", state: "revoked" });
    expect(auditRows().filter((r) => r.action_type === "capture.revoke")).toHaveLength(1);
  });

  test("works while the sink is DISABLED (withdrawing agent text is always possible)", () => {
    submitCapture(deps, MCP, NOTE);
    cap = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    expect(revokeCapture(deps, OWNER, "cap_1").state).toBe("revoked");
  });

  test("an mcp client cannot revoke; unknown ids are NOT_FOUND; a bad id is INVALID", () => {
    submitCapture(deps, MCP, NOTE);
    expect(codeOf(() => revokeCapture(deps, MCP, "cap_1"))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(codeOf(() => revokeCapture(deps, OWNER, "cap_404"))).toBe("ERR_CAPTURE_NOT_FOUND");
    expect(codeOf(() => revokeCapture(deps, OWNER, 7))).toBe("ERR_CAPTURE_INVALID");
  });

  test("a live note whose item was already deleted (data.delete) still revokes", () => {
    submitCapture(deps, MCP, NOTE);
    db.run("DELETE FROM item WHERE id = 'nimbus:cap_1'");
    expect(revokeCapture(deps, OWNER, "cap_1").state).toBe("revoked");
  });
});

describe("list / get / status", () => {
  test("list returns every state, newest first, limit 1..200", () => {
    submitCapture(deps, MCP, NOTE);
    clock += 1;
    submitCapture(deps, MCP, { ...NOTE, payload: { title: "Second", body: "b" } });
    const out = listCaptures(deps, OWNER, {});
    expect(out.captures.map((c) => [c.id, c.title])).toEqual([
      ["cap_2", "Second"],
      ["cap_1", "Why WAL"],
    ]);
    expect(listCaptures(deps, OWNER, { state: "revoked" }).captures).toEqual([]);
    expect(codeOf(() => listCaptures(deps, OWNER, { limit: 0 }))).toBe("ERR_CAPTURE_INVALID");
    expect(codeOf(() => listCaptures(deps, OWNER, { state: "bogus" }))).toBe("ERR_CAPTURE_INVALID");
    expect(codeOf(() => listCaptures(deps, MCP, {}))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
  });

  test("get returns the parsed payload; revoked returns payload null", () => {
    submitCapture(deps, MCP, NOTE);
    expect(getCapture(deps, OWNER, "cap_1").payload).toEqual({
      title: "Why WAL",
      body: "We chose WAL because…",
      tags: [],
      relatesTo: [],
    });
    revokeCapture(deps, OWNER, "cap_1");
    expect(getCapture(deps, OWNER, "cap_1").payload).toBeNull();
  });

  test("status reports enabled, kinds, counts and refusal counters; disabled names the reason", () => {
    submitCapture(deps, MCP, NOTE);
    expect(captureStatus(deps)).toEqual({
      enabled: true,
      kinds: ["note"],
      pending: 0,
      maxPending: 100,
      maxPerHour: 30,
      refusedSinceStart: {},
    });
    cap = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
      undefined,
    );
    expect(captureStatus(deps)).toMatchObject({ enabled: false, disabledReason: "policy" });
  });
});
