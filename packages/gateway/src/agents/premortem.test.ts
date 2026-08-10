import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { itemPrimaryKey } from "../index/item-key.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { seedEpicWithServices } from "../premortem/cohort.test-helpers.ts";
import { upsertTheme } from "../premortem/theme-store.ts";
import { emitPremortemBrief, type PremortemContext, runPremortem } from "./premortem.ts";

const DAY_MS = 86_400_000;
const NOW = Date.now();

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function ctx(db: Database): PremortemContext {
  return { db, notify: () => {}, sessionId: "s1" };
}

/** A target-epic-only seed: an epic item with NO children in the index at all. */
function seedChildlessEpic(db: Database, key: string, createdAtMs: number): void {
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: key,
    title: `${key} title`,
    metadata: { issue_type: "Epic", status_category: "in_progress", created_at_ms: createdAtMs },
    modifiedAt: createdAtMs,
    syncedAt: createdAtMs,
  });
}

/**
 * A PR item carrying `opened_at_ms`/`merged_at` timing metadata, resolving a
 * jira child of `epicKey` — the same shape `seedEpicWithServices` builds,
 * but with the timing fields review-drag's query reads.
 */
function seedChildWithTimedPr(
  db: Database,
  opts: {
    epicKey: string;
    childSuffix: string;
    service: string;
    openedAtMs: number;
    mergedAtMs: number;
  },
): void {
  const childExternalId = `${opts.epicKey}-${opts.childSuffix}`;
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: childExternalId,
    title: childExternalId,
    metadata: { parent_key: opts.epicKey },
    modifiedAt: opts.mergedAtMs,
    syncedAt: opts.mergedAtMs,
  });
  const childItemId = itemPrimaryKey("jira", childExternalId);
  const issueEnt = upsertGraphEntity(db, {
    type: "issue",
    externalId: childItemId,
    label: childItemId,
    service: "github",
    metadata: null,
  });

  const prExternalId = `pr:${opts.epicKey}:${opts.childSuffix}`;
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: prExternalId,
    title: prExternalId,
    metadata: {
      repo: opts.service,
      opened_at_ms: opts.openedAtMs,
      merged_at: opts.mergedAtMs,
    },
    modifiedAt: opts.mergedAtMs,
    syncedAt: opts.mergedAtMs,
  });
  const prItemId = itemPrimaryKey("github", prExternalId);
  const prEnt = upsertGraphEntity(db, {
    type: "pr",
    externalId: prItemId,
    label: prItemId,
    service: "github",
    metadata: { repo: opts.service },
  });
  upsertGraphRelation(db, prEnt, issueEnt, "resolves", opts.mergedAtMs);
}

function seedDeploymentCorrelatedWithIncident(
  db: Database,
  opts: { service: string; occurredAtMs: number; idSuffix: string },
): void {
  const depEnt = upsertGraphEntity(db, {
    type: "deployment",
    externalId: `deploy:${opts.idSuffix}`,
    label: `deploy ${opts.idSuffix}`,
    service: "github-actions",
    metadata: { occurredAt: opts.occurredAtMs, affectedService: opts.service },
  });
  const incEnt = upsertGraphEntity(db, {
    type: "incident",
    externalId: `incident:${opts.idSuffix}`,
    label: `incident ${opts.idSuffix}`,
    service: "pagerduty",
    metadata: { occurredAt: opts.occurredAtMs + 1_000, affectedService: opts.service },
  });
  upsertGraphRelation(db, depEnt, incEnt, "correlates_with", opts.occurredAtMs);
}

