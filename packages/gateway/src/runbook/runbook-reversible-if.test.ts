// A runbook's step listing never labels a conditionally reversible row (the Unleash toggle) plain
// "reversible": it carries `reversibleIf`, the condition, and an unconditional row (the Split kill) none.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import { upsertIncidentRecord } from "../incident/incident-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createRunbooks } from "./runbook-run.ts";

const FLAGS = `
name = "flags"
[match]
services = ["payments"]

[[steps]]
kind = "action"
tool = "unleash_feature_toggle"
params = { projectId = "web", featureName = "f", environment = "production", enabled = false }

[[steps]]
kind = "action"
tool = "split_kill"
params = { workspaceId = "ws", splitName = "s", environment = "production" }
`;

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-rb-cond-"));
  mkdirSync(join(dir, "runbooks"));
  writeFileSync(join(dir, "runbooks", "flags.toml"), FLAGS);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the runbook listing of a conditionally reversible step", () => {
  test("the Unleash toggle carries its condition; the Split kill does not", () => {
    const up = upsertIncidentRecord(db, {
      record: buildRecord({ boundService: "payments", openedAtMs: 1 }),
      markdown: "m",
      recordSha256: "h",
      citedServices: [],
      nowMs: 1,
    });
    const svc = createRunbooks({
      db,
      makeExecutor: () => {
        throw new Error("a listing builds no executor");
      },
      configDir: () => dir,
      bindingsFor: () => undefined,
    });
    const out = svc.list(up.recordId);
    expect(out.errors).toEqual([]);
    const steps = out.runbooks[0]?.steps ?? [];
    expect(steps[0]).toMatchObject({
      tool: "unleash_feature_toggle",
      wave: 3,
      reversibility: "reversible",
      reversibleIf: "the environment already has an active strategy",
    });
    expect(steps[1]).toMatchObject({ tool: "split_kill", reversibility: "reversible" });
    expect(steps[1]).not.toHaveProperty("reversibleIf");
  });
});
