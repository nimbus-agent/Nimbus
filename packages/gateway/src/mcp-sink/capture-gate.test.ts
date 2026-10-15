import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import {
  computeTermStats,
  getTerm,
  markVetoed,
  upsertCandidate,
  upsertManualTerm,
} from "../glossary/glossary-store.ts";
import { deleteGraphEntitiesForItemKeys } from "../graph/relationship-graph.ts";
import { deleteItemByPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import {
  acceptCapture,
  type CaptureGateDeps,
  captureStateFor,
  captureStatus,
  getCapture,
  listCaptures,
  rejectCapture,
  revokeCapture,
  submitCapture,
} from "./capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import { CaptureStore, REJECTED_RETENTION_MS } from "./capture-store.ts";
import { CaptureError } from "./capture-types.ts";

const MCP = { clientId: "c-mcp", kind: "mcp" as const };
const OWNER = { clientId: "c-cli", kind: "unknown" as const };
const OPEN = { capabilitiesDisabled: new Set<string>() };
/** Written as a code point, never a literal or an escape sequence: the format hook can rewrite escapes into invisibles. */
const ZWSP = String.fromCodePoint(0x200b);

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

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
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
  test("writes row + item + one audit row in one go, schedules embedding, returns live", async () => {
    expect(await submitCapture(deps, MCP, NOTE)).toEqual({ id: "cap_1", state: "live" });
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

  test("a 600-character body lands in full (long-body cap, end to end)", async () => {
    const body = "x".repeat(600);
    await submitCapture(deps, MCP, { kind: "note", payload: { title: "Long", body } });
    const row = db.query("SELECT body FROM item WHERE id = 'nimbus:cap_1'").get() as {
      body: string;
    };
    expect(row.body).toHaveLength(600);
    expect(row.body).toBe(body);
  });

  test("audit failure rolls the whole write back (fail-closed)", async () => {
    db.run("DROP TABLE audit_log");
    await expect(submitCapture(deps, MCP, NOTE)).rejects.toThrow(/audit_log/);
    expect(deps.store.get("cap_1")).toBeUndefined();
    expect(db.query("SELECT 1 FROM item WHERE id = 'nimbus:cap_1'").get()).toBeNull();
    expect(embedded).toEqual([]);
  });
});

describe("submitCapture — ordered refusals", () => {
  test("1 disabled: refuses BEFORE reading the payload; counted, not audited", async () => {
    cap = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    expect(
      await codeOfAsync(() =>
        submitCapture(deps, MCP, { kind: "note", payload: "not even an object" }),
      ),
    ).toBe("ERR_CAPTURE_DISABLED");
    expect(auditRows()).toEqual([]);
    expect(deps.refusals.snapshot()).toEqual({ ERR_CAPTURE_DISABLED: 1 });
  });

  test("2 a non-mcp client cannot submit; counted, not audited", async () => {
    expect(await codeOfAsync(() => submitCapture(deps, OWNER, NOTE))).toBe(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
    );
    expect(
      await codeOfAsync(() => submitCapture(deps, { clientId: "h", kind: "http" }, NOTE)),
    ).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(auditRows()).toEqual([]);
  });

  test("3 attempt limit (4 × max_per_hour) fires before validation; counted, not audited", async () => {
    cap = onConfig({ maxPerHour: 1 });
    for (let i = 0; i < 4; i++)
      await codeOfAsync(() => submitCapture(deps, MCP, { kind: "note", payload: {} }));
    expect(await codeOfAsync(() => submitCapture(deps, MCP, NOTE))).toBe(
      "ERR_CAPTURE_RATE_LIMITED",
    );
    expect(auditRows()).toHaveLength(4);
    expect(
      auditRows().every((r) => JSON.parse(r.action_json).outcome === "ERR_CAPTURE_INVALID"),
    ).toBe(true);
    expect(deps.refusals.snapshot()["ERR_CAPTURE_RATE_LIMITED"]).toBe(1);
  });

  test("4 a kind outside config ∩ submittable is refused and audited", async () => {
    cap = onConfig({ kinds: ["note"] });
    expect(
      await codeOfAsync(() => submitCapture(deps, MCP, { kind: "decision", payload: {} })),
    ).toBe("ERR_CAPTURE_KIND_NOT_ALLOWED");
    cap = onConfig({ kinds: ["term"] });
    expect(await codeOfAsync(() => submitCapture(deps, MCP, NOTE))).toBe(
      "ERR_CAPTURE_KIND_NOT_ALLOWED",
    );
    const a = auditRows();
    expect(a).toHaveLength(2);
    expect(a.every((r) => r.hitl_status === "rejected")).toBe(true);
  });

  test("5 invalid payload is refused and audited without the payload", async () => {
    expect(
      await codeOfAsync(() => submitCapture(deps, MCP, { kind: "note", payload: { body: "" } })),
    ).toBe("ERR_CAPTURE_INVALID");
    const j = JSON.parse(auditRows()[0]?.action_json ?? "{}") as Record<string, unknown>;
    expect(j).toEqual({ kind: "note", clientLabel: null, outcome: "ERR_CAPTURE_INVALID" });
  });

  test("6 relatesTo must name existing items; a capture item only while live", async () => {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "1",
      title: "PR",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(
      (
        await submitCapture(deps, MCP, {
          kind: "note",
          payload: { body: "b", relatesTo: ["github:1"] },
        })
      ).state,
    ).toBe("live");
    expect(
      await codeOfAsync(() =>
        submitCapture(deps, MCP, {
          kind: "note",
          payload: { body: "b", relatesTo: ["github:404"] },
        }),
      ),
    ).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
    // Review Focus 5: a revoked note's former item id is gone.
    revokeCapture(deps, OWNER, "cap_1");
    expect(
      await codeOfAsync(() =>
        submitCapture(deps, MCP, {
          kind: "note",
          payload: { body: "b", relatesTo: ["nimbus:cap_1"] },
        }),
      ),
    ).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
  });

  test("7 durable hourly cap reads the TABLE, so a fresh limiter (restart) does not reset it", async () => {
    cap = onConfig({ maxPerHour: 1 });
    await submitCapture(deps, MCP, NOTE);
    deps = { ...deps, limiter: new CaptureAttemptLimiter() };
    expect(await codeOfAsync(() => submitCapture(deps, MCP, NOTE))).toBe(
      "ERR_CAPTURE_RATE_LIMITED",
    );
    clock += 3_600_001;
    expect((await submitCapture(deps, MCP, NOTE)).state).toBe("live");
  });

  test("the client label is sanitised before storage", async () => {
    await submitCapture(deps, MCP, { ...NOTE, clientLabel: "evil\u001b[2J" });
    expect(deps.store.get("cap_1")?.clientLabel).toBe("evil[2J");
  });

  test("a non-object input is refused as invalid", async () => {
    expect(await codeOfAsync(() => submitCapture(deps, MCP, "x"))).toBe("ERR_CAPTURE_INVALID");
  });
});

describe("revokeCapture", () => {
  test("owner revokes a live note: item gone, tombstone kept, one audit row", async () => {
    await submitCapture(deps, MCP, NOTE);
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

  test("Review Focus 2: revoking twice is a no-op success with no second audit row", async () => {
    await submitCapture(deps, MCP, NOTE);
    revokeCapture(deps, OWNER, "cap_1");
    expect(revokeCapture(deps, OWNER, "cap_1")).toEqual({ id: "cap_1", state: "revoked" });
    expect(auditRows().filter((r) => r.action_type === "capture.revoke")).toHaveLength(1);
  });

  test("works while the sink is DISABLED (withdrawing agent text is always possible)", async () => {
    await submitCapture(deps, MCP, NOTE);
    cap = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    expect(revokeCapture(deps, OWNER, "cap_1").state).toBe("revoked");
  });

  test("an mcp client cannot revoke; unknown ids are NOT_FOUND; a bad id is INVALID", async () => {
    await submitCapture(deps, MCP, NOTE);
    expect(codeOf(() => revokeCapture(deps, MCP, "cap_1"))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(codeOf(() => revokeCapture(deps, OWNER, "cap_404"))).toBe("ERR_CAPTURE_NOT_FOUND");
    expect(codeOf(() => revokeCapture(deps, OWNER, 7))).toBe("ERR_CAPTURE_INVALID");
  });

  // Wrap the real store; only markRevoked loses the race, and the post-race get reports `after`.
  function lostRaceDeps(after: "revoked" | "live"): CaptureGateDeps {
    const real = deps.store;
    let raced = false;
    const store = Object.create(real) as CaptureStore;
    store.markRevoked = () => {
      raced = true;
      return false;
    };
    store.get = (id: string) => {
      const r = real.get(id);
      return raced && r !== undefined ? { ...r, state: after } : r;
    };
    return { ...deps, store };
  }

  test("lost race, winner already revoked: success, no capture.revoke audit row from the loser", async () => {
    await submitCapture(deps, MCP, NOTE);
    expect(revokeCapture(lostRaceDeps("revoked"), OWNER, "cap_1")).toEqual({
      id: "cap_1",
      state: "revoked",
    });
    expect(auditRows().filter((r) => r.action_type === "capture.revoke")).toHaveLength(0);
  });

  test("lost race, row still live afterwards: ERR_CAPTURE_STATE", async () => {
    await submitCapture(deps, MCP, NOTE);
    expect(codeOf(() => revokeCapture(lostRaceDeps("live"), OWNER, "cap_1"))).toBe(
      "ERR_CAPTURE_STATE",
    );
  });

  test("a live note whose item was already deleted (data.delete) still revokes", async () => {
    await submitCapture(deps, MCP, NOTE);
    db.run("DELETE FROM item WHERE id = 'nimbus:cap_1'");
    expect(revokeCapture(deps, OWNER, "cap_1").state).toBe("revoked");
  });
});

describe("list / get / status", () => {
  test("list returns every state, newest first, limit 1..200", async () => {
    await submitCapture(deps, MCP, NOTE);
    clock += 1;
    await submitCapture(deps, MCP, { ...NOTE, payload: { title: "Second", body: "b" } });
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

  test("get returns the parsed payload; revoked returns payload null", async () => {
    await submitCapture(deps, MCP, NOTE);
    expect(getCapture(deps, OWNER, "cap_1").payload).toEqual({
      title: "Why WAL",
      body: "We chose WAL because…",
      tags: [],
      relatesTo: [],
    });
    revokeCapture(deps, OWNER, "cap_1");
    expect(getCapture(deps, OWNER, "cap_1").payload).toBeNull();
  });

  test("status reports enabled, kinds, counts and refusal counters; disabled names the reason", async () => {
    await submitCapture(deps, MCP, NOTE);
    expect(await captureStatus(deps)).toEqual({
      enabled: true,
      kinds: ["note", "decision", "term", "link"],
      pending: 0,
      maxPending: 100,
      maxPerHour: 30,
      refusedSinceStart: {},
      actionEnabled: false,
      proposableActionTypes: [],
      actionPending: 0,
      actionExpiringWithinHour: 0,
      actionMaxPending: 10,
      actionTtlHours: 24,
    });
    cap = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
      undefined,
    );
    expect(await captureStatus(deps)).toMatchObject({ enabled: false, disabledReason: "policy" });
  });
});

function graphedItems(n: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: `acme/app#${String(i)}`,
      title: `PR ${String(i)}`,
      bodyPreview: "patch",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: { repo: "acme/app" },
    });
    const r = db
      .query("SELECT id FROM item WHERE external_id = ?")
      .get(`acme/app#${String(i)}`) as {
      id: string;
    };
    ids.push(r.id);
  }
  return ids;
}

describe("submit — proposals", () => {
  test("a decision is stored proposed: no item, no embedding, audited not_required/proposed", async () => {
    const r = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "Adopt WAL" },
    });
    expect(r.state).toBe("proposed");
    expect(deps.store.get(r.id)?.itemId).toBeNull();
    const items = db
      .query("SELECT COUNT(*) AS n FROM item WHERE service = 'nimbus' AND type = 'capture'")
      .get() as { n: number };
    expect(items.n).toBe(0);
    expect(embedded).toEqual([]);
    const n = (sql: string): number => (db.query(sql).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) AS n FROM decision_record")).toBe(0);
    const last = auditRows().at(-1);
    expect(last?.hitl_status).toBe("not_required");
    expect(JSON.parse(last?.action_json ?? "{}")).toMatchObject({
      kind: "decision",
      outcome: "proposed",
    });
  });

  test("a term proposal writes no glossary row", async () => {
    await submitCapture(deps, MCP, { kind: "term", payload: { term: "WAL", definition: "log" } });
    const g = db.query("SELECT COUNT(*) AS n FROM glossary_term").get() as { n: number };
    expect(g.n).toBe(0);
  });

  test("step 8: the pending cap refuses a proposal (audited) but never a note", async () => {
    cap = onConfig({ maxPending: 1 });
    await submitCapture(deps, MCP, { kind: "term", payload: { term: "WAL", definition: "log" } });
    expect(
      await codeOfAsync(() =>
        submitCapture(deps, MCP, { kind: "term", payload: { term: "MVCC", definition: "x" } }),
      ),
    ).toBe("ERR_CAPTURE_QUEUE_FULL");
    expect(JSON.parse(auditRows().at(-1)?.action_json ?? "{}")).toMatchObject({
      outcome: "ERR_CAPTURE_QUEUE_FULL",
    });
    expect(
      (await submitCapture(deps, MCP, { kind: "note", payload: { body: "still fine" } })).state,
    ).toBe("live");
  });

  test("step 6: a link refuses an unknown item, then an ungraphed one, then a capture item", async () => {
    expect(
      await codeOfAsync(() =>
        submitCapture(deps, MCP, {
          kind: "link",
          payload: { fromItemId: "x:1", toItemId: "y:2", relation: "fixes" },
        }),
      ),
    ).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
    expect(JSON.parse(auditRows().at(-1)?.action_json ?? "{}")).toMatchObject({
      kind: "link",
      outcome: "ERR_CAPTURE_UNKNOWN_ITEM",
    });
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "file",
      externalId: "a",
      title: "a",
      modifiedAt: 1,
      syncedAt: 1,
    });
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "file",
      externalId: "b",
      title: "b",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(
      await codeOfAsync(() =>
        submitCapture(deps, MCP, {
          kind: "link",
          payload: { fromItemId: "filesystem:a", toItemId: "filesystem:b", relation: "fixes" },
        }),
      ),
    ).toBe("ERR_CAPTURE_LINK_UNRESOLVED");
    const refused = auditRows().at(-1);
    expect(refused?.hitl_status).toBe("rejected");
    expect(JSON.parse(refused?.action_json ?? "{}")).toMatchObject({
      kind: "link",
      outcome: "ERR_CAPTURE_LINK_UNRESOLVED",
    });
    const note = await submitCapture(deps, MCP, { kind: "note", payload: { body: "n" } });
    const [pr] = graphedItems(1);
    expect(
      await codeOfAsync(() =>
        submitCapture(deps, MCP, {
          kind: "link",
          payload: { fromItemId: `nimbus:${note.id}`, toItemId: pr, relation: "relates_to" },
        }),
      ),
    ).toBe("ERR_CAPTURE_LINK_UNRESOLVED");
  });

  test("a link between two graphed items is accepted as a proposal", async () => {
    const [a, b] = graphedItems(2);
    expect(
      (
        await submitCapture(deps, MCP, {
          kind: "link",
          payload: { fromItemId: a, toItemId: b, relation: "fixes" },
        })
      ).state,
    ).toBe("proposed");
    const r = db
      .query("SELECT COUNT(*) AS n FROM graph_relation WHERE type LIKE 'captured_%'")
      .get() as { n: number };
    expect(r.n).toBe(0);
  });

  test("a validation failure on a proposal kind is audited and rethrown", async () => {
    expect(
      await codeOfAsync(() => submitCapture(deps, MCP, { kind: "decision", payload: {} })),
    ).toBe("ERR_CAPTURE_INVALID");
    const last = auditRows().at(-1);
    expect(last?.hitl_status).toBe("rejected");
    expect(JSON.parse(last?.action_json ?? "{}")).toMatchObject({
      kind: "decision",
      outcome: "ERR_CAPTURE_INVALID",
    });
  });

  test("a link whose ids are 300 characters each lists with a 120-character title", () => {
    const [a, b] = graphedItems(2);
    deps.store.insert({
      id: "cap_long",
      kind: "link",
      state: "proposed",
      itemId: null,
      payloadJson: JSON.stringify({
        fromItemId: `${a ?? ""}${"x".repeat(300)}`,
        toItemId: `${b ?? ""}${"y".repeat(300)}`,
        relation: "fixes",
      }),
      payloadBytes: 700,
      clientLabel: null,
      sessionId: "c-mcp",
      createdAt: clock,
      expiresAt: null,
    });
    const listed = listCaptures(deps, OWNER, { state: "proposed" });
    expect(listed.captures[0]?.title).toHaveLength(120);
  });

  test("captureStatus counts proposals as pending; kinds now lists all four", async () => {
    await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    const s = await captureStatus(deps);
    expect(s.pending).toBe(1);
    expect([...s.kinds].sort()).toEqual(["decision", "link", "note", "term"]);
  });
});

