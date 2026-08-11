import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { deleteWatcher } from "../automation/watcher-store.ts";
import {
  deterministicGraphEntityId,
  upsertGraphEntity,
  upsertGraphRelation,
} from "../graph/relationship-graph.ts";
import { itemPrimaryKey } from "../index/item-key.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ServiceIdentityResolver } from "../metrics/service-identity.ts";
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

/** A fake `[metrics.dora.<id>]` resolver: repo -> configured DORA service id. */
function fakeResolveServiceId(repoToServiceId: Record<string, string>): ServiceIdentityResolver {
  return (item) => {
    const repo = item.metadata["repo"];
    if (typeof repo === "string" && repo in repoToServiceId) {
      return { kind: "bound", serviceId: repoToServiceId[repo] as string };
    }
    return { kind: "unknown" };
  };
}

/**
 * A context whose repos DO map to configured deployment-service ids — required for a watcher to
 * be proposed at all, since a proposal is scoped by `filter.affectedService` and an unmapped repo
 * has no such id. The config ids are deliberately different strings from the repo paths.
 */
function ctxMapped(db: Database, repoToServiceId: Record<string, string>): PremortemContext {
  return { ...ctx(db), resolveServiceId: fakeResolveServiceId(repoToServiceId) };
}

const BILLING_MAP = { "acme/billing-api": "billing-svc-id" };

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
 * A PR item resolving a jira child of `epicKey` — the same shape
 * `seedEpicWithServices` builds, but backed by a REAL `item` row (never just
 * a graph-entity stub), so `cohortPrTimings`'s `JOIN item pr_item` can find
 * it. `openedAtMs`/`mergedAtMs` are optional: omitting them seeds a PR that
 * is genuinely linked but carries no timing metadata — the "PRs exist, no
 * connector recorded when they opened" shape, distinct from "no PRs at all".
 *
 * HONESTY NOTE for anyone reading a passing measured-review-drag test here:
 * `opened_at_ms` on a `pr` item is FIXTURE-ONLY today. No connector writes it —
 * `github-sync.ts` writes `merged_at` and nothing else timing-related, and the
 * only `opened_at_ms` writers in the tree are `pagerduty-sync.ts` (incidents)
 * and greenhouse (jobs). So the measured path these tests exercise is real code
 * that activates the day a connector starts recording the field, and reaches
 * zero real indexes until then. Every production brief takes the
 * cannot-be-measured branch; the docs say so in those words.
 */
function seedChildWithPr(
  db: Database,
  opts: {
    epicKey: string;
    childSuffix: string;
    service: string;
    openedAtMs?: number;
    mergedAtMs?: number;
  },
): void {
  const childExternalId = `${opts.epicKey}-${opts.childSuffix}`;
  const modifiedAt = opts.mergedAtMs ?? NOW;
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: childExternalId,
    title: childExternalId,
    metadata: { parent_key: opts.epicKey },
    modifiedAt,
    syncedAt: modifiedAt,
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
  const prMetadata: Record<string, unknown> = { repo: opts.service };
  if (opts.openedAtMs !== undefined) prMetadata["opened_at_ms"] = opts.openedAtMs;
  if (opts.mergedAtMs !== undefined) prMetadata["merged_at"] = opts.mergedAtMs;
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: prExternalId,
    title: prExternalId,
    metadata: prMetadata,
    modifiedAt,
    syncedAt: modifiedAt,
  });
  const prItemId = itemPrimaryKey("github", prExternalId);
  const prEnt = upsertGraphEntity(db, {
    type: "pr",
    externalId: prItemId,
    label: prItemId,
    service: "github",
    metadata: { repo: opts.service },
  });
  upsertGraphRelation(db, prEnt, issueEnt, "resolves", modifiedAt);
}

/**
 * The GitLab shape of `seedChildWithPr`: a merge-request ITEM carrying
 * `metadata.project` and NO `metadata.repo` (`connectors/_lib/gitlab/events.ts`
 * writes `{ iid, project, action }`, nothing else).
 *
 * The `pr` graph entity is left to the REAL populator, which runs inside
 * `upsertIndexedItem` and stores `repo: repoPathFromMetadata(metadata)` =
 * `repo ?? project`. That asymmetry — coalesced on the entity, not on the item
 * — is exactly what the queries under test have to account for, so hand-writing
 * the entity here would erase the thing being tested.
 */
function seedChildWithGitlabMr(
  db: Database,
  opts: {
    epicKey: string;
    childSuffix: string;
    project: string;
    openedAtMs?: number;
    mergedAtMs?: number;
  },
): void {
  const childExternalId = `${opts.epicKey}-${opts.childSuffix}`;
  const modifiedAt = opts.mergedAtMs ?? NOW;
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: childExternalId,
    title: childExternalId,
    metadata: { parent_key: opts.epicKey },
    modifiedAt,
    syncedAt: modifiedAt,
  });
  const childItemId = itemPrimaryKey("jira", childExternalId);

  const mrExternalId = `${opts.project}!${opts.childSuffix}`;
  const mrMetadata: Record<string, unknown> = { iid: 7, project: opts.project, action: "open" };
  if (opts.openedAtMs !== undefined) mrMetadata["opened_at_ms"] = opts.openedAtMs;
  if (opts.mergedAtMs !== undefined) mrMetadata["merged_at"] = opts.mergedAtMs;
  upsertIndexedItem(db, {
    service: "gitlab",
    type: "pr",
    externalId: mrExternalId,
    title: mrExternalId,
    metadata: mrMetadata,
    modifiedAt,
    syncedAt: modifiedAt,
  });
  const mrItemId = itemPrimaryKey("gitlab", mrExternalId);

  upsertGraphRelation(
    db,
    deterministicGraphEntityId("pr", mrItemId),
    deterministicGraphEntityId("issue", childItemId),
    "resolves",
    modifiedAt,
  );
}

