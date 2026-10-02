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
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAgentsRpc } from "../ipc/agents-rpc.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { createOncallPushRunner, type PushDispatch } from "./push-runner.ts";
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

test("a real agents.oncall brief is stored, synthesis is NOT attempted even under allow-remote", async () => {
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
  // allow-remote is configured on purpose: the runner must still never build a synthesis runner.
  writeFileSync(
    join(configDir, "nimbus.toml"),
    `[user]\nme_person_id = "${me.id}"\n\n[agents]\nsynthesis = "allow-remote"\n`,
  );

  const synthesisSeen: unknown[] = [];
  const spyDispatch: PushDispatch = async (m, p, c) => {
    const out = await dispatchAgentsRpc(m, p, {
      ...c,
      notify: (method, params) => {
        if (method === "oncall.briefReady")
          synthesisSeen.push((params as { synthesis?: unknown }).synthesis);
        c.notify(method, params);
      },
    });
    if (out.kind === "miss") throw new Error("miss");
    return out.value;
  };
  const store = new PushStore(db);
  store.reconcileEnabledState(true, now - 1000);
  const runner = createOncallPushRunner({
    db,
    store,
    config: { ...DEFAULT_ONCALL_PUSH_CONFIG, enabled: true },
    pagerdutyAliases: [],
    configDir,
    index: new LocalIndex(db),
    resolveSelf: async () => me.id,
    deliver: async () => {},
    dispatch: spyDispatch,
  });

  expect(await runner.run("pagerduty")).toMatchObject({ selected: 1, ok: 1, failed: 0 });
  const row = store.get("pagerduty:PINT");
  expect(row?.briefMarkdown).toContain("## Gaps");
  expect(synthesisSeen).toEqual([{ attempted: false, reason: "disabled" }]);
});
