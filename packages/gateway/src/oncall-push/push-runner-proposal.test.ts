// Phase 10 IC5b: a pushed brief carries its record's top remediation proposal (approve-from-push). The push stores
// the id and gateway-set labels only, adds a block naming the exact command, and approves nothing; a missing or
// failing listing leaves the push exactly as it was.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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
import { pushedProposalOf } from "../ipc/oncall-push-rpc.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { parseHeadlineBrief } from "./push-headline.ts";
import {
  createOncallPushRunner,
  type PushDelivery,
  type PushedProposal,
  proposalSection,
} from "./push-runner.ts";
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

function setup(over: { topProposal?: (recordId: string) => PushedProposal | null } = {}): {
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
    dependsOn: () => depends,
    ...(over.topProposal === undefined ? {} : { topProposal: over.topProposal }),
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

const PROPOSAL = (recordId: string): PushedProposal => ({
  recordId,
  id: "prp_0123456789abcdef",
  kind: "rollback_deploy",
  toolId: "argocd_app_rollback",
  reversibility: "reversible",
  confidence: 75,
  expiresAtMs: T0 + 2 * 60 * MIN,
});

describe("a push carries its record's top proposal", () => {
  test("the block names the label, the tool and the exact command; the JSON carries ids and labels only", async () => {
    const asked: string[] = [];
    const { runner } = setup({
      topProposal: (recordId) => {
        asked.push(recordId);
        return PROPOSAL(recordId);
      },
    });
    await runner.run("pagerduty");
    const row = store.get("pagerduty:PA");
    const recordId = getByTriggerItem(db, "pagerduty:PA")?.id ?? "";
    expect(asked).toEqual([recordId]);
    expect(row?.briefMarkdown).toContain("## Proposed remediation");
    expect(row?.briefMarkdown).toContain("[reversible] rollback_deploy: `argocd_app_rollback`");
    expect(row?.briefMarkdown).toContain("nimbus oncall pushed pagerduty:PA --remediate");
    expect(row?.briefMarkdown).toContain("this push approves nothing");
    const json = JSON.parse(row?.briefJson ?? "{}") as { proposal: Record<string, unknown> };
    expect(json.proposal).toEqual({ ...PROPOSAL(recordId) });
    expect(pushedProposalOf(row?.briefJson ?? null)).toMatchObject({
      recordId,
      proposalId: "prp_0123456789abcdef",
    });
    // The headline parser still reads what it read.
    expect(parseHeadlineBrief(row?.briefJson ?? null)).not.toBeNull();
  });

  test("an irreversible proposal says so first", () => {
    const text = proposalSection("pagerduty:PA", {
      ...PROPOSAL("inc_0000000000000000"),
      reversibility: "irreversible",
    });
    expect(text.split("\n")[2]).toStartWith("[IRREVERSIBLE]");
  });

  test("no proposal, a null one or a throwing listing: no block, a null proposal, the push still ok", async () => {
    for (const topProposal of [
      undefined,
      () => null,
      () => {
        throw new Error("listing failed");
      },
    ]) {
      db.run("DELETE FROM pushed_brief");
      const { runner } = setup(topProposal === undefined ? {} : { topProposal });
      const summary = await runner.run("pagerduty");
      expect(summary.ok).toBe(1);
      const row = store.get("pagerduty:PA");
      expect(row?.status).toBe("ok");
      expect(row?.briefMarkdown).not.toContain("## Proposed remediation");
      expect((JSON.parse(row?.briefJson ?? "{}") as { proposal: unknown }).proposal).toBeNull();
    }
  });
});

describe("pushedProposalOf re-validates what it reads", () => {
  const good = { ...PROPOSAL("inc_0123456789abcdef") };
  test.each([
    ["no JSON", null],
    ["unparseable", "{"],
    ["no proposal", "{}"],
    ["a malformed id", JSON.stringify({ proposal: { ...good, id: "prp_x" } })],
    ["a foreign record id", JSON.stringify({ proposal: { ...good, recordId: "pagerduty:PA" } })],
    ["a label with text", JSON.stringify({ proposal: { ...good, kind: "roll back`; rm" } })],
    ["an unknown label", JSON.stringify({ proposal: { ...good, reversibility: "maybe" } })],
    ["a bad confidence", JSON.stringify({ proposal: { ...good, confidence: "high" } })],
    ["a bad expiry", JSON.stringify({ proposal: { ...good, expiresAtMs: 1.5 } })],
    ["an array", JSON.stringify({ proposal: [] })],
  ])("%s is no proposal", (_why, json) => {
    expect(pushedProposalOf(json)).toBeNull();
  });
  test("a null confidence is allowed", () => {
    expect(
      pushedProposalOf(JSON.stringify({ proposal: { ...good, confidence: null } }))?.confidence,
    ).toBeNull();
  });
});
