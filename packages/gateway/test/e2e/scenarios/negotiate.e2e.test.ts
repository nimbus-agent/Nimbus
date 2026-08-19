import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { emitNegotiateBrief } from "../../../src/agents/negotiate.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../../../src/graph/relationship-graph.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { insertPerson } from "../../../src/people/person-store.ts";

/**
 * Derived from the clock, never a fixed epoch. Every lane except ownership windows on
 * `modified_at` against `Date.now() - sinceMs`, and this scenario runs the DEFAULT 90-day
 * window. A hardcoded constant (this was `1_800_000_000_000` — 2027-01-15) therefore stops
 * being inside the window on a fixed future date: after 2027-04-15 every seeded item would
 * fall before the cutoff, all six lanes would return `0`, and the load-bearing assertions
 * below would fail with nothing having changed in the code. A time-bomb in a test that only
 * fires long after the PR merges is worse than no test.
 */
const NOW = Date.now();
const PERSON_ID = "person:me";
const UNAVAILABLE_EVIDENCE = ["on-call shifts", "deploys triggered"];

/** Narrows the `negotiate.briefReady` payload instead of casting it into shape. */
function isBriefReadyParams(v: unknown): v is { brief: string; findings: { kind: string } } {
  if (v === null || typeof v !== "object") return false;
  const o = v as { brief?: unknown; findings?: unknown };
  if (typeof o.brief !== "string") return false;
  if (o.findings === null || typeof o.findings !== "object") return false;
  return typeof (o.findings as { kind?: unknown }).kind === "string";
}

/** The REAL V44+ `egress_ledger` (and the rest of the shipped schema), built by the migration
 * runner rather than a hand-copied `CREATE TABLE` — mirrors `premortem.e2e.test.ts`. */
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

/**
 * Seeds through the real writers only — `upsertIndexedItem`, `upsertGraphEntity`,
 * `upsertGraphRelation` — never a hand-rolled `INSERT INTO graph_entity`.
 *
 * The issue is upserted BEFORE the PR that references it in its body: `syncPrGraph` (invoked
 * internally by `upsertIndexedItem`) only wires a `resolves` edge against issue entities already
 * present in `graph_entity` at PR-sync time — the reverse order silently yields zero resolved
 * tickets while the test still passes, proving nothing.
 */
function seedNegotiateEvidence(db: Database): void {
  insertPerson(db, {
    id: PERSON_ID,
    displayName: "Ada Lovelace",
    canonicalEmail: "ada@example.com",
    githubLogin: "ada",
    gitlabLogin: null,
    slackHandle: null,
    linearMemberId: null,
    jiraAccountId: null,
    notionUserId: null,
    bitbucketUuid: null,
    linked: false,
    metadata: {},
  });

  // The issue, seeded BEFORE the PR that resolves it (the ordering trap above).
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/widgets#42",
    title: "Checkout button unresponsive",
    bodyPreview: "",
    modifiedAt: NOW,
    syncedAt: NOW,
    authorId: PERSON_ID,
    metadata: { repo: "acme/widgets", number: 42 },
  });

  // Authored PR #1: enriched with size stats, and its body closes the issue above.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/widgets#7",
    title: "Fix checkout button",
    bodyPreview: "closes #42",
    modifiedAt: NOW,
    syncedAt: NOW,
    authorId: PERSON_ID,
    metadata: {
      repo: "acme/widgets",
      number: 7,
      merged: true,
      additions: 120,
      deletions: 30,
      changed_files: 4,
    },
  });

  // Authored PR #2: unenriched (no size stats) — exercises stats coverage < total.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/widgets#8",
    title: "Add checkout regression test",
    bodyPreview: "",
    modifiedAt: NOW,
    syncedAt: NOW,
    authorId: PERSON_ID,
    metadata: { repo: "acme/widgets", number: 8, merged: false },
  });

  // A review authored by the subject.
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: "acme/widgets#9#review-1",
    title: "Review on acme/widgets#9",
    bodyPreview: "",
    modifiedAt: NOW,
    syncedAt: NOW,
    authorId: PERSON_ID,
    metadata: { repo: "acme/widgets", pr_number: 9, review_id: 1, state: "approved" },
  });

  // An ownership edge, through the real graph writers.
  const personEntityId = upsertGraphEntity<string>(db, {
    type: "person",
    externalId: PERSON_ID,
    label: "Ada Lovelace",
  });
  const serviceEntityId = upsertGraphEntity<string>(db, {
    type: "service",
    externalId: "svc:checkout",
    label: "checkout",
  });
  upsertGraphRelation(db, personEntityId, serviceEntityId, "owns", NOW, 0.9);
}

