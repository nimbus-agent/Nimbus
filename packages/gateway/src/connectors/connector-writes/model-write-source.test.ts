import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dbRun } from "../../db/write.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { removeModelWriteEnablement, setModelWriteEnablement } from "./enablement-store.ts";
import { CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY } from "./model-write-capability.ts";
import { createModelWriteToolSource, type ModelWriteSourceDeps } from "./model-write-source.ts";
import { row, withPreview } from "./types.ts";

// SYNTHETIC templated rows: no real wave-2/3 row has a template yet, so a test over the real
// table could not show the approved-set filter doing anything.
const T = { target: "{name}", summary: "s", fields: [] };
const SYNC = withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 2), T);
const ROLLBACK = withPreview(row("argocd_app_rollback", "argocd.app.rollback", "write", 3), T);
const BARE = row("argocd_app_delete", "argocd.app.delete", "write", 2); // no template: not offerable
const WAVE4 = withPreview(row("argocd_app_prune", "argocd.app.prune", "write", 4), T);
const REFRESH = withPreview(row("tableau_refresh", "tableau.refresh", "write", 2), T);
const ROWS = [SYNC, ROLLBACK, BARE, WAVE4, REFRESH];
/** Every argocd tool id: approving all of them isolates the wave/offerability checks. */
const ALL_ARGOCD = [SYNC, ROLLBACK, BARE, WAVE4].map((r) => r.toolId);

const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;
const LOCKED = {
  capabilitiesDisabled: new Set<string>([CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY]),
} as unknown as EnforcedPolicy;

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 84);
});
afterEach(() => db.close());

function source(enforcedPolicy: ModelWriteSourceDeps["enforcedPolicy"]) {
  return createModelWriteToolSource({
    db,
    enforcedPolicy,
    listServerTools: async () => undefined,
    toolsEpoch: () => 0,
    warn: () => {},
    rows: ROWS,
  });
}

const ids = (rs: readonly { toolId: string }[]) => rs.map((r) => r.toolId);

describe("createModelWriteToolSource", () => {
  test("offers only offerable rows of enabled services, at or below each service's wave", () => {
    setModelWriteEnablement(db, "argocd", 2, 1, ALL_ARGOCD);
    expect(ids(source(() => ALLOWED).offerableEnabledRows())).toEqual(["argocd_app_sync"]);
    setModelWriteEnablement(db, "argocd", 4, 2, ALL_ARGOCD);
    // Wave 4 (no `before`) and the template-less row stay out; tableau is not enabled.
    expect(ids(source(() => ALLOWED).offerableEnabledRows())).toEqual([
      "argocd_app_sync",
      "argocd_app_rollback",
    ]);
  });

  test("an offerable row the owner did not approve by name is not offered", () => {
    setModelWriteEnablement(db, "argocd", 3, 1, ["argocd_app_sync"]);
    expect(ids(source(() => ALLOWED).offerableEnabledRows())).toEqual(["argocd_app_sync"]);
  });

  test("a pre-V84 opt-in (empty approved set) offers nothing until re-enabled", () => {
    const pre = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(pre, 83);
      dbRun(
        pre,
        "INSERT INTO connector_write_enablement (service, max_wave, enabled_at) VALUES ('argocd', 3, 1)",
      );
      runIndexedSchemaMigrations(pre, 84);
      const src = createModelWriteToolSource({
        db: pre,
        enforcedPolicy: () => ALLOWED,
        listServerTools: async () => undefined,
        toolsEpoch: () => 0,
        warn: () => {},
        rows: ROWS,
      });
      expect(src.offerableEnabledRows()).toEqual([]);
      expect(src.recheck(SYNC)).toBe(false);
      // Re-enabling with the rows the prompt listed offers them.
      setModelWriteEnablement(pre, "argocd", 3, 2, ["argocd_app_sync", "argocd_app_rollback"]);
      expect(ids(src.offerableEnabledRows())).toEqual(["argocd_app_sync", "argocd_app_rollback"]);
    } finally {
      pre.close();
    }
  });

  test("policy locked, no accessor, an undefined policy or a throwing accessor: nothing offered (control: allowed)", () => {
    setModelWriteEnablement(db, "argocd", 3, 1, ALL_ARGOCD);
    expect(source(() => ALLOWED).offerableEnabledRows()).toHaveLength(2);
    expect(source(() => LOCKED).offerableEnabledRows()).toEqual([]);
    expect(source(undefined).offerableEnabledRows()).toEqual([]);
    expect(source(() => undefined).offerableEnabledRows()).toEqual([]);
    expect(
      source(() => {
        throw new Error("policy unreadable");
      }).offerableEnabledRows(),
    ).toEqual([]);
  });

  test("recheck reads enablement, wave and policy live", () => {
    setModelWriteEnablement(db, "argocd", 3, 1, ALL_ARGOCD);
    let policy = ALLOWED;
    const src = source(() => policy);
    expect(src.recheck(ROLLBACK)).toBe(true);
    expect(src.recheck(BARE)).toBe(false);
    expect(src.recheck(WAVE4)).toBe(false);
    expect(src.recheck(REFRESH)).toBe(false); // tableau not enabled
    setModelWriteEnablement(db, "argocd", 2, 2, ALL_ARGOCD);
    expect(src.recheck(ROLLBACK)).toBe(false); // wave lowered below the row's
    expect(src.recheck(SYNC)).toBe(true);
    policy = LOCKED;
    expect(src.recheck(SYNC)).toBe(false);
    policy = ALLOWED;
    expect(src.recheck(SYNC)).toBe(true);
    removeModelWriteEnablement(db, "argocd");
    expect(src.recheck(SYNC)).toBe(false);
  });

  test("recheck at call time: a row listed while approved is refused once the approved set drops it", () => {
    setModelWriteEnablement(db, "argocd", 3, 1, ["argocd_app_sync", "argocd_app_rollback"]);
    const src = source(() => ALLOWED);
    expect(ids(src.offerableEnabledRows())).toContain("argocd_app_rollback");
    expect(src.recheck(ROLLBACK)).toBe(true);
    // Same wave, same service: only the approved set changes between listing and call.
    setModelWriteEnablement(db, "argocd", 3, 2, ["argocd_app_sync"]);
    expect(src.recheck(ROLLBACK)).toBe(false);
    expect(src.recheck(SYNC)).toBe(true);
  });
});

