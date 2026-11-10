/** Branch gaps of `capture-gate.ts`: list filters, titles of every kind, state view, status when off. */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import {
  type CaptureGateDeps,
  captureStateFor,
  captureStatus,
  getCapture,
  listCaptures,
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

function insert(
  id: string,
  kind: "note" | "decision" | "term" | "link" | "action",
  payload: unknown,
  extra: Partial<Parameters<CaptureStore["insert"]>[0]> = {},
): void {
  deps.store.insert({
    id,
    kind,
    state: "proposed",
    itemId: null,
    payloadJson: JSON.stringify(payload),
    payloadBytes: 10,
    clientLabel: null,
    sessionId: "c-mcp",
    createdAt: clock,
    expiresAt: null,
    ...extra,
  });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected CaptureError");
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  clock = 1_000_000;
  cap = resolveCaptureCapability(
    { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
    OPEN,
  );
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () => cap,
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => "cap_x",
    now: () => clock,
    actionDestinationRefusal: () => undefined,
  };
});
afterEach(() => db.close());

describe("listCaptures", () => {
  test("params that are not an object are refused", () => {
    expect(code(() => listCaptures(deps, OWNER, "nope"))).toBe("ERR_CAPTURE_INVALID");
    expect(code(() => listCaptures(deps, OWNER, [1]))).toBe("ERR_CAPTURE_INVALID");
    expect(code(() => listCaptures(deps, OWNER, null))).toBe("ERR_CAPTURE_INVALID");
  });

  test("undefined params list with defaults", () => {
    expect(listCaptures(deps, OWNER, undefined).captures).toEqual([]);
  });

  test("kind, state and order filters apply; bad values are refused", () => {
    insert("cap_a", "decision", { statement: "first" }, { createdAt: 1 });
    insert("cap_b", "term", { term: "second" }, { createdAt: 2 });
    insert("cap_c", "decision", { statement: "third" }, { createdAt: 3 });
    const asc = listCaptures(deps, OWNER, { kind: "decision", order: "asc" });
    expect(asc.captures.map((c) => c.id)).toEqual(["cap_a", "cap_c"]);
    const desc = listCaptures(deps, OWNER, { kind: "decision", state: "proposed", order: "desc" });
    expect(desc.captures.map((c) => c.id)).toEqual(["cap_c", "cap_a"]);
    expect(desc.captures[0]?.title).toBe("third");
    expect(listCaptures(deps, OWNER, { kind: "term" }).captures[0]?.title).toBe("second");
    expect(listCaptures(deps, OWNER, { state: "live" }).captures).toEqual([]);
    expect(code(() => listCaptures(deps, OWNER, { state: "weird" }))).toBe("ERR_CAPTURE_INVALID");
    expect(code(() => listCaptures(deps, OWNER, { kind: "weird" }))).toBe("ERR_CAPTURE_INVALID");
    expect(code(() => listCaptures(deps, OWNER, { order: "sideways" }))).toBe(
      "ERR_CAPTURE_INVALID",
    );
    expect(code(() => listCaptures(deps, OWNER, { limit: 0 }))).toBe("ERR_CAPTURE_INVALID");
    expect(code(() => listCaptures(deps, OWNER, { limit: 1.5 }))).toBe("ERR_CAPTURE_INVALID");
    expect(code(() => listCaptures(deps, OWNER, { limit: "5" }))).toBe("ERR_CAPTURE_INVALID");
    expect(code(() => listCaptures(deps, OWNER, { limit: 201 }))).toBe("ERR_CAPTURE_INVALID");
    expect(listCaptures(deps, OWNER, { limit: 1 }).captures).toHaveLength(1);
  });

  test("titles: action, link with and without strings, and a payload with no title field", () => {
    insert(
      "cap_act",
      "action",
      { actionType: "slack.message.post", summary: "tell them" },
      { expiresAt: clock + 100 },
    );
    insert("cap_lnk", "link", { fromItemId: "x", toItemId: "y", relation: "fixes" });
    insert("cap_lnk2", "link", {});
    insert("cap_nt", "decision", { body: "no title" });
    insert("cap_num", "decision", { statement: 5 });
    const byId = new Map(listCaptures(deps, OWNER, {}).captures.map((c) => [c.id, c.title]));
    expect(byId.get("cap_act")).toBe("slack.message.post: tell them");
    expect(byId.get("cap_lnk")).toBe("fixes: x → y");
    expect(byId.get("cap_lnk2")).toBe("link:  → ");
    expect(byId.get("cap_nt")).toBe("");
    expect(byId.get("cap_num")).toBe("");
  });
});

describe("getCapture / captureStateFor", () => {
  test("getCapture refuses an unknown id", () => {
    expect(code(() => getCapture(deps, OWNER, "cap_missing"))).toBe("ERR_CAPTURE_NOT_FOUND");
  });

  test("captureStateFor carries expiry, outcome and error code when set, and refuses the owner", () => {
    insert("cap_e", "action", { actionType: "a.b", summary: "s" }, { expiresAt: clock + 5 });
    expect(captureStateFor(deps, MCP, "cap_e")).toEqual({
      kind: "action",
      state: "proposed",
      expiresAt: clock + 5,
    });
    db.run("UPDATE capture SET state = 'executed', outcome_ref = 'ref1' WHERE id = 'cap_e'");
    expect(captureStateFor(deps, MCP, "cap_e")).toMatchObject({ outcomeRef: "ref1" });
    insert("cap_f", "action", { actionType: "a.b", summary: "s" }, { expiresAt: clock + 5 });
    db.run("UPDATE capture SET state = 'failed', error_code = 'ERR_X' WHERE id = 'cap_f'");
    expect(captureStateFor(deps, MCP, "cap_f")).toMatchObject({ errorCode: "ERR_X" });
    expect(code(() => captureStateFor(deps, OWNER, "cap_e"))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(code(() => captureStateFor(deps, MCP, "cap_nope"))).toBe("ERR_CAPTURE_NOT_FOUND");
  });
});

describe("captureStatus", () => {
  test("a disabled sink reports no kinds and a reason", async () => {
    cap = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    const s = await captureStatus(deps);
    expect(s.enabled).toBe(false);
    expect(s.kinds).toEqual([]);
    expect(typeof s.disabledReason).toBe("string");
  });

  test("with the action kind on, advertises the injected proposable types (capped at 200)", async () => {
    cap = resolveCaptureCapability(
      {
        ok: true,
        config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
      },
      OPEN,
    );
    const many = Array.from({ length: 250 }, (_, i) => `t.${String(i)}`);
    const s = await captureStatus({
      ...deps,
      listProposableActionTypes: () => Promise.resolve(many),
    });
    expect(s.actionEnabled).toBe(true);
    expect(s.proposableActionTypes).toHaveLength(200);
    const none = await captureStatus(deps);
    expect(none.proposableActionTypes).toEqual([]);
  });
});
