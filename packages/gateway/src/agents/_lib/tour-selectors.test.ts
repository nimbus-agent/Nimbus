import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  markExtracted,
  upsertCandidate as upsertDecisionCandidate,
} from "../../decisions/decision-store.ts";
import {
  computeTermStats,
  markConsolidated,
  upsertCandidate as upsertGlossaryCandidate,
} from "../../glossary/glossary-store.ts";
import { normalizeTerm } from "../../glossary/term-normalize.ts";
import { ensureGraphEntity } from "../../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { openMigratedMemoryDb } from "../../index/migrated-db-template.ts";
import { dirExternalId, fileExternalId } from "../../ownership/ownership-pass.ts";
import { TOUR_SELECTORS, type TourSelectorCtx } from "./tour-selectors.ts";
import { TOUR_STEP_KINDS } from "./tour-types.ts";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let db: Database;
const ctx = (over: Partial<TourSelectorCtx> = {}): TourSelectorCtx => ({
  db,
  nowMs: NOW,
  fsRoots: [],
  ownershipRoots: [],
  decisionsMinConfidence: 0,
  resolveSelf: async () => null,
  ...over,
});
beforeEach(() => {
  db = openMigratedMemoryDb();
});
afterEach(() => {
  db.close();
});

test("the selector map is total over the kinds", () => {
  expect(Object.keys(TOUR_SELECTORS).sort()).toEqual([...TOUR_STEP_KINDS].sort());
});

describe("glossary", () => {
  /** Via `glossary-store.ts`'s own `upsertCandidate` — the production writer for a mined term. */
  function seedPendingGlossaryTerm(d: Database, surface: string): void {
    const key = normalizeTerm(surface);
    upsertGlossaryCandidate(d, {
      key,
      surface,
      form: "phrase",
      stats: computeTermStats(d, key),
      score: 1,
      nowMs: 1,
    });
  }

  /** Candidate first, then `markConsolidated` — the only way a term LEAVES `pending`. */
  function seedConsolidatedGlossaryTerm(d: Database, surface: string): void {
    seedPendingGlossaryTerm(d, surface);
    markConsolidated(d, {
      termKey: normalizeTerm(surface),
      definition: "d",
      definitionSource: "snippet",
      synonyms: [],
      nearMisses: [],
      nowMs: 2,
    });
  }

  test("skips when no term is CONSOLIDATED, even if candidates exist", async () => {
    seedPendingGlossaryTerm(db, "idempotency");
    expect(await TOUR_SELECTORS.glossary(ctx())).toEqual({
      skip: "no consolidated glossary terms",
    });
  });
  test("offers the step once a term is consolidated", async () => {
    seedConsolidatedGlossaryTerm(db, "idempotency");
    expect(await TOUR_SELECTORS.glossary(ctx())).toEqual({
      ok: {
        title: "Your team's vocabulary",
        args: [],
        reason: "consolidated glossary terms are indexed",
      },
    });
  });
});

describe("why", () => {
  /**
   * Via `item-store.ts`'s `upsertIndexedItem` — the ONE production writer that both inserts the
   * `item` row `pickDemoSymbol` joins against and (unconditionally, at the end of the same call)
   * populates the `graph_entity` symbol row through `syncGraphFromIndexedItem`. Reproducing only
   * the graph half (the way `fleet-sweep-enumerators.test.ts`'s `enumerateSymbols` fixture does)
   * would leave no joinable `item` row, since `pickDemoSymbol` requires both.
   */
  function seedSymbol(
    d: Database,
    args: { repoRoot: string; file: string; name: string; line: number },
  ): void {
    upsertIndexedItem(d, {
      service: "filesystem",
      type: "code_symbol",
      externalId: `${args.file}:${args.name}`,
      title: `${args.name} (function)`,
      modifiedAt: 0,
      authorId: null,
      metadata: {
        file: args.file,
        name: args.name,
        kind: "function",
        repoRoot: args.repoRoot,
        excerptStartLine: args.line,
      },
      syncedAt: 0,
    });
  }

  test("skips with no symbols", async () => {
    expect(await TOUR_SELECTORS.why(ctx({ fsRoots: ["/repo"] }))).toEqual({
      skip: "no indexed symbols in configured roots",
    });
  });
  test("emits the ABSOLUTE path and --line, never path:line", async () => {
    const root = join("/", "repo");
    seedSymbol(db, { repoRoot: root, file: "src/auth.ts", name: "login", line: 42 });
    const out = await TOUR_SELECTORS.why(ctx({ fsRoots: [root] }));
    expect(out).toEqual({
      ok: {
        title: "Why this code exists",
        args: [join(root, "src/auth.ts"), "--line", "42"],
        reason: "symbol `login`",
      },
    });
  });
});