describe("accept", () => {
  test("decision: native row + capture item + embedding + one not_required audit row, in one transaction", async () => {
    const [ev] = graphedItems(1);
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "Adopt WAL", evidence: [ev] },
    });
    const r = acceptCapture(deps, OWNER, id);
    expect(r).toEqual({ id, state: "accepted", nativeRef: `capture:${id}` });
    const row = deps.store.get(id);
    expect(row?.itemId).toBe(`nimbus:${id}`);
    expect(embedded).toEqual([`nimbus:${id}`]);
    const d = db
      .query("SELECT extraction_source, capture_id FROM decision_record WHERE id = ?")
      .get(`capture:${id}`);
    expect(d).toEqual({ extraction_source: "agent", capture_id: id });
    const accepts = auditRows().filter((a) => a.action_type === "capture.accept");
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.hitl_status).toBe("not_required");
    expect(JSON.parse(accepts[0]?.action_json ?? "{}")).toMatchObject({
      captureId: id,
      outcome: "accepted",
    });
  });

  test("Review Focus 4: a second accept refuses ERR_CAPTURE_STATE and writes nothing more", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "term",
      payload: { term: "WAL", definition: "log" },
    });
    acceptCapture(deps, OWNER, id);
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_STATE");
    expect(auditRows().filter((a) => a.action_type === "capture.accept")).toHaveLength(1);
  });

  test("a lost race inside the transaction rolls the native write back", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s" },
    });
    class LosingStore extends CaptureStore {
      override markAccepted(): boolean {
        return false;
      }
    }
    const losing = { ...deps, store: new LosingStore(db) };
    expect(codeOf(() => acceptCapture(losing, OWNER, id))).toBe("ERR_CAPTURE_STATE");
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM item WHERE service = 'nimbus'").get()).toEqual({
      n: 0,
    });
    expect(deps.store.get(id)?.state).toBe("proposed");
  });

  test("Review Focus 5: an evidence item deleted since submit refuses; the capture stays proposed", async () => {
    const [ev] = graphedItems(1);
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s", evidence: [ev] },
    });
    deleteItemByPrimaryKey(db, String(ev));
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
    expect(deps.store.get(id)?.state).toBe("proposed");
  });

  function seedManualWal(): void {
    upsertManualTerm(db, {
      termKey: "wal",
      displayTerm: "WAL",
      definition: "the owner's own",
      synonyms: [],
      nearMisses: [],
      stats: computeTermStats(db, "wal"),
      score: 0,
      nowMs: 1,
    });
  }

  test("term over a manual row refuses ERR_CAPTURE_SUPERSEDED and stays proposed", async () => {
    seedManualWal();
    const { id } = await submitCapture(deps, MCP, {
      kind: "term",
      payload: { term: "WAL", definition: "log" },
    });
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_SUPERSEDED");
    expect(deps.store.get(id)?.state).toBe("proposed");
    expect(auditRows().filter((a) => a.action_type === "capture.accept")).toHaveLength(0);
    expect(getTerm(db, "wal")?.definition).toBe("the owner's own");
  });

  test("a zero-width character cannot disguise a key the owner already authored", async () => {
    seedManualWal();
    const { id } = await submitCapture(deps, MCP, {
      kind: "term",
      payload: { term: `W${ZWSP}AL`, definition: "log" },
    });
    const stored = deps.store.get(id);
    expect(stored?.payloadJson).not.toContain(ZWSP);
    expect(JSON.parse(stored?.payloadJson ?? "{}")).toMatchObject({ term: "WAL", termKey: "wal" });
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_SUPERSEDED");
    expect(getTerm(db, "wal")?.definition).toBe("the owner's own");
  });

  test("term over a MODEL-vetoed row accepts: the owner's accept outranks the classifier", async () => {
    upsertCandidate(db, {
      key: "wal",
      surface: "WAL",
      form: "phrase",
      stats: computeTermStats(db, "wal"),
      score: 1,
      nowMs: 1,
    });
    markVetoed(db, "wal", 2);
    expect(getTerm(db, "wal")?.status).toBe("vetoed"); // positive control
    const { id } = await submitCapture(deps, MCP, {
      kind: "term",
      payload: { term: "WAL", definition: "log" },
    });
    expect(acceptCapture(deps, OWNER, id)).toMatchObject({ state: "accepted" });
    expect(getTerm(db, "wal")).toMatchObject({
      status: "consolidated",
      definitionSource: "agent",
      definition: "log",
    });
    expect(revokeCapture(deps, OWNER, id).state).toBe("revoked");
    expect(getTerm(db, "wal")).toBeNull();
  });

  test("link whose endpoint left the graph refuses ERR_CAPTURE_LINK_UNRESOLVED and stays proposed", async () => {
    const [a, b] = graphedItems(2);
    const { id } = await submitCapture(deps, MCP, {
      kind: "link",
      payload: { fromItemId: a, toItemId: b, relation: "fixes" },
    });
    deleteGraphEntitiesForItemKeys(db, [String(a)]);
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_LINK_UNRESOLVED");
    expect(deps.store.get(id)?.state).toBe("proposed");
  });

  test("a link accepts into a captured_* edge", async () => {
    const [a, b] = graphedItems(2);
    const { id } = await submitCapture(deps, MCP, {
      kind: "link",
      payload: { fromItemId: a, toItemId: b, relation: "fixes" },
    });
    expect(acceptCapture(deps, OWNER, id)).toMatchObject({ state: "accepted" });
    const n = db
      .query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'captured_fixes'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  test("an mcp client cannot accept; a disabled sink freezes accept but not reject", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s" },
    });
    expect(codeOf(() => acceptCapture(deps, MCP, id))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    cap = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: false } },
      OPEN,
    );
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_DISABLED");
    expect(rejectCapture(deps, OWNER, id).state).toBe("rejected");
  });

  test("unknown id, bad id and a live note all refuse", async () => {
    expect(codeOf(() => acceptCapture(deps, OWNER, "cap_404"))).toBe("ERR_CAPTURE_NOT_FOUND");
    expect(codeOf(() => acceptCapture(deps, OWNER, 7))).toBe("ERR_CAPTURE_INVALID");
    const { id } = await submitCapture(deps, MCP, { kind: "note", payload: { body: "b" } });
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_STATE");
  });

  test("a proposed row with no payload (CHECK forbids it on disk) refuses ERR_CAPTURE_STATE", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s" },
    });
    class NoPayloadStore extends CaptureStore {
      override get(rowId: string) {
        const r = super.get(rowId);
        return r === undefined ? r : { ...r, payloadJson: null };
      }
    }
    const broken = { ...deps, store: new NoPayloadStore(db) };
    expect(codeOf(() => acceptCapture(broken, OWNER, id))).toBe("ERR_CAPTURE_STATE");
  });

  test("an audit append failure rolls the whole accept back", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s" },
    });
    db.run("DROP TABLE audit_log");
    expect(() => acceptCapture(deps, OWNER, id)).toThrow(/audit_log/);
    expect(deps.store.get(id)?.state).toBe("proposed");
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM item WHERE service = 'nimbus'").get()).toEqual({
      n: 0,
    });
    expect(embedded).toEqual([]);
  });
});