/**
 * `service` here is the ALREADY-TRANSLATED DORA config id (e.g. `orders-svc`),
 * matching what `graph-populator.ts` actually writes into
 * `metadata.affectedService` in production — never a raw repo name.
 */
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

    const brief = await runPremortem({ epicRef: "PROJ-120" }, ctxMapped(db, BILLING_MAP));

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

  // `nimbus pre-mortem <ref> --repropose` (Task 5): `input.repropose` must reach
  // `clearProposalTombstones(ctx.db, epic.itemId)` BEFORE `proposeWatchers` runs, so a
  // deliberately-deleted watcher comes back `created` instead of staying `suppressed`.
  // `watcher-proposals.test.ts` already proves `clearProposalTombstones` itself works;
  // this proves `runPremortem` actually WIRES `input.repropose` to it.
  describe("--repropose", () => {
    function seedComparableEpic(db: Database, key: string): void {
      seedEpicWithServices(db, {
        key,
        services: ["acme/billing-api"],
        resolvedAtMs: NOW - 10 * DAY_MS,
        createdAtMs: NOW - 20 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-REPROPOSE-0",
        services: ["acme/billing-api"],
        resolvedAtMs: NOW - 30 * DAY_MS,
        createdAtMs: NOW - 60 * DAY_MS,
      });
    }

    test("without --repropose, a deleted watcher stays suppressed", async () => {
      const db = makeDb();
      seedComparableEpic(db, "PROJ-REPRO-1");
      const first = await runPremortem({ epicRef: "PROJ-REPRO-1" }, ctxMapped(db, BILLING_MAP));
      const watcherId = first.watchers[0]?.watcherId as string;
      expect(first.watchers[0]?.state).toBe("created");
      deleteWatcher(db, watcherId);

      const second = await runPremortem({ epicRef: "PROJ-REPRO-1" }, ctxMapped(db, BILLING_MAP));
      expect(second.watchers[0]?.state).toBe("suppressed");
      expect(second.watchers[0]?.watcherId).toBe(watcherId);
    });

    test("with --repropose, a deleted watcher is re-created fresh (paused)", async () => {
      const db = makeDb();
      seedComparableEpic(db, "PROJ-REPRO-2");
      const first = await runPremortem({ epicRef: "PROJ-REPRO-2" }, ctxMapped(db, BILLING_MAP));
      const watcherId = first.watchers[0]?.watcherId as string;
      deleteWatcher(db, watcherId);
      // Confirm the tombstone is really in place before repropose clears it.
      const suppressed = await runPremortem(
        { epicRef: "PROJ-REPRO-2" },
        ctxMapped(db, BILLING_MAP),
      );
      expect(suppressed.watchers[0]?.state).toBe("suppressed");

      const reproposed = await runPremortem(
        { epicRef: "PROJ-REPRO-2", repropose: true },
        ctxMapped(db, BILLING_MAP),
      );
      expect(reproposed.watchers[0]?.state).toBe("created");
      expect(reproposed.watchers[0]?.watcherId).toBe(watcherId);
    });

    test("--repropose on an epic with NO prior tombstone is a harmless no-op (still created)", async () => {
      const db = makeDb();
      seedComparableEpic(db, "PROJ-REPRO-3");
      const brief = await runPremortem(
        { epicRef: "PROJ-REPRO-3", repropose: true },
        ctxMapped(db, BILLING_MAP),
      );
      expect(brief.watchers[0]?.state).toBe("created");
    });
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
    // Unique to the Linear-specific branch, NOT present in the always-on
    // unconditional Jira-only gap (which also mentions "Linear" and "Jira
    // epics only", with different wording) — a weak assertion here would
    // pass even if the Linear-specific cause were deleted entirely and this
    // ref fell through to the generic non-Jira-tracker message.
    expect(
      brief.gaps.some(
        (g) =>
          g.detail.includes("is a Linear reference") &&
          g.detail.includes("no Linear project items are indexed"),
      ),
    ).toBe(true);
  });

  test("a non-Linear, non-Jira tracker prefix falls through to the generic non-Jira message", async () => {
    const db = makeDb();

    const brief = await runPremortem({ epicRef: "asana:ABC-120" }, ctx(db));

    expect(brief.epic).toBeNull();
    expect(brief.services).toEqual([]);
    expect(
      brief.gaps.some(
        (g) =>
          g.detail.includes("is not a Jira epic reference") &&
          g.detail.includes("pre-mortem covers Jira epics only"),
      ),
    ).toBe(true);
    // The Linear-specific wording must NOT leak onto an unrelated tracker.
    expect(brief.gaps.some((g) => g.detail.includes("is a Linear reference"))).toBe(false);
  });

  test("an indexed non-Epic issue type states what was checked, not a false not-found claim", async () => {
    const db = makeDb();
    upsertIndexedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "PROJ-900",
      title: "PROJ-900 title",
      metadata: { issue_type: "Épica" },
      modifiedAt: NOW,
      syncedAt: NOW,
    });

    let thrown: unknown;
    try {
      await runPremortem({ epicRef: "PROJ-900" }, ctx(db));
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toContain("Épica");
    expect(String(thrown)).not.toContain("was not found");
  });

  test("an indexed item with no recorded issue type at all states that, not a false not-found claim", async () => {
    const db = makeDb();
    upsertIndexedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "PROJ-901",
      title: "PROJ-901 title",
      metadata: {},
      modifiedAt: NOW,
      syncedAt: NOW,
    });

    let thrown: unknown;
    try {
      await runPremortem({ epicRef: "PROJ-901" }, ctx(db));
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toContain("no recorded issue type");
    expect(String(thrown)).not.toContain("was not found");
  });

  test("children exist but none resolve to a merged PR names the count, not the company-managed cause", async () => {
    const db = makeDb();
    upsertIndexedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "PROJ-910",
      title: "epic",
      metadata: {
        issue_type: "Epic",
        status_category: "in_progress",
        created_at_ms: NOW - 5 * DAY_MS,
      },
      modifiedAt: NOW - 5 * DAY_MS,
      syncedAt: NOW - 5 * DAY_MS,
    });
    // A real `parent_key` child — but no graph entity / `resolves` edge at
    // all, so it never resolves to a service (distinct from the
    // zero-children/company-managed path).
    upsertIndexedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "PROJ-910-C0",
      title: "child",
      metadata: { parent_key: "PROJ-910" },
      modifiedAt: NOW,
      syncedAt: NOW,
    });

    const brief = await runPremortem({ epicRef: "PROJ-910" }, ctx(db));

    expect(brief.services).toEqual([]);
    expect(
      brief.gaps.some(
        (g) =>
          g.detail.includes("has 1 child item(s)") && g.detail.includes("none resolve to a merged"),
      ),
    ).toBe(true);
    // Not the zero-children gap's specific phrasing — the ALWAYS-present
    // unconditional Jira-only gap also mentions "company-managed" in passing,
    // so this checks the distinguishing clause `noChildrenDetail` alone uses.
    expect(brief.gaps.some((g) => g.detail.includes("has no `parent_key` children"))).toBe(false);
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

  test("a themes-absent brief still carries all five structural risks, and names all five hedged causes", async () => {
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
    const themeGap = brief.gaps.find((g) => g.detail.includes("has not run yet"));
    expect(themeGap).toBeDefined();
    expect(themeGap?.detail).toContain("[premortem].enabled = false");
    expect(themeGap?.detail).toContain("[premortem].use_llm = false");
    expect(themeGap?.detail).toContain("no local LLM was reachable");
    expect(themeGap?.detail).toContain("demoted");
    // The real Task 5 CLI shape (`nimbus pre-mortem <epic-ref> --refresh`),
    // not a `nimbus premortem` command that will never exist.
    expect(themeGap?.remediation).toContain("nimbus pre-mortem PROJ-400 --refresh");
  });

  test("all four unconditional statements are present in every brief shape", async () => {
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

    // All FOUR, individually — a mutation deleting 3 of the 4 must fail this,
    // unlike checking a single shared substring across them.
    const statements = [
      "are correlations, not causes",
      "Theme confidence tops out at 0.86",
      "Pre-mortem covers Jira epics only, and only",
      "No deploy-failure watcher is proposed",
    ];
    for (const brief of [linearBrief, noChildrenBrief, fullBrief]) {
      for (const statement of statements) {
        expect(brief.gaps.some((g) => g.detail.includes(statement))).toBe(true);
      }
    }

    // The deploy-watcher note must state the cause that is STILL true. The engine now supports
    // `filter.affectedService` for `deploy_failed`, so the old "a deployment item's item.service
    // is the annotate provider slug" reasoning is obsolete — repeating it would be a false cause,
    // the exact defect this brief's honesty rules exist to prevent.
    const deployNote = fullBrief.gaps.find((g) =>
      g.detail.includes("No deploy-failure watcher is proposed"),
    );
    expect(deployNote?.detail).toContain("creates no `deployment` graph entity");
    expect(deployNote?.detail).not.toMatch(/could never fire/);
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

  describe("review drag", () => {
    test("computes a real median once PR timing metadata is present, with a natural PR-before-epic-resolution ordering", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-600",
        services: ["acme/search"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedChildlessEpic(db, "HIST-600", NOW - 50 * DAY_MS);
      // NATURAL ordering: the epic resolves (40d ago) AFTER its own PR merged
      // (46d ago) — the reviewer's red-prove. A window anchored on the
      // epic's OWN `resolved_at_ms` (40d ago) would exclude a PR that merged
      // earlier (46d ago); the fix anchors the window on the cohort's own PR
      // merge times instead.
      db.run(
        `UPDATE item SET metadata = json_set(metadata, '$.status_category', 'done', '$.resolved_at_ms', ?)
          WHERE service = 'jira' AND external_id = 'HIST-600'`,
        [NOW - 40 * DAY_MS],
      );
      seedChildWithPr(db, {
        epicKey: "HIST-600",
        childSuffix: "c1",
        service: "acme/search",
        openedAtMs: NOW - 48 * DAY_MS,
        mergedAtMs: NOW - 46 * DAY_MS,
      });
      // A second, repo-wide-only PR — not linked to any epic's children, so
      // it affects ONLY `repoReviewMedianMs`. Its longer (4 day) duration
      // pulls the repo baseline away from the cohort's 2-day duration,
      // giving a non-zero delta that could only come from real join+median
      // math, not a stub that echoes one value into both fields.
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

    test("names the real cause when the cohort has linked PRs but neither timestamp is recorded", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-610",
        services: ["acme/notimestamp"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedChildlessEpic(db, "HIST-610", NOW - 70 * DAY_MS);
      db.run(
        `UPDATE item SET metadata = json_set(metadata, '$.status_category', 'done', '$.resolved_at_ms', ?)
          WHERE service = 'jira' AND external_id = 'HIST-610'`,
        [NOW - 40 * DAY_MS],
      );
      // A REAL, linked PR item — but no opened_at_ms/merged_at at all.
      seedChildWithPr(db, { epicKey: "HIST-610", childSuffix: "c1", service: "acme/notimestamp" });

      const brief = await runPremortem({ epicRef: "PROJ-610" }, ctx(db));

      const reviewDrag = brief.risks.find((r) => r.kind === "review_drag");
      expect(reviewDrag?.value).toBeNull();
      expect(reviewDrag?.summary).not.toContain("No pull requests were found");
      expect(reviewDrag?.summary.toLowerCase()).toContain(
        "does not record both an opened and a merged",
      );
    });

    // Round-2 review red-prove: an OPEN PR (opened_at_ms present, merged_at
    // absent) must NOT produce a message asserting "no connector indexes a
    // pull request's opened timestamp" — that's false, the index plainly has
    // it. This is the exact case that becomes common the moment a connector
    // starts indexing PR-open events at all.
    test("does not claim the opened timestamp is missing when only the merged timestamp is absent (an open PR)", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-615",
        services: ["acme/openpr"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedChildlessEpic(db, "HIST-615", NOW - 70 * DAY_MS);
      db.run(
        `UPDATE item SET metadata = json_set(metadata, '$.status_category', 'done', '$.resolved_at_ms', ?)
          WHERE service = 'jira' AND external_id = 'HIST-615'`,
        [NOW - 40 * DAY_MS],
      );
      // opened_at_ms IS present; merged_at is not — a genuinely open PR.
      seedChildWithPr(db, {
        epicKey: "HIST-615",
        childSuffix: "c1",
        service: "acme/openpr",
        openedAtMs: NOW - 44 * DAY_MS,
      });

      const brief = await runPremortem({ epicRef: "PROJ-615" }, ctx(db));

      const reviewDrag = brief.risks.find((r) => r.kind === "review_drag");
      expect(reviewDrag?.value).toBeNull();
      expect(reviewDrag?.summary).not.toMatch(
        /no connector indexes a pull request's opened timestamp/i,
      );
      expect(reviewDrag?.summary.toLowerCase()).toContain(
        "does not record both an opened and a merged",
      );
    });

    test("keeps the 'no pull requests' message for the state nimbus data delete leaves behind", async () => {
      // The previous version of this test built the "no PRs" state by hand: a `pr` graph entity
      // with NO backing `item` row, which production never writes — `graph-populator.ts` only
      // creates a PR entity while writing that PR's item, and `deleteItemByPrimaryKey` clears the
      // entity alongside the item. So it proved a message against an impossible state.
      //
      // This is the REAL producer: `commands/data-delete.ts` (`nimbus data delete --service
      // github`) runs a bare `DELETE FROM item WHERE service = ?` and does NOT clear graph
      // entities, so the PR entities survive their items. The cohort still derives (it reads the
      // entity), the PR items are genuinely gone, and "no pull requests were found" is then the
      // literal truth rather than a stand-in for a vocabulary mismatch.
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-611",
        services: ["acme/noprs"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-611",
        services: ["acme/noprs"],
        resolvedAtMs: NOW - 40 * DAY_MS,
        createdAtMs: NOW - 70 * DAY_MS,
      });
      seedChildWithPr(db, {
        epicKey: "HIST-611",
        childSuffix: "c1",
        service: "acme/noprs",
        openedAtMs: NOW - 50 * DAY_MS,
        mergedAtMs: NOW - 45 * DAY_MS,
      });
      // Sanity: with the PR item present, review drag IS measurable — so the assertion below
      // fails on the deletion, not on a fixture that never linked a PR in the first place.
      const before = await runPremortem({ epicRef: "PROJ-611" }, ctx(db));
      expect(before.risks.find((r) => r.kind === "review_drag")?.value).not.toBeNull();

      // Verbatim the statement `runDataDelete` issues.
      db.run(`DELETE FROM item WHERE service = ?`, ["github"]);

      const brief = await runPremortem({ epicRef: "PROJ-611" }, ctx(db));

      const reviewDrag = brief.risks.find((r) => r.kind === "review_drag");
      expect(reviewDrag?.value).toBeNull();
      expect(reviewDrag?.summary).toContain("No pull requests were found for this cohort");
    });

    // C2: `epic-services.ts` reads the PR GRAPH ENTITY's `metadata.repo`, which
    // `graph-populator.ts` fills from the item's `repo ?? project`. A GitLab merge-request ITEM
    // carries `metadata.project` and no `repo` at all, so matching only `$.repo` selected zero
    // rows and the brief denied the very merge requests the cohort was built from.
    test("a GitLab cohort (metadata.project, no metadata.repo) is not reported as having no PRs", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-GL",
        services: ["acme/gitlab-svc"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-GL",
        services: ["acme/gitlab-svc"],
        resolvedAtMs: NOW - 40 * DAY_MS,
        createdAtMs: NOW - 70 * DAY_MS,
      });
      seedChildWithGitlabMr(db, {
        epicKey: "HIST-GL",
        childSuffix: "c1",
        project: "acme/gitlab-svc",
      });

      const brief = await runPremortem({ epicRef: "PROJ-GL" }, ctx(db));

      const reviewDrag = brief.risks.find((r) => r.kind === "review_drag");
      expect(reviewDrag?.value).toBeNull();
      expect(reviewDrag?.summary).not.toContain("No pull requests were found");
      // GitLab MR items carry no timestamps either (`connectors/_lib/gitlab/events.ts` writes
      // only `iid`/`project`/`action`), so the honest post-fix message is the OTHER unmeasurable
      // cause: the merge requests are there, the timestamps are not.
      expect(reviewDrag?.summary).toContain(
        "does not record both an opened and a merged timestamp",
      );
    });

    test("a GitLab merge request counts toward the repo-wide baseline too", async () => {
      // `repoPrDurations` had the SAME `$.repo`-only filter, so a GitLab repo's baseline was
      // empty even when its merge requests did carry both timestamps. Proven through the
      // baseline's own effect: with a timed GitLab MR on both sides, review drag becomes
      // measurable rather than null.
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-GL2",
        services: ["acme/gitlab-timed"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-GL2",
        services: ["acme/gitlab-timed"],
        resolvedAtMs: NOW - 40 * DAY_MS,
        createdAtMs: NOW - 70 * DAY_MS,
      });
      seedChildWithGitlabMr(db, {
        epicKey: "HIST-GL2",
        childSuffix: "c1",
        project: "acme/gitlab-timed",
        openedAtMs: NOW - 50 * DAY_MS,
        mergedAtMs: NOW - 45 * DAY_MS,
      });

      const brief = await runPremortem({ epicRef: "PROJ-GL2" }, ctx(db));

      const reviewDrag = brief.risks.find((r) => r.kind === "review_drag");
      expect(reviewDrag?.value).not.toBeNull();
      expect(reviewDrag?.summary).toContain("across the repo over the same window");
    });
  });

  describe("incident coupling", () => {
    test("counts a deploy-incident correlation inside an epic's window, translated through the DORA service mapping", async () => {
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
      // The DORA config id is deliberately NOT the repo name — proving the
      // translation, not a same-string coincidence.
      seedDeploymentCorrelatedWithIncident(db, {
        service: "orders-svc-id",
        occurredAtMs: histCreatedAtMs + 5 * DAY_MS,
        idSuffix: "d1",
      });

      const brief = await runPremortem(
        { epicRef: "PROJ-700" },
        { ...ctx(db), resolveServiceId: fakeResolveServiceId({ "acme/orders": "orders-svc-id" }) },
      );

      const ic = brief.risks.find((r) => r.kind === "incident_coupling");
      expect(ic?.value).toBe(1);
      expect(ic?.summary).toContain("1 of 1");
    });

    test("is a named gap, not a fabricated zero, when no repo resolves to a configured DORA service", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-730",
        services: ["acme/unmapped"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-730",
        services: ["acme/unmapped"],
        resolvedAtMs: NOW - 40 * DAY_MS,
        createdAtMs: NOW - 70 * DAY_MS,
      });

      // No `resolveServiceId` in ctx at all.
      const brief = await runPremortem({ epicRef: "PROJ-730" }, ctx(db));

      const ic = brief.risks.find((r) => r.kind === "incident_coupling");
      expect(ic?.value).toBeNull();
      expect(ic?.summary).not.toMatch(/^0 of/);
      expect(ic?.summary.toLowerCase()).toContain("no deployment-service mapping");
    });

    test("excludes a correlation outside the epic's own window", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-710",
        services: ["acme/window-svc"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      const histResolvedAtMs = NOW - 40 * DAY_MS;
      const histCreatedAtMs = NOW - 70 * DAY_MS;
      seedEpicWithServices(db, {
        key: "HIST-710",
        services: ["acme/window-svc"],
        resolvedAtMs: histResolvedAtMs,
        createdAtMs: histCreatedAtMs,
      });
      // Correctly-mapped service, but AFTER the epic's own window closed —
      // if the window bound were neutered, this would erroneously count.
      seedDeploymentCorrelatedWithIncident(db, {
        service: "window-svc-id",
        occurredAtMs: histResolvedAtMs + 5 * DAY_MS,
        idSuffix: "outside",
      });

      const brief = await runPremortem(
        { epicRef: "PROJ-710" },
        {
          ...ctx(db),
          resolveServiceId: fakeResolveServiceId({ "acme/window-svc": "window-svc-id" }),
        },
      );

      const ic = brief.risks.find((r) => r.kind === "incident_coupling");
      expect(ic?.value).toBe(0);
      expect(ic?.summary).toMatch(/^0 of 1/);
    });

    test("excludes a correlation mapped to a different service", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-720",
        services: ["acme/orders2"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      const histResolvedAtMs = NOW - 40 * DAY_MS;
      const histCreatedAtMs = NOW - 70 * DAY_MS;
      seedEpicWithServices(db, {
        key: "HIST-720",
        services: ["acme/orders2"],
        resolvedAtMs: histResolvedAtMs,
        createdAtMs: histCreatedAtMs,
      });
      // Inside the window, but a DIFFERENT, unrelated resolved service id —
      // if the service filter were neutered, this would erroneously count.
      seedDeploymentCorrelatedWithIncident(db, {
        service: "unrelated-svc-id",
        occurredAtMs: histCreatedAtMs + 5 * DAY_MS,
        idSuffix: "wrong-service",
      });

      const brief = await runPremortem(
        { epicRef: "PROJ-720" },
        {
          ...ctx(db),
          resolveServiceId: fakeResolveServiceId({ "acme/orders2": "orders2-svc-id" }),
        },
      );

      const ic = brief.risks.find((r) => r.kind === "incident_coupling");
      expect(ic?.value).toBe(0);
      expect(ic?.summary).toMatch(/^0 of 1/);
    });

    test("is unmeasurable, not a degenerate-window zero, when the only cohort member has no created_at_ms", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-740",
        services: ["acme/nodate"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      const resolvedAtMs = NOW - 40 * DAY_MS;
      // No createdAtMs at all — the only cohort member, so nothing in this
      // cohort is ever actually queried (measured === 0).
      seedEpicWithServices(db, { key: "HIST-740", services: ["acme/nodate"], resolvedAtMs });
      // Sits EXACTLY at resolvedAtMs — the one instant a degenerate
      // `resolvedAtMs..resolvedAtMs` window would still (mis)match, were
      // that fallback still in place.
      seedDeploymentCorrelatedWithIncident(db, {
        service: "nodate-svc-id",
        occurredAtMs: resolvedAtMs,
        idSuffix: "exact",
      });

      const brief = await runPremortem(
        { epicRef: "PROJ-740" },
        { ...ctx(db), resolveServiceId: fakeResolveServiceId({ "acme/nodate": "nodate-svc-id" }) },
      );

      const ic = brief.risks.find((r) => r.kind === "incident_coupling");
      // Not a measured `0` (nothing was actually queried) and not a
      // coincidental match on the degenerate single-instant window either.
      expect(ic?.value).toBeNull();
      expect(ic?.summary.toLowerCase()).toContain("no deployment-service mapping");
    });

    test("skips a cohort member whose services don't resolve, while still counting one that does", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-750",
        services: ["acme/mixed-a"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      const histACreatedAtMs = NOW - 50 * DAY_MS;
      const histAResolvedAtMs = NOW - 30 * DAY_MS;
      seedEpicWithServices(db, {
        key: "HIST-750A",
        services: ["acme/mixed-a"],
        resolvedAtMs: histAResolvedAtMs,
        createdAtMs: histACreatedAtMs,
      });
      // Shares a DIFFERENT service with the (overridden) target — enters the
      // cohort, but its own service has no entry in the resolver's map.
      seedEpicWithServices(db, {
        key: "HIST-750B",
        services: ["acme/mixed-b"],
        resolvedAtMs: NOW - 35 * DAY_MS,
        createdAtMs: NOW - 55 * DAY_MS,
      });
      seedDeploymentCorrelatedWithIncident(db, {
        service: "mixed-a-svc-id",
        occurredAtMs: histACreatedAtMs + 5 * DAY_MS,
        idSuffix: "mixed-a",
      });

      const brief = await runPremortem(
        { epicRef: "PROJ-750", serviceOverrides: ["acme/mixed-a", "acme/mixed-b"] },
        {
          ...ctx(db),
          resolveServiceId: fakeResolveServiceId({ "acme/mixed-a": "mixed-a-svc-id" }),
        },
      );

      expect(brief.cohort.members.map((m) => m.key).sort()).toEqual(["HIST-750A", "HIST-750B"]);
      const ic = brief.risks.find((r) => r.kind === "incident_coupling");
      // Only HIST-750A (resolvable + correlated) was actually MEASURED;
      // HIST-750B was skipped (never queried), so the rate denominates on 1
      // measured epic, not the full 2-member cohort — "1 of 1" (100%), with
      // the skipped epic noted separately, never folded into a "1 of 2 (50%)"
      // rate that would imply both were checked.
      expect(ic?.value).toBe(1);
      expect(ic?.summary).toContain("1 of 1 comparable epics (100%)");
      expect(ic?.summary).not.toContain("1 of 2 comparable epics (50%)");
      expect(ic?.summary.toLowerCase()).toContain("could not be checked");
    });

    test("is unmeasurable when a resolver is configured but nothing in the cohort maps to it", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-760",
        services: ["acme/nomap"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-760",
        services: ["acme/nomap"],
        resolvedAtMs: NOW - 40 * DAY_MS,
        createdAtMs: NOW - 70 * DAY_MS,
      });

      // The resolver IS configured (unlike the "no resolveServiceId at all"
      // test above) — it simply maps nothing this cohort touches.
      const brief = await runPremortem(
        { epicRef: "PROJ-760" },
        {
          ...ctx(db),
          resolveServiceId: fakeResolveServiceId({ "acme/unrelated-config": "unrelated-svc" }),
        },
      );

      const ic = brief.risks.find((r) => r.kind === "incident_coupling");
      expect(ic?.value).toBeNull();
      expect(ic?.summary.toLowerCase()).toContain("no deployment-service mapping");
    });
  });

  describe("honesty rules 1 and 2", () => {
    test("rule 1 fires when the cohort's history span is short", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-810",
        services: ["acme/shorthist"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      // Oldest cohort epic closed only 10 days ago — well under the 180-day floor.
      seedEpicWithServices(db, {
        key: "HIST-810",
        services: ["acme/shorthist"],
        resolvedAtMs: NOW - 10 * DAY_MS,
        createdAtMs: NOW - 20 * DAY_MS,
      });

      const brief = await runPremortem({ epicRef: "PROJ-810" }, ctx(db));

      expect(
        brief.gaps.some(
          (g) => g.detail.includes("oldest closed") && g.detail.includes("short history"),
        ),
      ).toBe(true);
    });

    test("rule 1 stays silent when the cohort's history span is deep", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-811",
        services: ["acme/deephist"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-811",
        services: ["acme/deephist"],
        resolvedAtMs: NOW - 200 * DAY_MS,
        createdAtMs: NOW - 230 * DAY_MS,
      });

      const brief = await runPremortem({ epicRef: "PROJ-811" }, ctx(db));

      expect(brief.gaps.some((g) => g.detail.includes("short history"))).toBe(false);
    });

    test("rule 2 fires when a cohort source has a truncated body, and names both possible causes", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-820",
        services: ["acme/truncated"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-820",
        services: ["acme/truncated"],
        resolvedAtMs: NOW - 40 * DAY_MS,
        createdAtMs: NOW - 70 * DAY_MS,
      });
      db.run(
        `UPDATE item SET body_complete = 0 WHERE service = 'jira' AND external_id = 'HIST-820'`,
      );

      const brief = await runPremortem({ epicRef: "PROJ-820" }, ctx(db));

      const truncationGap = brief.gaps.find((g) => g.detail.includes("1 of 1 source"));
      expect(truncationGap).toBeDefined();
      expect(truncationGap?.detail).toContain("never re-synced");
      expect(truncationGap?.detail).toContain("below `full` depth");
    });

    test("rule 2 stays silent when nothing in the cohort is truncated", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-821",
        services: ["acme/nottruncated"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      seedEpicWithServices(db, {
        key: "HIST-821",
        services: ["acme/nottruncated"],
        resolvedAtMs: NOW - 40 * DAY_MS,
        createdAtMs: NOW - 70 * DAY_MS,
      });
      // `seedEpicWithServices` never sets a body, so `body_complete` defaults
      // to 0 (see `item-store.ts`) — this test needs the cohort's OWN member
      // item (the epic, not its children) to genuinely carry a complete body.
      db.run(
        `UPDATE item SET body = 'full body text', body_complete = 1
          WHERE service = 'jira' AND external_id = 'HIST-821'`,
      );

      const brief = await runPremortem({ epicRef: "PROJ-821" }, ctx(db));

      expect(brief.gaps.some((g) => g.detail.includes("truncated body"))).toBe(false);
    });
  });

  test("an unresolvable Jira ref throws rather than returning a partial brief", async () => {
    const db = makeDb();
    await expect(runPremortem({ epicRef: "PROJ-9999" }, ctx(db))).rejects.toThrow(/not found/);
  });

  test("a target epic with no recorded creation date names THAT, not 'brand new'", async () => {
    const db = makeDb();
    // No createdAtMs at all — `seedEpicWithServices` leaves `created_at_ms`
    // absent from the target's own metadata.
    seedEpicWithServices(db, {
      key: "PROJ-770",
      services: ["acme/nocreated"],
      resolvedAtMs: NOW - 5 * DAY_MS,
    });
    seedEpicWithServices(db, {
      key: "HIST-770",
      services: ["acme/nocreated"],
      resolvedAtMs: NOW - 40 * DAY_MS,
      createdAtMs: NOW - 70 * DAY_MS,
    });

    const brief = await runPremortem({ epicRef: "PROJ-770" }, ctx(db));

    const cycleTime = brief.risks.find((r) => r.kind === "cycle_time");
    // `expectationOnly` stays true — the figure genuinely is not a comparison — but the SENTENCE
    // must not let the reader infer a young epic. The previous behaviour defaulted the missing
    // date to `now`, producing an age of ~0 and a `(expectation)` label whose only available
    // explanation was "this epic is brand new". The epic's age is unknown, not zero.
    expect(cycleTime?.expectationOnly).toBe(true);
    expect(cycleTime?.summary).toContain("no recorded creation date");
    expect(cycleTime?.summary).toContain("not a young epic");
    // The cohort median is still measurable and still reported.
    expect(cycleTime?.value).not.toBeNull();
    // And it must NOT claim an elapsed-days comparison it could not make.
    expect(cycleTime?.summary).not.toMatch(/days elapsed so far/);
  });

  test("a genuinely young epic still reads as a young epic", async () => {
    // Discriminates the test above: `expectationOnly` alone cannot tell the two apart, which is
    // precisely why the old test passed while the message was wrong.
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "PROJ-771",
      services: ["acme/young"],
      resolvedAtMs: NOW - 5 * DAY_MS,
      createdAtMs: NOW - 1_000,
    });
    seedEpicWithServices(db, {
      key: "HIST-771",
      services: ["acme/young"],
      resolvedAtMs: NOW - 40 * DAY_MS,
      createdAtMs: NOW - 70 * DAY_MS,
    });

    const brief = await runPremortem({ epicRef: "PROJ-771" }, ctx(db));

    const cycleTime = brief.risks.find((r) => r.kind === "cycle_time");
    expect(cycleTime?.expectationOnly).toBe(true);
    expect(cycleTime?.summary).not.toContain("no recorded creation date");
  });

  describe("watcher proposals are a function of the TARGET's services, not the cohort", () => {
    test("an epic with NO comparable cohort still gets its watcher proposed", async () => {
      // The proposal used to sit inside the `cohort.members.length > 0` branch, so a
      // first-of-its-kind epic — the one whose risks are least knowable from history — silently
      // got nothing, while the docs promised one watcher per affected service unconditionally.
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-NOCOHORT",
        services: ["acme/billing-api"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });

      const brief = await runPremortem({ epicRef: "PROJ-NOCOHORT" }, ctxMapped(db, BILLING_MAP));

      expect(brief.cohort.members).toHaveLength(0);
      expect(brief.watchers).toHaveLength(1);
      expect(brief.watchers[0]?.state).toBe("created");
    });

    test("--repropose works on an epic with no comparable cohort", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-NOCOHORT-2",
        services: ["acme/billing-api"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });
      const first = await runPremortem({ epicRef: "PROJ-NOCOHORT-2" }, ctxMapped(db, BILLING_MAP));
      deleteWatcher(db, first.watchers[0]?.watcherId as string);
      const suppressed = await runPremortem(
        { epicRef: "PROJ-NOCOHORT-2" },
        ctxMapped(db, BILLING_MAP),
      );
      expect(suppressed.watchers[0]?.state).toBe("suppressed");

      const reproposed = await runPremortem(
        { epicRef: "PROJ-NOCOHORT-2", repropose: true },
        ctxMapped(db, BILLING_MAP),
      );
      expect(reproposed.watchers[0]?.state).toBe("created");
    });

    test("no watcher for a repo with no configured service mapping, and the gap names why", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-UNMAPPED",
        services: ["acme/billing-api", "acme/unmapped"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });

      const brief = await runPremortem({ epicRef: "PROJ-UNMAPPED" }, ctxMapped(db, BILLING_MAP));

      expect(brief.watchers.map((w) => w.service)).toEqual(["acme/billing-api"]);
      const gap = brief.gaps.find((g) => g.detail.includes("acme/unmapped"));
      expect(gap?.detail).toContain("no `[metrics.dora.<id>]` / `[ci.service.<id>]` block claims");
      // The real cause, not a repo-path fallback that writes a watcher which can never fire.
      expect(gap?.detail).not.toContain("no deployment-service mapping ... is configured at all");
    });

    test("with NO resolver at all, nothing is proposed and the gap says so", async () => {
      const db = makeDb();
      seedEpicWithServices(db, {
        key: "PROJ-NORESOLVER",
        services: ["acme/billing-api"],
        resolvedAtMs: NOW - 5 * DAY_MS,
        createdAtMs: NOW - 15 * DAY_MS,
      });

      const brief = await runPremortem({ epicRef: "PROJ-NORESOLVER" }, ctx(db));

      expect(brief.watchers).toEqual([]);
      const gap = brief.gaps.find((g) => g.detail.includes("acme/billing-api"));
      expect(gap?.detail).toContain("is configured at all");
    });
  });

  test("emitPremortemBrief routes through the configured LLM for markdown synthesis", async () => {
    const db = makeDb();
    seedChildlessEpic(db, "PROJ-780", NOW - 2 * DAY_MS);
    const notifications: Array<{ method: string; params: unknown }> = [];
    const fakeLlm = {
      generateMarkdown: async (): Promise<string | null> => "# LLM-authored brief",
    };

    await emitPremortemBrief(
      { epicRef: "PROJ-780" },
      {
        db,
        notify: (method, params) => notifications.push({ method, params }),
        sessionId: "s3",
        llm: fakeLlm,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifications).toHaveLength(1);
    const params = notifications[0]?.params as { brief: string };
    expect(params.brief).toBe("# LLM-authored brief");
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