describe("owners", () => {
  /** Via `ownership-pass.ts`'s own `dirExternalId`/`fileExternalId` + `relationship-graph.ts`'s
   * `ensureGraphEntity` — the exact seeding shape `fleet-sweep-enumerators.test.ts`'s
   * `enumeratePaths` fixtures use, since `selectOwners` is built directly on that enumerator. */
  function fileNode(d: Database, root: string, rel: string): void {
    ensureGraphEntity(d, {
      type: "source_file",
      externalId: fileExternalId(root, rel),
      label: rel,
      service: "filesystem",
    });
  }
  function dirNode(d: Database, root: string, rel: string): void {
    ensureGraphEntity(d, {
      type: "directory",
      externalId: dirExternalId(root, rel),
      label: rel === "" ? root : rel,
      service: "filesystem",
    });
  }

  test("skips when no git-aware roots are configured", async () => {
    expect(await TOUR_SELECTORS.owners(ctx({ ownershipRoots: [] }))).toEqual({
      skip: "no ownership pass data indexed",
    });
  });

  test("picks the non-root directory with the most files, exercising the ranking", async () => {
    const root = join("/", "repo");
    dirNode(db, root, "");
    dirNode(db, root, "src");
    dirNode(db, root, "docs");
    dirNode(db, root, "src-old");
    fileNode(db, root, "src/a.ts");
    fileNode(db, root, "src/b.ts");
    fileNode(db, root, "docs/readme.md");
    fileNode(db, root, "src-old/x.ts");

    const out = await TOUR_SELECTORS.owners(ctx({ ownershipRoots: [root] }));
    expect(out).toEqual({
      ok: {
        title: "Who owns this code",
        args: [join(root, "src")],
        reason: "2 files under ownership",
      },
    });
  });

  test("a file under src-old does not count toward src — containment, not a string prefix", async () => {
    const root = join("/", "repo");
    dirNode(db, root, "src");
    dirNode(db, root, "src-old");
    fileNode(db, root, "src-old/x.ts");

    // If the fence were `startsWith` on the raw path string, `src-old/x.ts` would count toward
    // `src` too (`"<root>/src-old/x.ts".startsWith("<root>/src")`), and `src` — with zero files
    // of its own — would still win by that miscount.
    const out = await TOUR_SELECTORS.owners(ctx({ ownershipRoots: [root] }));
    expect(out).toEqual({
      ok: {
        title: "Who owns this code",
        args: [join(root, "src-old")],
        reason: "1 files under ownership",
      },
    });
  });
});