describe("reject", () => {
  test("proposed to rejected with decided_at, one rejected audit row, nothing native", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s" },
    });
    clock += 5;
    expect(rejectCapture(deps, OWNER, id)).toEqual({ id, state: "rejected" });
    expect(deps.store.get(id)?.decidedAt).toBe(clock);
    const rej = auditRows().filter((a) => a.action_type === "capture.reject");
    expect(rej.map((a) => a.hitl_status)).toEqual(["rejected"]);
    expect(JSON.parse(rej[0]?.action_json ?? "{}")).toMatchObject({ outcome: "rejected" });
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 0 });
  });

  test("reject prunes rejected rows decided more than 90 days ago", async () => {
    const a = (await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "a" } }))
      .id;
    rejectCapture(deps, OWNER, a);
    expect(deps.store.get(a)).toBeDefined();
    clock += REJECTED_RETENTION_MS + 1;
    const b = (await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "b" } }))
      .id;
    rejectCapture(deps, OWNER, b);
    expect(deps.store.get(a)).toBeUndefined();
    expect(deps.store.get(b)?.state).toBe("rejected");
  });

  test("rejecting a non-proposed capture refuses ERR_CAPTURE_STATE; mcp refuses FORBIDDEN", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s" },
    });
    expect(codeOf(() => rejectCapture(deps, MCP, id))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    rejectCapture(deps, OWNER, id);
    expect(codeOf(() => rejectCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_STATE");
    expect(codeOf(() => rejectCapture(deps, OWNER, "cap_404"))).toBe("ERR_CAPTURE_NOT_FOUND");
    expect(codeOf(() => rejectCapture(deps, OWNER, 3))).toBe("ERR_CAPTURE_INVALID");
    expect(auditRows().filter((a) => a.action_type === "capture.reject")).toHaveLength(1);
  });

  test("a lost race refuses ERR_CAPTURE_STATE and writes no audit row", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s" },
    });
    class LosingStore extends CaptureStore {
      override markRejected(): boolean {
        return false;
      }
    }
    const losing = { ...deps, store: new LosingStore(db) };
    expect(codeOf(() => rejectCapture(losing, OWNER, id))).toBe("ERR_CAPTURE_STATE");
    expect(auditRows().filter((a) => a.action_type === "capture.reject")).toHaveLength(0);
  });
});