describe("nimbus negotiate (e2e, in-process)", () => {
  test("the negotiate agent source is HITL-free by shape", () => {
    // Anchored to this file, not the CWD — mirrors premortem.e2e.test.ts/decisions.e2e.test.ts.
    // A CWD-relative read resolves when the suite starts at the repo root but throws ENOENT
    // under the sharded coverage runner, which starts elsewhere.
    const src = readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "agents", "negotiate.ts"),
      "utf8",
    );
    expect(src).not.toContain("ToolExecutor");
    expect(src).not.toContain("HITL_REQUIRED");
    expect(src).not.toContain("connectors.dispatch");
  });

  test(
    "seeded index -> emitNegotiateBrief -> negotiate.briefReady fires with markdown naming the " +
      "subject and window, a negotiate-kind finding, and the unconditional absent-evidence note",
    async () => {
      const db = freshDb();
      seedNegotiateEvidence(db);

      const seen: Array<{ method: string; params: unknown }> = [];
      const result = await emitNegotiateBrief(
        { mePersonIdOverride: PERSON_ID },
        {
          db,
          notify: (method, params) => seen.push({ method, params }),
          sessionId: "e2e-negotiate",
          personalSources: [],
        },
      );
      expect(result).toEqual({ sessionId: "e2e-negotiate" });

      // Poll to a terminal notification rather than a fixed sleep — emitNegotiateBrief is
      // fire-and-forget, and a fixed wait is the classic CI flake on a slow runner.
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        if (
          seen.some(
            (s) => s.method === "negotiate.briefReady" || s.method === "negotiate.briefError",
          )
        ) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }

      // Zero HITL: `emitBriefWithSynthesis` calls `notify` exactly once, for the brief lifecycle
      // event, never for a consent/HITL side channel.
      expect(seen.map((s) => s.method)).toEqual(["negotiate.briefReady"]);

      const ready = seen.find((s) => s.method === "negotiate.briefReady");
      expect(ready).toBeDefined();
      const params: unknown = ready?.params;
      expect(isBriefReadyParams(params)).toBe(true);
      if (!isBriefReadyParams(params)) return;

      expect(params.brief.length).toBeGreaterThan(0);
      expect(params.findings.kind).toBe("negotiate");

      // The Markdown names the subject and the window — this is the artifact a person hands to
      // a manager; rendering without saying whose it is or what period it covers is unusable.
      expect(params.brief).toContain("**Subject:** you");
      expect(params.brief).toMatch(/_window: last \d+d/);

      // The seeded evidence is LOAD-BEARING: without these, every lane could come back `null`
      // (or the fixture's issue-before-PR ordering could silently break, which the comment on
      // `seedNegotiateEvidence` warns about) and this test would still pass, proving nothing.
      expect(params.brief).toContain("2 PR(s), 1 merged");
      expect(params.brief).toContain("stats coverage 1/2");
      expect(params.brief).toContain("1 review(s): 1 approved");
      expect(params.brief).toContain("1 opened, 1 closed by an authored PR");
      expect(params.brief).toContain("services: checkout");

      // Citations, end to end: the lanes must name the actual items behind their counts, not
      // just the counts. Asserted on the seeded titles specifically — a brief that printed
      // "2 PR(s)" with no way to check which two is the aggregate-only shape this replaced.
      expect(params.brief).toContain("Fix checkout button");
      expect(params.brief).toContain("Add checkout regression test");
      expect(params.brief).toContain("Review on acme/widgets#9");
      expect(params.brief).toContain("Checkout button unresponsive");

      // The absent-evidence note (spec § 5.D) is present UNCONDITIONALLY — on-call shifts and
      // deploys triggered do not exist in the index at all, and the brief names them on every
      // run so an empty section is never read as zero. Incidents resolved is no longer on this
      // list: PR 1 wired the `person --resolves--> incident` graph edge and the negotiate
      // `incidents` lane now measures it directly instead of declaring it unavailable.
      for (const term of UNAVAILABLE_EVIDENCE) {
        expect(params.brief).toContain(term);
      }

      // This fixture seeds NO PagerDuty data at all — no incidents, no `sync_state` row — so
      // it exercises the first of the honesty contract's four zeros (spec § 5.8): "no
      // PagerDuty connector at all". The lane must not render a bare `0 resolved, 0 assigned`
      // as if it were a real measurement; it must carry a named `missing_connector` gap note.
      expect(params.brief).toContain("No sync_state row for service `pagerduty`");

      // The fixture seeds NO Sentry data either — no error issues, no `sync_state` row — so
      // the sibling Sentry gap note fires alongside the PagerDuty one and must be asserted
      // too, not left to pass silently just because the brief happens to contain it.
      expect(params.brief).toContain("No sync_state row for service `sentry`");
    },
  );
});
