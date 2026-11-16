// Phase 10 IC4 task 9: the pushed brief carries the cascade of its record as of the push, appended to the
// PUSHED copy only; the stored record is untouched, a record pushed before its siblings exist is never pushed
// again (owner ruling OR-IC4-1), and the declared `depends_on` is read fresh on every brief.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { configMap, resolverFor, serviceConfig } from "../incident/__fixtures__/index-writers.ts";
import { createIncidentEngine } from "../incident/incident-engine.ts";
import { getByTriggerItem } from "../incident/incident-store.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { parseHeadlineBrief } from "./push-headline.ts";
import { createOncallPushRunner, type PushDelivery } from "./push-runner.ts";
import { PushStore } from "./push-store.ts";

const ME = "me@acme.example";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const MIN = 60_000;
const api = serviceConfig({
  serviceId: "api",
  pagerdutyServices: ["PSVC_API"],
  jsmAlertTags: [],
  sentryProjects: [],
  dataModels: [],
});
const dbSvc = serviceConfig({
  serviceId: "db",
  pagerdutyServices: ["PSVC_DB"],
  jsmAlertTags: [],
  sentryProjects: [],
  dataModels: [],
});
const resolver = resolverFor(api, dbSvc);

let db: Database;
let store: PushStore;
let personId: string;
let depends: Map<string, readonly string[]>;

function seed(id: string, pdService: string, openedAtMs: number): void {
  syncPagerdutyIncidentItems(
    syncTestContext(
      db,
      createStubVault({ "pagerduty.api_token": "tok" }),
      "pagerduty",
      "full",
      resolver,
    ),
    [
      {
        id,
        status: "triggered",
        title: `inc ${id}`,
        priority: { name: "P1" },
        created_at: new Date(openedAtMs).toISOString(),
        updated_at: new Date(openedAtMs).toISOString(),
        service: { id: pdService },
        assignments: [{ assignee: { id: "U1", type: "user", email: ME } }],
      },
    ],
    new Date(T0 - 86_400_000).toISOString(),
    openedAtMs,
    new Map(),
  );
}