describe("revoke — accepted captures", () => {
  test("an accepted decision: native row, evidence, item and payload go; native_ref stays", async () => {
    const [ev] = graphedItems(1);
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s", evidence: [ev] },
    });
    acceptCapture(deps, OWNER, id);
    const evidenceRows = (): unknown =>
      db
        .query("SELECT COUNT(*) AS n FROM decision_evidence WHERE decision_id = ?")
        .get(`capture:${id}`);
    expect(evidenceRows()).toEqual({ n: 1 }); // positive control: the accept wrote it
    expect(revokeCapture(deps, OWNER, id)).toEqual({ id, state: "revoked" });
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 0 });
    expect(evidenceRows()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM item WHERE id = ?").get(`nimbus:${id}`)).toEqual({
      n: 0,
    });
    const row = deps.store.get(id);
    expect(row?.payloadJson).toBeNull();
    expect(row?.nativeRef).toBe(`capture:${id}`);
    expect(JSON.parse(auditRows().at(-1)?.action_json ?? "{}")).toMatchObject({
      outcome: "revoked",
      nativeRef: `capture:${id}`,
    });
  });

  test("a newer accepted term takes the row over; revoking the older leaves it, and get() says superseded", async () => {
    const a = (
      await submitCapture(deps, MCP, {
        kind: "term",
        payload: { term: "WAL", definition: "old" },
      })
    ).id;
    acceptCapture(deps, OWNER, a);
    const b = (
      await submitCapture(deps, MCP, {
        kind: "term",
        payload: { term: "WAL", definition: "new" },
      })
    ).id;
    acceptCapture(deps, OWNER, b);
    expect(getCapture(deps, OWNER, a).nativeStatus).toBe("superseded");
    expect(getCapture(deps, OWNER, b).nativeStatus).toBe("owned");
    revokeCapture(deps, OWNER, a);
    expect(db.query("SELECT definition FROM glossary_term WHERE term_key = 'wal'").get()).toEqual({
      definition: "new",
    });
  });

  test("a link triple named by two accepted captures survives revoking one", async () => {
    const [x, y] = graphedItems(2);
    const p = { kind: "link", payload: { fromItemId: x, toItemId: y, relation: "fixes" } };
    const a = (await submitCapture(deps, MCP, p)).id;
    const b = (await submitCapture(deps, MCP, p)).id;
    acceptCapture(deps, OWNER, a);
    acceptCapture(deps, OWNER, b);
    revokeCapture(deps, OWNER, a);
    expect(getCapture(deps, OWNER, b).nativeStatus).toBe("owned");
    revokeCapture(deps, OWNER, b);
    expect(
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'captured_fixes'").get(),
    ).toEqual({ n: 0 });
  });

  test("revoking a note removes evidence rows citing it; the decision stays", async () => {
    const note = (await submitCapture(deps, MCP, { kind: "note", payload: { body: "context" } }))
      .id;
    const dec = (
      await submitCapture(deps, MCP, {
        kind: "decision",
        payload: { statement: "s", evidence: [`nimbus:${note}`] },
      })
    ).id;
    acceptCapture(deps, OWNER, dec);
    revokeCapture(deps, OWNER, note);
    expect(db.query("SELECT COUNT(*) AS n FROM decision_evidence").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 1 });
  });

  test("a proposed or rejected capture cannot be revoked; a revoked one is a no-op success", async () => {
    const { id } = await submitCapture(deps, MCP, {
      kind: "decision",
      payload: { statement: "s" },
    });
    expect(codeOf(() => revokeCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_STATE");
    acceptCapture(deps, OWNER, id);
    revokeCapture(deps, OWNER, id);
    expect(revokeCapture(deps, OWNER, id)).toEqual({ id, state: "revoked" });
  });

  test("nativeStatus is null for notes and non-accepted rows", async () => {
    const n = (await submitCapture(deps, MCP, { kind: "note", payload: { body: "b" } })).id;
    expect(getCapture(deps, OWNER, n).nativeStatus).toBeNull();
  });
});