describe("runPremortem", () => {
  test("a resolved epic with a comparable cohort produces all four lanes", async () => {
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "PROJ-120",
      services: ["acme/billing-api"],
      resolvedAtMs: NOW - 10 * DAY_MS,
      createdAtMs: NOW - 20 * DAY_MS,
    });
    for (let i = 0; i < 3; i++) {
      seedEpicWithServices(db, {
        key: `HIST-${String(i)}`,
        services: ["acme/billing-api"],
        resolvedAtMs: NOW - (30 + i) * DAY_MS,
        createdAtMs: NOW - (60 + i) * DAY_MS,
      });
    }
    upsertTheme(db, {
      service: "acme/billing-api",
      label: "rate limit exhaustion",
      nowMs: NOW,
      evidence: [{ itemId: "jira:HIST-0", evidenceKey: "jira:HIST-0", label: "HIST-0" }],
    });

    const brief = await runPremortem({ epicRef: "PROJ-120" }, ctx(db));

    expect(brief.kind).toBe("premortem");
    expect(brief.epic?.key).toBe("PROJ-120");
    expect(brief.services).toEqual(["acme/billing-api"]);
    expect(brief.cohort.members.length).toBeGreaterThan(0);
    expect(brief.risks).toHaveLength(5);
    expect(brief.themes.length).toBeGreaterThan(0);
    expect(brief.watchers).toHaveLength(1);
    expect(brief.watchers[0]?.state).toBe("created");
    expect(brief.watchers[0]?.service).toBe("acme/billing-api");
  });

  test("no children and no --service names the company-managed cause", async () => {
    const db = makeDb();
    seedChildlessEpic(db, "PROJ-1", NOW - 2 * DAY_MS);

    const brief = await runPremortem({ epicRef: "PROJ-1" }, ctx(db));

    expect(brief.epic?.key).toBe("PROJ-1");
    expect(brief.services).toEqual([]);
    expect(brief.cohort.members).toEqual([]);
    expect(brief.risks).toEqual([]);
    expect(
      brief.gaps.some(
        (g) => g.detail.includes("company-managed") && g.detail.includes("parent_key"),
      ),
    ).toBe(true);
  });

  test("a Linear ref names the Linear cause without touching the database", async () => {
    const db = makeDb();

    const brief = await runPremortem({ epicRef: "linear:ABC-120" }, ctx(db));

    expect(brief.epic).toBeNull();
    expect(brief.services).toEqual([]);
    expect(
      brief.gaps.some((g) => g.detail.includes("Linear") && g.detail.includes("Jira epics only")),
    ).toBe(true);
  });

  test("services known but no comparable epics closed yields a named gap, never a fallback cohort", async () => {
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "PROJ-300",
      services: ["acme/lonely-service"],
      resolvedAtMs: NOW - 5 * DAY_MS,
      createdAtMs: NOW - 15 * DAY_MS,
    });
    // An epic in the SAME "project" prefix but touching a DIFFERENT service —
    // present to prove the empty-cohort path does not fall back to "other
    // epics in this project" once services are known but unmatched.
    seedEpicWithServices(db, {
      key: "PROJ-301",
      services: ["acme/unrelated"],
      resolvedAtMs: NOW - 40 * DAY_MS,
    });

    const brief = await runPremortem({ epicRef: "PROJ-300" }, ctx(db));

    expect(brief.services).toEqual(["acme/lonely-service"]);
    expect(brief.cohort.members).toEqual([]);
    expect(brief.risks).toEqual([]);
    expect(
      brief.gaps.some(
        (g) =>
          g.detail.includes("No past epics touching") && g.detail.includes("acme/lonely-service"),
      ),
    ).toBe(true);
  });

  test("a themes-absent brief still carries all five structural risks", async () => {
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "PROJ-400",
      services: ["acme/payments"],
      resolvedAtMs: NOW - 5 * DAY_MS,
      createdAtMs: NOW - 15 * DAY_MS,
    });
    seedEpicWithServices(db, {
      key: "HIST-400",
      services: ["acme/payments"],
      resolvedAtMs: NOW - 40 * DAY_MS,
      createdAtMs: NOW - 70 * DAY_MS,
    });
    // No `upsertTheme` call at all.

    const brief = await runPremortem({ epicRef: "PROJ-400" }, ctx(db));

    expect(brief.risks).toHaveLength(5);
    expect(brief.themes).toEqual([]);
    expect(
      brief.gaps.some((g) => g.detail.includes("theme") && g.detail.includes("not have run")),
    ).toBe(true);
  });

  test("the unconditional correlation note is present in every brief shape", async () => {
    const db = makeDb();
    seedChildlessEpic(db, "PROJ-500", NOW - 2 * DAY_MS);
    seedEpicWithServices(db, {
      key: "PROJ-501",
      services: ["acme/checkout"],
      resolvedAtMs: NOW - 5 * DAY_MS,
      createdAtMs: NOW - 15 * DAY_MS,
    });
    seedEpicWithServices(db, {
      key: "HIST-501",
      services: ["acme/checkout"],
      resolvedAtMs: NOW - 40 * DAY_MS,
      createdAtMs: NOW - 70 * DAY_MS,
    });

    const linearBrief = await runPremortem({ epicRef: "linear:X-1" }, ctx(db));
    const noChildrenBrief = await runPremortem({ epicRef: "PROJ-500" }, ctx(db));
    const fullBrief = await runPremortem({ epicRef: "PROJ-501" }, ctx(db));

    const note = "are correlations, not causes";
    for (const brief of [linearBrief, noChildrenBrief, fullBrief]) {
      expect(brief.gaps.some((g) => g.detail.includes(note))).toBe(true);
    }
  });

  test("--service overrides derivation entirely, not merges with it", async () => {
    const db = makeDb();
    // Derivation would normally yield ["acme/other-service"].
    seedEpicWithServices(db, {
      key: "PROJ-200",
      services: ["acme/other-service"],
      resolvedAtMs: NOW - 5 * DAY_MS,
      createdAtMs: NOW - 15 * DAY_MS,
    });
    seedEpicWithServices(db, {
      key: "HIST-200",
      services: ["acme/billing-api"],
      resolvedAtMs: NOW - 40 * DAY_MS,
      createdAtMs: NOW - 70 * DAY_MS,
    });

    const brief = await runPremortem(
      { epicRef: "PROJ-200", serviceOverrides: ["acme/billing-api"] },
      ctx(db),
    );

    expect(brief.services).toEqual(["acme/billing-api"]);
    expect(brief.query.serviceOverrides).toEqual(["acme/billing-api"]);
    // The override cohort ran off the overridden service, not the derived one.
    expect(brief.cohort.members.some((m) => m.key === "HIST-200")).toBe(true);
  });

  test("review drag computes a real median once PR timing metadata is present", async () => {
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "PROJ-600",
      services: ["acme/search"],
      resolvedAtMs: NOW - 5 * DAY_MS,
      createdAtMs: NOW - 15 * DAY_MS,
    });
    seedChildlessEpic(db, "HIST-600", NOW - 50 * DAY_MS);
    // Turn HIST-600 into a real closed Epic candidate sharing the service via
    // a timed PR (review-drag's own join, not `seedEpicWithServices`'s).
    // `resolved_at_ms` must be no later than the PR's `mergedAtMs` below: it
    // seeds `cohort.oldestResolvedAtMs`, which is the LOWER bound of the
    // repo-wide baseline window `repoPrDurations` reads.
    db.run(
      `UPDATE item SET metadata = json_set(metadata, '$.status_category', 'done', '$.resolved_at_ms', ?)
        WHERE service = 'jira' AND external_id = 'HIST-600'`,
      [NOW - 49 * DAY_MS],
    );
    seedChildWithTimedPr(db, {
      epicKey: "HIST-600",
      childSuffix: "c1",
      service: "acme/search",
      openedAtMs: NOW - 48 * DAY_MS,
      mergedAtMs: NOW - 46 * DAY_MS,
    });
    // A second, repo-wide-only PR — not linked to any epic's children, so it
    // affects ONLY `repoReviewMedianMs`, not the cohort median. Its longer
    // (4 day) duration pulls the repo baseline away from the cohort's 2-day
    // duration, giving a non-zero delta that could only come from the real
    // join+median math, not a stub that echoes one value into both fields.
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "pr:unrelated:1",
      title: "unrelated PR",
      metadata: {
        repo: "acme/search",
        opened_at_ms: NOW - 44 * DAY_MS,
        merged_at: NOW - 40 * DAY_MS,
      },
      modifiedAt: NOW - 40 * DAY_MS,
      syncedAt: NOW - 40 * DAY_MS,
    });

    const brief = await runPremortem({ epicRef: "PROJ-600" }, ctx(db));

    expect(brief.cohort.members.some((m) => m.key === "HIST-600")).toBe(true);
    const reviewDrag = brief.risks.find((r) => r.kind === "review_drag");
    // reviewDragMedianMs (cohort, 2d) - repoReviewMedianMs (median of 2d & 4d = 3d) = -1d.
    expect(reviewDrag?.value).toBe(-1 * DAY_MS);
    expect(reviewDrag?.summary).toContain("48 hours");
    expect(reviewDrag?.summary).toContain("72 hours");
  });

  test("incident coupling counts a deploy-incident correlation inside an epic's window", async () => {
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "PROJ-700",
      services: ["acme/orders"],
      resolvedAtMs: NOW - 5 * DAY_MS,
      createdAtMs: NOW - 15 * DAY_MS,
    });
    const histResolvedAtMs = NOW - 40 * DAY_MS;
    const histCreatedAtMs = NOW - 70 * DAY_MS;
    seedEpicWithServices(db, {
      key: "HIST-700",
      services: ["acme/orders"],
      resolvedAtMs: histResolvedAtMs,
      createdAtMs: histCreatedAtMs,
    });
    seedDeploymentCorrelatedWithIncident(db, {
      service: "acme/orders",
      occurredAtMs: histCreatedAtMs + 5 * DAY_MS,
      idSuffix: "d1",
    });

    const brief = await runPremortem({ epicRef: "PROJ-700" }, ctx(db));

    const incidentCoupling = brief.risks.find((r) => r.kind === "incident_coupling");
    expect(incidentCoupling?.value).toBe(1);
    expect(incidentCoupling?.summary).toContain("1 of 1");
  });

  test("an unresolvable Jira ref throws rather than returning a partial brief", async () => {
    const db = makeDb();
    await expect(runPremortem({ epicRef: "PROJ-9999" }, ctx(db))).rejects.toThrow(/not found/);
  });

  test("emitPremortemBrief notifies premortem.briefReady with markdown and typed findings", async () => {
    const db = makeDb();
    seedChildlessEpic(db, "PROJ-800", NOW - 2 * DAY_MS);
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { sessionId } = await emitPremortemBrief(
      { epicRef: "PROJ-800" },
      { db, notify: (method, params) => notifications.push({ method, params }), sessionId: "s2" },
    );
    expect(sessionId).toBe("s2");
    // The build runs fire-and-forget inside `emitBriefWithSynthesis`; give the microtask queue
    // a turn so the notification lands before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.method).toBe("premortem.briefReady");
    const params = notifications[0]?.params as {
      sessionId: string;
      brief: string;
      findings: unknown;
    };
    expect(params.sessionId).toBe("s2");
    expect(typeof params.brief).toBe("string");
    expect((params.findings as { kind: string }).kind).toBe("premortem");
  });
});