describe("oncall", () => {
  /** Mirrors `oncall-queries.test.ts`'s own `insertItem`/`insertIncident` — that file hand-inserts
   * directly into `item` rather than through a production writer (no connector sync fixture exists
   * for a unit test at this layer), so this reproduces the same shape rather than inventing a new
   * one. */
  function insertItem(
    d: Database,
    row: {
      id: string;
      type: string;
      service?: string;
      title?: string;
      modifiedAt?: number;
      meta?: unknown;
    },
  ): void {
    d.run(
      `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      [
        row.id,
        row.service ?? "pagerduty",
        row.type,
        row.id,
        row.title ?? row.id,
        row.modifiedAt ?? 0,
        row.meta === undefined ? null : JSON.stringify(row.meta),
        0,
      ],
    );
  }

  function seedIncident(
    d: Database,
    row: { id: string; title?: string; status?: string; openedAtMs?: number },
  ): void {
    insertItem(d, {
      id: row.id,
      type: "incident",
      service: "pagerduty",
      title: row.title ?? row.id,
      meta: {
        status: row.status ?? "triggered",
        assignee_emails: [],
        resolved_by_email: null,
        opened_at_ms: row.openedAtMs ?? 0,
        pagerduty_service_id: "PSERVICE1",
      },
    });
  }

  test("skips when no incidents are indexed", async () => {
    expect(await TOUR_SELECTORS.oncall(ctx())).toEqual({ skip: "no indexed incidents" });
  });

  test("offers the newest incident regardless of status", async () => {
    seedIncident(db, { id: "inc-older", title: "Old", openedAtMs: 1_000 });
    seedIncident(db, { id: "inc-newer", title: "DB down", status: "resolved", openedAtMs: 2_000 });
    const out = await TOUR_SELECTORS.oncall(ctx());
    expect(out).toEqual({
      ok: {
        title: "On-call triage",
        args: ["--incident", "inc-newer"],
        reason: "incident: DB down",
      },
    });
  });
});

describe("standup", () => {
  /** Mirrors `standup.test.ts`'s own `insertItem` — same rationale as `oncall`'s above: that file
   * hand-inserts directly into `item` rather than through a connector-sync fixture. */
  function insertItem(
    d: Database,
    row: { id: string; type: string; service?: string; authorId: string; modifiedAt: number },
  ): void {
    d.run(
      `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
      [row.id, row.service ?? "slack", row.type, row.id, row.id, row.modifiedAt, row.authorId, 0],
    );
  }

  test("skips when identity cannot be resolved", async () => {
    expect(await TOUR_SELECTORS.standup(ctx({ resolveSelf: async () => null }))).toEqual({
      skip: "no recent activity attributable to you",
    });
  });

  test("skips when identity resolves but every lane is empty in the window", async () => {
    expect(await TOUR_SELECTORS.standup(ctx({ resolveSelf: async () => "person-me" }))).toEqual({
      skip: "no recent activity attributable to you",
    });
  });

  test("a rejecting resolveSelf yields the skip rather than throwing", async () => {
    expect(
      await TOUR_SELECTORS.standup(ctx({ resolveSelf: () => Promise.reject(new Error("boom")) })),
    ).toEqual({ skip: "no recent activity attributable to you" });
  });

  test("offers the step once at least one lane has a row in the last 24h", async () => {
    insertItem(db, {
      id: "msg-1",
      type: "message",
      authorId: "person-me",
      modifiedAt: NOW - 1_000,
    });
    const out = await TOUR_SELECTORS.standup(ctx({ resolveSelf: async () => "person-me" }));
    expect(out).toEqual({
      ok: {
        title: "Your last 24 hours",
        args: [],
        reason: "activity attributed to you in the last 24h",
      },
    });
  });
});

describe("decisions", () => {
  function seedDecision(d: Database, args: { id: string; decidedAt: number }): void {
    upsertDecisionCandidate(d, {
      id: args.id,
      sourceItemId: `item-${args.id}`,
      cueTier: "explicit",
      cueText: "we decided",
      priority: 1,
      decidedAt: args.decidedAt,
      nowMs: args.decidedAt,
    });
    markExtracted(
      d,
      args.id,
      {
        statement: "Adopt Postgres",
        rationale: null,
        alternatives: [],
        extractionSource: "snippet",
      },
      args.decidedAt,
    );
  }

  test("skips when no decisions are extracted", async () => {
    expect(await TOUR_SELECTORS.decisions(ctx())).toEqual({
      skip: "no extracted decisions in the last 90 days",
    });
  });

  test("skips a decision older than the 90-day window", async () => {
    seedDecision(db, { id: "d-old", decidedAt: NOW - 91 * DAY_MS });
    expect(await TOUR_SELECTORS.decisions(ctx())).toEqual({
      skip: "no extracted decisions in the last 90 days",
    });
  });

  test("skips a decision below decisionsMinConfidence", async () => {
    // `markExtracted` never touches `confidence`, which stays at its schema default of 0.
    seedDecision(db, { id: "d-recent", decidedAt: NOW - 1_000 });
    expect(await TOUR_SELECTORS.decisions(ctx({ decisionsMinConfidence: 0.5 }))).toEqual({
      skip: "no extracted decisions in the last 90 days",
    });
  });

  test("offers the step for a recent, sufficiently-confident decision", async () => {
    seedDecision(db, { id: "d-recent", decidedAt: NOW - 1_000 });
    expect(await TOUR_SELECTORS.decisions(ctx())).toEqual({
      ok: {
        title: "Decisions your team made",
        args: [],
        reason: "extracted decisions in the last 90 days",
      },
    });
  });
});
