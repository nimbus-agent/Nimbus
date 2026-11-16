import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { evaluateWatchersAfterSync } from "../automation/watcher-engine.ts";
import { deleteWatcher, listWatchers, setWatcherEnabled } from "../automation/watcher-store.ts";
import { annotateDeployment } from "../deployment/annotate.ts";
import { graphAnnotatedDeployment } from "../deployment/graph-annotated.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ServiceIdentityResolver } from "../metrics/service-identity.ts";
import { clearProposalTombstones, proposeWatchers } from "./watcher-proposals.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/**
 * The repo → config-id translation a real `[ci.service.billing]` block performs
 * (`agents/premortem.ts`'s `makeConfigServiceIdResolver`). The config id is
 * DELIBERATELY not the repo path: a same-string map would pass whether or not
 * the translation happened at all.
 */
const resolveConfigServiceId = (repo: string): string | null =>
  repo === "acme/billing-api" ? "billing" : null;

const INPUT = {
  epicItemId: "jira:PROJ-120",
  services: ["acme/billing-api"],
  nowMs: 1_700_000_000_000,
  resolveConfigServiceId,
};

describe("proposeWatchers", () => {
  test("creates a paused incident_opened and a paused deploy_failed watcher per service, scoped by CONFIG id", () => {
    const db = makeDb();
    const out = proposeWatchers(db, INPUT);
    expect(out.proposals.map((p) => [p.riskKind, p.state])).toEqual([
      ["incident_coupling", "created"],
      ["deploy_failure", "created"],
    ]);
    expect(out.unmappedServices).toEqual([]);
    const all = listWatchers(db);
    expect(all.map((w) => w.condition_type).sort()).toEqual(["deploy_failed", "incident_opened"]);
    expect(all.every((w) => w.enabled === 0)).toBe(true);
    const deploy = all.find((w) => w.condition_type === "deploy_failed");
    expect(JSON.parse(deploy?.condition_json ?? "{}")).toEqual({
      filter: { affectedService: "billing" },
    });
    const w = all.find((x) => x.condition_type === "incident_opened");
    expect(w?.enabled).toBe(0);
    expect(w?.condition_type).toBe("incident_opened");
    // `affectedService`, NOT `service`: the engine matches `filter.service` against the
    // `item.service` COLUMN, which is always the connector id (`pagerduty`) for an incident, so
    // a repo path there produced a watcher that could never fire once armed.
    expect(JSON.parse(w?.condition_json ?? "{}")).toEqual({
      filter: { affectedService: "billing" },
    });
  });

  test("a service that resolves to no config id gets NO watcher and NO row — it is reported", () => {
    const db = makeDb();
    const out = proposeWatchers(db, {
      ...INPUT,
      services: ["acme/billing-api", "acme/unmapped"],
    });
    expect(out.proposals.map((p) => p.service)).toEqual(["acme/billing-api", "acme/billing-api"]);
    expect(out.unmappedServices).toEqual(["acme/unmapped"]);
    expect(listWatchers(db)).toHaveLength(2);
    // Not even a tombstone: nothing was proposed, so there is nothing to record as deleted.
    expect(
      db.query(`SELECT COUNT(*) AS n FROM premortem_watcher_proposal`).get() as { n: number },
    ).toEqual({ n: 2 });
  });

  test("never falls back to the repo path when nothing resolves", () => {
    const db = makeDb();
    const out = proposeWatchers(db, { ...INPUT, resolveConfigServiceId: () => null });
    expect(out.proposals).toEqual([]);
    expect(out.unmappedServices).toEqual(["acme/billing-api"]);
    expect(listWatchers(db)).toHaveLength(0);
  });

  test("rule 1 — a re-run creates nothing the second time", () => {
    const db = makeDb();
    proposeWatchers(db, INPUT);
    const second = proposeWatchers(db, INPUT);
    expect(listWatchers(db)).toHaveLength(2);
    expect(second.proposals.map((p) => p.state)).toEqual(["already_present", "already_present"]);
  });

  test("rule 2 — an armed watcher survives a re-run UN-PAUSED", () => {
    const db = makeDb();
    const id = proposeWatchers(db, INPUT).proposals[0]?.watcherId as string;
    setWatcherEnabled(db, id, true);
    proposeWatchers(db, INPUT);
    const rows = listWatchers(db);
    expect(rows.find((w) => w.id === id)?.enabled).toBe(1);
    expect(rows.filter((w) => w.id !== id).every((w) => w.enabled === 0)).toBe(true);
  });

  test("rule 3 — a deleted watcher stays deleted and is reported suppressed", () => {
    const db = makeDb();
    const id = proposeWatchers(db, INPUT).proposals[0]?.watcherId as string;
    deleteWatcher(db, id);
    const again = proposeWatchers(db, INPUT);
    // Only the deleted incident watcher stays gone; the deploy-failure one is a separate proposal.
    expect(listWatchers(db).map((w) => w.condition_type)).toEqual(["deploy_failed"]);
    expect(again.proposals.map((p) => [p.riskKind, p.state])).toEqual([
      ["incident_coupling", "suppressed"],
      ["deploy_failure", "already_present"],
    ]);
  });

  test("the watcher id is keyed on the REPO, so a config-id rename cannot un-suppress it", () => {
    const db = makeDb();
    const id = proposeWatchers(db, INPUT).proposals[0]?.watcherId as string;
    deleteWatcher(db, id);
    const renamed = proposeWatchers(db, {
      ...INPUT,
      resolveConfigServiceId: (repo) => (repo === "acme/billing-api" ? "billing-v2" : null),
    });
    expect(renamed.proposals[0]?.watcherId).toBe(id);
    expect(renamed.proposals[0]?.state).toBe("suppressed");
    expect(listWatchers(db).map((w) => w.condition_type)).toEqual(["deploy_failed"]);
  });

  test("deleting the deploy-failure watcher suppresses only it, and --repropose-style clearing restores it", () => {
    const db = makeDb();
    const first = proposeWatchers(db, INPUT);
    const deployId = first.proposals.find((p) => p.riskKind === "deploy_failure")?.watcherId;
    expect(deployId).toBeDefined();
    expect(deployId).not.toBe(first.proposals[0]?.watcherId);
    deleteWatcher(db, deployId as string);
    const again = proposeWatchers(db, INPUT);
    expect(again.proposals.map((p) => [p.riskKind, p.state])).toEqual([
      ["incident_coupling", "already_present"],
      ["deploy_failure", "suppressed"],
    ]);
    clearProposalTombstones(db, INPUT.epicItemId);
    const restored = proposeWatchers(db, INPUT);
    expect(restored.proposals.find((p) => p.riskKind === "deploy_failure")?.state).toBe("created");
  });
});

/**
 * The end-to-end chain the proposal only has value because of: propose -> arm ->
 * a real triggered incident whose graph entity names the matching affected
 * service -> the watcher engine fires. Written against the PRODUCTION write path
 * (`upsertIndexedItem` with a resolver, which runs `graph-populator.ts`), never a
 * hand-seeded graph entity: a hand-seeded entity would keep passing even if the
 * populator stopped writing `affectedService`.
 */
describe("proposeWatchers — the armed proposal actually fires", () => {
  /** One `[ci.service.billing]` block: it claims BOTH the repo and the PagerDuty service. */
  const resolver: ServiceIdentityResolver = (item) => {
    if (item.metadata["repo"] === "acme/billing-api") {
      return { kind: "bound", serviceId: "billing" };
    }
    if (item.metadata["pagerduty_service_id"] === "PBILLING") {
      return { kind: "bound", serviceId: "billing" };
    }
    return { kind: "unknown" };
  };

  function seedTriggeredIncident(db: Database, pagerdutyServiceId: string, atMs: number): void {
    upsertIndexedItem(
      db,
      {
        service: "pagerduty",
        type: "incident",
        externalId: `INC-${pagerdutyServiceId}`,
        title: "Billing API 500s",
        metadata: { status: "triggered", pagerduty_service_id: pagerdutyServiceId },
        modifiedAt: atMs,
        syncedAt: atMs,
      },
      resolver,
    );
  }

  function armedProposalDb(): { db: Database; nowMs: number } {
    const db = makeDb();
    const nowMs = 1_700_000_000_000;
    const id = proposeWatchers(db, { ...INPUT, nowMs }).proposals[0]?.watcherId as string;
    expect(setWatcherEnabled(db, id, true)).toBe(true);
    return { db, nowMs };
  }

  test("FIRES on an incident whose graph entity names the proposed affected service", () => {
    const { db, nowMs } = armedProposalDb();
    seedTriggeredIncident(db, "PBILLING", nowMs + 1_000);

    const fired: string[] = [];
    evaluateWatchersAfterSync(db, "pagerduty", nowMs + 2_000, (_title, body) => {
      fired.push(body);
    });

    expect(fired).toHaveLength(1);
    expect(fired[0]).toContain("Billing API 500s");
  });

  test("does NOT fire on an incident whose affected service is a DIFFERENT configured service", () => {
    const { db, nowMs } = armedProposalDb();
    upsertIndexedItem(
      db,
      {
        service: "pagerduty",
        type: "incident",
        externalId: "INC-OTHER",
        title: "Payments API 500s",
        metadata: { status: "triggered", pagerduty_service_id: "PPAYMENTS" },
        modifiedAt: nowMs + 1_000,
        syncedAt: nowMs + 1_000,
      },
      (item) =>
        item.metadata["pagerduty_service_id"] === "PPAYMENTS"
          ? { kind: "bound", serviceId: "payments" }
          : { kind: "unknown" },
    );

    const fired: string[] = [];
    evaluateWatchersAfterSync(db, "pagerduty", nowMs + 2_000, (_title, body) => {
      fired.push(body);
    });

    expect(fired).toEqual([]);
  });

  test("does NOT fire on an incident with no resolvable affected service at all", () => {
    const { db, nowMs } = armedProposalDb();
    seedTriggeredIncident(db, "PUNKNOWN", nowMs + 1_000);

    const fired: string[] = [];
    evaluateWatchersAfterSync(db, "pagerduty", nowMs + 2_000, (_title, body) => {
      fired.push(body);
    });

    expect(fired).toEqual([]);
  });

  test("still does NOT fire on a RESOLVED incident of the matching service", () => {
    // The `incident_opened` narrowing is independent of the new filter and must survive it.
    const { db, nowMs } = armedProposalDb();
    upsertIndexedItem(
      db,
      {
        service: "pagerduty",
        type: "incident",
        externalId: "INC-RESOLVED",
        title: "Billing API 500s (resolved)",
        metadata: { status: "resolved", pagerduty_service_id: "PBILLING" },
        modifiedAt: nowMs + 1_000,
        syncedAt: nowMs + 1_000,
      },
      resolver,
    );

    const fired: string[] = [];
    evaluateWatchersAfterSync(db, "pagerduty", nowMs + 2_000, (_title, body) => {
      fired.push(body);
    });

    expect(fired).toEqual([]);
  });
});

/**
 * The deploy-failure proposal's reason to exist: a CI-annotated failed deploy reaches the graph at
 * annotation time, so the armed watcher fires with NO `nimbus index regraph`. Written against the
 * production annotation path (`annotateDeployment` then `graphAnnotatedDeployment`, what the HTTP
 * route and the RPC run), never a hand-seeded graph entity.
 */
describe("proposeWatchers — the armed deploy-failure proposal fires on an annotated deploy", () => {
  const cfgResolver: ServiceIdentityResolver = (item) =>
    item.metadata["nimbus_service_id"] === "billing"
      ? { kind: "bound", serviceId: "billing" }
      : { kind: "unknown" };

  function annotated(db: Database, service: string, status: "failure" | "success", atMs: number) {
    const r = annotateDeployment(
      db,
      {
        service,
        provider: "github-actions",
        environment: "prod",
        sha: "abcdef1234567",
        ref: "main",
        status,
        started_at_ms: atMs,
        run_id: `run-${service}-${status}`,
      },
      atMs,
    );
    graphAnnotatedDeployment(db, `deployment:${r.external_id}`, cfgResolver);
  }

  function armedDeployWatcherDb(): { db: Database; nowMs: number } {
    const db = makeDb();
    const nowMs = Date.now();
    const out = proposeWatchers(db, { ...INPUT, nowMs });
    const id = out.proposals.find((p) => p.riskKind === "deploy_failure")?.watcherId as string;
    expect(setWatcherEnabled(db, id, true)).toBe(true);
    return { db, nowMs };
  }

  function fireCount(db: Database, nowMs: number): number {
    const fired: string[] = [];
    evaluateWatchersAfterSync(db, "github-actions", nowMs + 2_000, (_t, body) => {
      fired.push(body);
    });
    return fired.length;
  }

  test("FIRES on a failed annotated deploy of the proposed service, with no regraph", () => {
    const { db, nowMs } = armedDeployWatcherDb();
    annotated(db, "billing", "failure", nowMs + 1_000);
    expect(fireCount(db, nowMs)).toBe(1);
  });

  test("does NOT fire on a successful deploy, or on a failed deploy of another service", () => {
    const { db, nowMs } = armedDeployWatcherDb();
    annotated(db, "billing", "success", nowMs + 1_000);
    annotated(db, "payments", "failure", nowMs + 1_500);
    expect(fireCount(db, nowMs)).toBe(0);
  });
});

describe("clearProposalTombstones", () => {
  test("clearing THIS epic's tombstone lets a suppressed proposal be created fresh", () => {
    const db = makeDb();
    const id = proposeWatchers(db, INPUT).proposals[0]?.watcherId as string;
    deleteWatcher(db, id);
    expect(proposeWatchers(db, INPUT).proposals[0]?.state).toBe("suppressed");

    const cleared = clearProposalTombstones(db, INPUT.epicItemId);
    expect(cleared).toBeGreaterThan(0);

    const reproposed = proposeWatchers(db, INPUT);
    expect(reproposed.proposals[0]?.state).toBe("created");
    expect(reproposed.proposals[0]?.watcherId).toBe(id);
    expect(listWatchers(db)).toHaveLength(2);
    // Re-created paused, never auto-armed on repropose.
    expect(listWatchers(db).every((w) => w.enabled === 0)).toBe(true);
  });

  test("is scoped to ONE epic — a sibling epic's tombstone survives untouched", () => {
    const db = makeDb();
    const otherInput = { ...INPUT, epicItemId: "jira:OTHER-1" };
    const id = proposeWatchers(db, INPUT).proposals[0]?.watcherId as string;
    const otherId = proposeWatchers(db, otherInput).proposals[0]?.watcherId as string;
    deleteWatcher(db, id);
    deleteWatcher(db, otherId);
    expect(proposeWatchers(db, INPUT).proposals[0]?.state).toBe("suppressed");
    expect(proposeWatchers(db, otherInput).proposals[0]?.state).toBe("suppressed");

    clearProposalTombstones(db, INPUT.epicItemId);

    expect(proposeWatchers(db, INPUT).proposals[0]?.state).toBe("created");
    // The OTHER epic's tombstone was never touched — still suppressed.
    expect(proposeWatchers(db, otherInput).proposals[0]?.state).toBe("suppressed");
  });

  test("clearing an epic with no tombstones returns 0 and is a harmless no-op", () => {
    const db = makeDb();
    expect(clearProposalTombstones(db, "jira:NEVER-PROPOSED")).toBe(0);
  });
});