function setup(over: { dependsOn?: () => ReadonlyMap<string, readonly string[]> } = {}): {
  runner: ReturnType<typeof createOncallPushRunner>;
  delivered: PushDelivery[];
  /** Assembles the given trigger items (as the engine's own pass does after a sync). */
  assemble: (...itemIds: string[]) => Promise<void>;
} {
  const delivered: PushDelivery[] = [];
  const engine = createIncidentEngine({
    db,
    now: () => T0 + 30 * MIN,
    emit: () => {},
    loadServiceConfigs: () => configMap(api, dbSvc),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
  const runner = createOncallPushRunner({
    db,
    store,
    config: DEFAULT_ONCALL_PUSH_CONFIG,
    isEnabled: () => true,
    pagerdutyAliases: [],
    resolveSelf: async () => personId,
    deliver: async (items) => {
      delivered.push(...items);
    },
    records: engine,
    serviceConfig: () => undefined,
    dependsOn: over.dependsOn ?? (() => depends),
    now: () => T0 + 30 * MIN,
  });
  return {
    runner,
    delivered,
    assemble: async (...itemIds) => {
      for (const id of itemIds) await engine.assembleNow(id);
    },
  };
}

beforeEach(() => {
  db = createMemoryIndexDb();
  store = new PushStore(db);
  store.reconcileEnabledState(true, T0 - 60_000);
  depends = new Map([
    ["api", ["db"]],
    ["db", []],
  ]);
  seed("PA", "PSVC_API", T0);
  const me = findPersonByCanonicalEmail(db, ME);
  if (me === null) throw new Error("fixture: no person");
  personId = me.id;
});
afterEach(() => db.close());

describe("9.3 a record in a cluster of two or more gets the block; a record alone does not", () => {
  test("alone: no Cascade block and a null cascade in the compatibility JSON", async () => {
    const { runner } = setup();
    await runner.run("pagerduty");
    const row = store.get("pagerduty:PA");
    expect(row?.briefMarkdown).not.toContain("## Cascade");
    expect((JSON.parse(row?.briefJson ?? "{}") as { cascade: unknown }).cascade).toBeNull();
  });

  test("a record pushed AFTER its sibling was assembled sees it: its Cascade block names the root", async () => {
    seed("PB", "PSVC_DB", T0 + 5 * MIN);
    const { runner, delivered, assemble } = setup();
    await assemble("pagerduty:PA", "pagerduty:PB");
    await runner.run("pagerduty");
    expect(delivered).toHaveLength(2);
    const rootId = getByTriggerItem(db, "pagerduty:PB")?.id;
    for (const id of ["pagerduty:PA", "pagerduty:PB"]) {
      const row = store.get(id);
      expect(row?.briefMarkdown).toContain("## Cascade");
      expect(
        (JSON.parse(row?.briefJson ?? "{}") as { cascade: { rootRecordId: string } }).cascade
          .rootRecordId,
      ).toBe(rootId ?? "");
    }
  });

  test("the root's brief says it is the root and the other's says it is downstream", async () => {
    seed("PB", "PSVC_DB", T0 + 5 * MIN);
    const { runner, assemble } = setup();
    await assemble("pagerduty:PA", "pagerduty:PB");
    await runner.run("pagerduty");
    const a = store.get("pagerduty:PA");
    const b = store.get("pagerduty:PB");
    expect(b?.briefMarkdown).toContain(
      "This record is the ranked root candidate of 2 open records",
    );
    expect(a?.briefMarkdown).toContain("This record is downstream of");
    expect(a?.briefMarkdown).toContain(
      "depends on the root through api -> db (declared depends_on)",
    );
    expect((JSON.parse(a?.briefJson ?? "{}") as { cascade: { role: string } }).cascade.role).toBe(
      "downstream",
    );
    expect((JSON.parse(b?.briefJson ?? "{}") as { cascade: { role: string } }).cascade.role).toBe(
      "root",
    );
  });
});

describe("9.4 the stored record is not changed by the push", () => {
  test("incident_record.markdown has no Cascade block and is byte-identical before and after the push", async () => {
    seed("PB", "PSVC_DB", T0 + 5 * MIN);
    const { runner, assemble } = setup();
    await assemble("pagerduty:PA", "pagerduty:PB");
    const before = getByTriggerItem(db, "pagerduty:PB")?.markdown;
    await runner.run("pagerduty");
    expect(getByTriggerItem(db, "pagerduty:PB")?.markdown).toBe(before);
    const stored = (id: string): string => getByTriggerItem(db, id)?.markdown ?? "";
    expect(stored("pagerduty:PA")).not.toContain("## Cascade");
    expect(stored("pagerduty:PB")).not.toContain("## Cascade");
    const pushed = store.get("pagerduty:PB")?.briefMarkdown ?? "";
    expect(pushed.startsWith(stored("pagerduty:PB"))).toBe(true);
    expect(pushed.length).toBeGreaterThan(stored("pagerduty:PB").length);
  });
});

describe("9.5 the compatibility JSON and a failed cascade read", () => {
  test("the headline parser still reads the fields it read", async () => {
    seed("PB", "PSVC_DB", T0 + 5 * MIN);
    const { runner, assemble } = setup();
    await assemble("pagerduty:PA", "pagerduty:PB");
    await runner.run("pagerduty");
    const parsed = parseHeadlineBrief(store.get("pagerduty:PB")?.briefJson ?? null);
    expect(parsed).not.toBeNull();
    expect(parsed?.nimbusServiceId).toBe("db");
  });

  test("a failing depends_on read degrades to the brief with a one-line gap, never a failed push", async () => {
    seed("PB", "PSVC_DB", T0 + 5 * MIN);
    const { runner, delivered } = setup({
      dependsOn: () => {
        throw new Error("config exploded");
      },
    });
    const summary = await runner.run("pagerduty");
    expect(summary).toMatchObject({ ok: 2, failed: 0 });
    expect(delivered).toHaveLength(2);
    const row = store.get("pagerduty:PB");
    expect(row?.status).toBe("ok");
    expect(row?.briefMarkdown).toContain("could not be ranked this time");
    expect(row?.briefMarkdown).not.toContain("config exploded");
    expect((JSON.parse(row?.briefJson ?? "{}") as { cascade: unknown }).cascade).toBeNull();
  });
});

describe("9.6 depends_on is read fresh; the runner imports no config loader", () => {
  test("an edit between two runs changes the next brief", async () => {
    seed("PB", "PSVC_DB", T0 + 5 * MIN);
    depends = new Map([
      ["api", []],
      ["db", []],
    ]);
    const first = setup();
    await first.assemble("pagerduty:PA", "pagerduty:PB");
    await first.runner.run("pagerduty");
    const noDeps = store.get("pagerduty:PB")?.briefMarkdown ?? "";
    expect(noDeps).toContain("no depends_on is declared among these services");
    // a third incident, after the edit, sees the declared dependency
    depends = new Map([
      ["api", ["db"]],
      ["db", []],
    ]);
    seed("PC", "PSVC_API", T0 + 8 * MIN);
    await first.assemble("pagerduty:PC");
    await first.runner.run("pagerduty");
    const withDeps = store.get("pagerduty:PC")?.briefMarkdown ?? "";
    expect(withDeps).toContain("depends on the root through api -> db");
  });

  test("push-runner.ts has no VALUE import of a config loader (its one config/ import is a type)", () => {
    const src = readFileSync(join(import.meta.dir, "push-runner.ts"), "utf8");
    const configImports = [
      ...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"\.\.\/config\/[^"]+";/gm),
    ];
    expect(configImports.length).toBeGreaterThan(0);
    for (const m of configImports) expect(m[1]).toBe("type ");
  });
});

describe("9.7 OR-IC4-1: a record pushed before its siblings exist is never pushed again", () => {
  test("a later record that becomes the root causes no second delivery for the first, and the first's brief is unchanged", async () => {
    const { runner, delivered } = setup();
    await runner.run("pagerduty");
    expect(delivered.map((d) => d.incident.id)).toEqual(["pagerduty:PA"]);
    const before = store.get("pagerduty:PA");
    expect(before?.briefMarkdown).not.toContain("## Cascade");

    // db alerts later and is now the cascade root of PA's cluster
    seed("PB", "PSVC_DB", T0 + 5 * MIN);
    await runner.run("pagerduty");
    expect(delivered.map((d) => d.incident.id)).toEqual(["pagerduty:PA", "pagerduty:PB"]);
    expect(store.get("pagerduty:PB")?.briefMarkdown).toContain(
      "ranked root candidate of 2 open records",
    );

    // PA's stored brief is exactly what it was, and a further run delivers nothing at all
    const after = store.get("pagerduty:PA");
    expect(after?.briefMarkdown).toBe(before?.briefMarkdown);
    expect(after?.briefJson).toBe(before?.briefJson);
    await runner.run("pagerduty");
    expect(delivered).toHaveLength(2);
  });
});