describe("createModelWriteToolSource: the destination refusals (F3/F4)", () => {
  const POST = withPreview(row("slack_message_post", "slack.message.post", "mesh", 2), {
    target: "{channel}",
    summary: "Post",
    fields: [],
  });
  const APPEND = withPreview(row("notion_block_append", "notion.block.append", "mesh", 2), {
    target: "{parentBlockId}",
    summary: "Append",
    fields: [],
  });
  const withChatops = {
    capabilitiesDisabled: new Set<string>(),
    chatops: {
      channels: new Map([["C0123ABCD", { namespace: "ns", unmapped: "refuse", notify: [] }]]),
      ownership: new Map(),
    },
  } as unknown as EnforcedPolicy;

  function refusingSource(
    enforcedPolicy: ModelWriteSourceDeps["enforcedPolicy"],
    getTribalKbConfig?: ModelWriteSourceDeps["getTribalKbConfig"],
  ) {
    return createModelWriteToolSource({
      db,
      enforcedPolicy,
      listServerTools: async () => undefined,
      toolsEpoch: () => 0,
      warn: () => {},
      rows: [POST, APPEND],
      ...(getTribalKbConfig === undefined ? {} : { getTribalKbConfig }),
    });
  }

  test("the ChatOps bindings are read from the live enforced policy", () => {
    let policy = withChatops;
    const src = refusingSource(() => policy);
    expect(src.refusal?.(POST, { channel: "#c0123abcd", text: "x" })).toBe(
      "the model cannot post to a channel Nimbus ChatOps listens on",
    );
    expect(src.refusal?.(POST, { channel: "C9999ZZZZ", text: "x" })).toBeUndefined();
    // A policy whose ChatOps binds no channel: nothing to refuse.
    policy = {
      capabilitiesDisabled: new Set<string>(),
      chatops: { channels: new Map(), ownership: new Map() },
    } as unknown as EnforcedPolicy;
    expect(src.refusal?.(POST, { channel: "#c0123abcd", text: "x" })).toBeUndefined();
  });

  test("an unreadable or throwing policy refuses a ChatOps-platform post", () => {
    expect(refusingSource(() => undefined).refusal?.(POST, { channel: "C9999ZZZZ" })).toBe(
      "the model cannot post to a channel Nimbus ChatOps listens on",
    );
    expect(
      refusingSource(() => {
        throw new Error("x");
      }).refusal?.(POST, { channel: "C9999ZZZZ" }),
    ).toBe("the model cannot post to a channel Nimbus ChatOps listens on");
  });

  test("a throwing policy on a non-ChatOps row propagates (the door answers generically), not the ChatOps text", () => {
    const throwing = refusingSource(() => {
      throw new Error("x");
    });
    expect(() => throwing.refusal?.(APPEND, { parentBlockId: "x" })).toThrow("x");
  });

  test("the KB config is read per call; a throw propagates (the door refuses it)", () => {
    let kbId: string | undefined = "aaaa-bbbb";
    const src = refusingSource(
      () => ALLOWED,
      () => (kbId === undefined ? undefined : { notion: { databaseId: kbId } }),
    );
    expect(src.refusal?.(APPEND, { parentBlockId: "AAAABBBB" })).toBe(
      "the model cannot write to the Nimbus knowledge base; use the capture flow",
    );
    kbId = undefined;
    expect(src.refusal?.(APPEND, { parentBlockId: "AAAABBBB" })).toBeUndefined();
    const throwing = refusingSource(
      () => ALLOWED,
      () => {
        throw new Error("config");
      },
    );
    expect(() => throwing.refusal?.(APPEND, { parentBlockId: "x" })).toThrow();
  });
});
