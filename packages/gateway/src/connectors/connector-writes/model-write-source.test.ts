import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { removeModelWriteEnablement, setModelWriteEnablement } from "./enablement-store.ts";
import { CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY } from "./model-write-capability.ts";
import { createModelWriteToolSource, type ModelWriteSourceDeps } from "./model-write-source.ts";
import { row, withPreview } from "./types.ts";

const T = { target: "{name}", summary: "s", fields: [] };
const SYNC = withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 2), T);
const ROLLBACK = withPreview(row("argocd_app_rollback", "argocd.app.rollback", "write", 3), T);
const BARE = row("argocd_app_delete", "argocd.app.delete", "write", 2); // no template: not offerable
const WAVE4 = withPreview(row("argocd_app_prune", "argocd.app.prune", "write", 4), T);
const REFRESH = withPreview(row("tableau_refresh", "tableau.refresh", "write", 2), T);
const ROWS = [SYNC, ROLLBACK, BARE, WAVE4, REFRESH];

const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;
const LOCKED = {
  capabilitiesDisabled: new Set<string>([CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY]),
} as unknown as EnforcedPolicy;

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 83);
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
    setModelWriteEnablement(db, "argocd", 2, 1);
    expect(ids(source(() => ALLOWED).offerableEnabledRows())).toEqual(["argocd_app_sync"]);
    setModelWriteEnablement(db, "argocd", 4, 2);
    // Wave 4 (no `before`) and the template-less row stay out; tableau is not enabled.
    expect(ids(source(() => ALLOWED).offerableEnabledRows())).toEqual([
      "argocd_app_sync",
      "argocd_app_rollback",
    ]);
  });

  test("policy locked, no accessor, an undefined policy or a throwing accessor: nothing offered (control: allowed)", () => {
    setModelWriteEnablement(db, "argocd", 3, 1);
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
    setModelWriteEnablement(db, "argocd", 3, 1);
    let policy = ALLOWED;
    const src = source(() => policy);
    expect(src.recheck(ROLLBACK)).toBe(true);
    expect(src.recheck(BARE)).toBe(false);
    expect(src.recheck(WAVE4)).toBe(false);
    expect(src.recheck(REFRESH)).toBe(false); // tableau not enabled
    setModelWriteEnablement(db, "argocd", 2, 2);
    expect(src.recheck(ROLLBACK)).toBe(false); // wave lowered below the row's
    expect(src.recheck(SYNC)).toBe(true);
    policy = LOCKED;
    expect(src.recheck(SYNC)).toBe(false);
    policy = ALLOWED;
    expect(src.recheck(SYNC)).toBe(true);
    removeModelWriteEnablement(db, "argocd");
    expect(src.recheck(SYNC)).toBe(false);
  });
});