describe("act door — submit (PR 3)", () => {
  const ACT = {
    kind: "action",
    payload: { actionType: "slack.message.post", input: { text: "hi" }, summary: "why" },
  };
  let verdict: "proposable" | "denied" | "unknown";
  let configured: boolean;
  beforeEach(() => {
    cap = onConfig({ kinds: ["note", "decision", "action"], actionMaxPending: 2 });
    verdict = "proposable";
    configured = true;
    deps = {
      ...deps,
      classifyAction: () =>
        verdict === "proposable"
          ? { kind: "proposable" }
          : verdict === "denied"
            ? { kind: "denied", class: "vcs" }
            : { kind: "unknown" },
      isServiceConfigured: () => Promise.resolve(configured),
      listProposableActionTypes: () => Promise.resolve(["slack.message.post"]),
    };
  });
  test("stores proposed with expires_at = now + ttl; audited with actionType; no item", async () => {
    const out = await submitCapture(deps, MCP, ACT);
    expect(out).toEqual({ id: "cap_1", state: "proposed", expiresAt: clock + 24 * 3_600_000 });
    expect(deps.store.get("cap_1")?.itemId).toBeNull();
    expect(JSON.parse(auditRows().at(-1)?.action_json ?? "{}")).toMatchObject({
      kind: "action",
      actionType: "slack.message.post",
    });
  });
  test("mcp_action locked: refused DISABLED, unaudited (step 1)", async () => {
    cap = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["action"] } },
      { capabilitiesDisabled: new Set(["mcp_action"]) },
    );
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_DISABLED");
    expect(auditRows()).toEqual([]);
  });
  test("5a not proposable / unknown: refused and audited", async () => {
    verdict = "denied";
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe(
      "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    );
    verdict = "unknown";
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe(
      "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    );
    expect(auditRows().filter((r) => r.hitl_status === "rejected")).toHaveLength(2);
  });
  test("deps absent: refused NOT_PROPOSABLE (fail-closed)", async () => {
    const { classifyAction: _c, ...rest } = deps;
    expect(await codeOfAsync(() => submitCapture(rest, MCP, ACT))).toBe(
      "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    );
  });
  test("5b unconfigured connector: refused and audited", async () => {
    configured = false;
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe(
      "ERR_CAPTURE_CONNECTOR_UNCONFIGURED",
    );
  });
  test("action and native pending caps are separate", async () => {
    await submitCapture(deps, MCP, ACT);
    await submitCapture(deps, MCP, ACT);
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_QUEUE_FULL");
    const d = await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    expect(d.state).toBe("proposed");
  });
  test("lazy expiry: listing after the TTL shows expired, with one expire audit row", async () => {
    await submitCapture(deps, MCP, ACT);
    clock += 24 * 3_600_000;
    expect(listCaptures(deps, OWNER, {}).captures[0]?.state).toBe("expired");
    expect(auditRows().filter((r) => r.action_type === "capture.action.expire")).toHaveLength(1);
  });
  test("reject works on a proposed action; revoke refuses on any action", async () => {
    await submitCapture(deps, MCP, ACT);
    expect(codeOf(() => revokeCapture(deps, OWNER, "cap_1"))).toBe("ERR_CAPTURE_STATE");
    expect(rejectCapture(deps, OWNER, "cap_1").state).toBe("rejected");
  });
  test("a mcp_action lock after submit freezes accept; reject still works (Review Focus 3)", async () => {
    await submitCapture(deps, MCP, ACT);
    cap = resolveCaptureCapability(
      {
        ok: true,
        config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
      },
      { capabilitiesDisabled: new Set(["mcp_action"]) },
    );
    const exec = { execute: () => Promise.resolve({ status: "ok" as const, result: {} }) };
    expect(
      await codeOfAsync(() => Promise.resolve(acceptCapture(deps, OWNER, "cap_1", exec))),
    ).toBe("ERR_CAPTURE_DISABLED");
    expect(deps.store.get("cap_1")?.state).toBe("proposed");
    expect(rejectCapture(deps, OWNER, "cap_1").state).toBe("rejected");
  });
  test("captureStateFor: mcp only, no payload, NOT_FOUND for unknown", async () => {
    await submitCapture(deps, MCP, ACT);
    expect(captureStateFor(deps, MCP, "cap_1")).toEqual({
      kind: "action",
      state: "proposed",
      expiresAt: clock + 24 * 3_600_000,
    });
    expect(codeOf(() => captureStateFor(deps, OWNER, "cap_1"))).toBe(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
    );
    expect(codeOf(() => captureStateFor(deps, MCP, "cap_9"))).toBe("ERR_CAPTURE_NOT_FOUND");
  });
  test("captureStatus reports the act-door fields", async () => {
    await submitCapture(deps, MCP, ACT);
    expect(await captureStatus(deps)).toMatchObject({
      actionEnabled: true,
      proposableActionTypes: ["slack.message.post"],
      actionPending: 1,
      actionMaxPending: 2,
      actionTtlHours: 24,
      actionExpiringWithinHour: 0,
      pending: 0,
    });
  });
});
