import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { engineForConfigDir } from "../incident/__fixtures__/test-engine.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { createOncallPushRunner } from "./push-runner.ts";
import { PushStore } from "./push-store.ts";

let db: Database;
let configDir: string;
beforeEach(() => {
  db = createMemoryIndexDb();
  configDir = mkdtempSync(join(tmpdir(), "oncall-push-int-"));
});
afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
});

test("a real incident record is stored as the brief; no synthesis is attempted even under allow-remote", async () => {
  const now = Date.now();
  const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }), "pagerduty");
  syncPagerdutyIncidentItems(
    ctx,
    [
      {
        id: "PINT",
        status: "triggered",
        title: "checkout: 5xx",
        priority: { name: "P1" },
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        service: { id: "PSVC" },
        assignments: [{ assignee: { id: "U1", type: "user", email: "me@acme.example" } }],
      },
    ],
    new Date(now - 86_400_000).toISOString(),
    now,
    new Map(),
  );
  const me = findPersonByCanonicalEmail(db, "me@acme.example");
  if (me === null) throw new Error("fixture: no person");
  // allow-remote is configured on purpose: the record's render has no runner, so no model is reachable.
  writeFileSync(
    join(configDir, "nimbus.toml"),
    `[user]\nme_person_id = "${me.id}"\n\n[agents]\nsynthesis = "allow-remote"\n`,
  );

  const store = new PushStore(db);
  store.reconcileEnabledState(true, now - 1000);
  const runner = createOncallPushRunner({
    db,
    store,
    config: DEFAULT_ONCALL_PUSH_CONFIG,
    isEnabled: () => true,
    pagerdutyAliases: [],
    resolveSelf: async () => me.id,
    deliver: async () => {},
    records: engineForConfigDir(db, configDir),
    serviceConfig: () => undefined,
  });

  expect(await runner.run("pagerduty")).toMatchObject({ selected: 1, ok: 1, failed: 0 });
  const row = store.get("pagerduty:PINT");
  expect(row?.briefMarkdown).toContain("# Incident");
  expect(row?.briefMarkdown).toContain("## Gaps");
  expect(row?.briefMarkdown).toContain("Rendered deterministically");
  expect(row?.sessionId).toMatch(/^incident:inc_[0-9a-f]{16}:v1$/);
});
