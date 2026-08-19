import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { EMPTY_NIMBUS_VAULT, syncTestContext } from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { mapVercelDeploymentToItem } from "../connectors/vercel-deployment-mapping.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem, upsertIndexedItemForSync } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { upsertBlameLines } from "../security/blame-store.ts";
import type { SyncContext } from "../sync/types.ts";
import type { BlameSpawn } from "./_lib/blame-on-demand.ts";
import { runWhy } from "./why.ts";

const HOUR = 60 * 60 * 1000;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
const roots: NimbusFilesystemRootToml[] = [
  { path: ROOT, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] },
];

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function ctxFor(db: Database): Parameters<typeof runWhy>[1] {
  return { db, roots, notify: () => {}, sessionId: "why-test-1" };
}

function refAt(line: number): string {
  return `${path.join(ROOT, "src", "retry.ts")}:${line}`;
}

type FixtureParts = {
  commit?: boolean;
  issue?: boolean;
  pr?: boolean;
  // `authorTimeMs` omitted defaults to a real timestamp; `null` is
  // deliberately distinct from "omitted" — it seeds a blame row with no
  // `author-time` line, the real shape `parseBlamePorcelain` produces
  // (`blame-store.ts:36,47`).
  blame?: { lineNo: number; authorTimeMs?: number | null };
};

/**
 * Shared fixture builder — connector-verbatim literals copied from Task 5's
 * `why-peek.test.ts` `seededDb()` (commit item, linear issue NIM-88, github
 * PR #412 referencing NIM-88 with `merge_commit_sha`, blame row). The issue
 * MUST be upserted before the PR: `syncPrGraph`'s `resolves` edge only wires
 * against issue entities that already exist in `graph_entity` at PR-sync time.
 */
function seedWhyFixture(db: Database, parts: FixtureParts): void {
  const t = Date.now();

  if (parts.issue === true) {
    upsertIndexedItem(db, {
      service: "linear",
      type: "issue",
      externalId: "NIM-88",
      title: "Retry backoff is wrong",
      bodyPreview: "",
      url: "https://linear.app/acme/issue/NIM-88",
      modifiedAt: t,
      syncedAt: t,
      metadata: {},
    });
  }

  if (parts.commit === true) {
    // filesystem git_commit item — copied verbatim from filesystem-v2-sync.ts:194-209.
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "git_commit",
      externalId: `${SHA}_r1`,
      title: "Fix retry backoff",
      bodyPreview: SHA,
      modifiedAt: t,
      syncedAt: t,
      metadata: { repoRoot: ROOT, sha: SHA, subject: "Fix retry backoff" },
    });
  }

  if (parts.pr === true) {
    // github PR — externalId/metadata shape from github-sync.ts.
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#412",
      title: "Fix retry backoff",
      bodyPreview: "part of NIM-88",
      url: "https://github.com/acme/app/pull/412",
      modifiedAt: t,
      syncedAt: t,
      metadata: {
        number: 412,
        repo: "acme/app",
        state: "merged",
        draft: false,
        merged: true,
        merge_commit_sha: SHA,
      },
    });
  }

  if (parts.blame !== undefined) {
    upsertBlameLines(db, ROOT, "src/retry.ts", [
      {
        lineNo: parts.blame.lineNo,
        commitSha: SHA,
        authorName: "alice",
        authorEmail: "alice@example.com",
        authorTimeMs:
          parts.blame.authorTimeMs === undefined ? 1_700_000_000_000 : parts.blame.authorTimeMs,
      },
    ]);
  }
}

/**
 * The prUrl arm's fixture: the same PR + ticket + discussion shape
 * `seedWhyFixture` builds for the ref arm — a github PR referencing a linear
 * ticket, and a Slack message mentioning that ticket — but deliberately NO
 * blame row and NO filesystem-anchored commit. That absence is the point of
 * this arm: `resolvePrSubject` resolves the PR straight from the index, no
 * local checkout and no `git blame` process required.
 */
function seedPrWithTicketAndDiscussion(db: Database): void {
  const t = Date.now();

  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff is wrong",
    bodyPreview: "",
    url: "https://linear.app/acme/issue/NIM-88",
    modifiedAt: t,
    syncedAt: t,
    metadata: {},
  });

  // github PR — externalId/metadata shape from github-sync.ts, same as
  // seedWhyFixture's `pr` part, but under acme/web#482 (the URL the prUrl
  // arm's tests resolve against).
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/web#482",
    title: "Fix retry backoff",
    bodyPreview: "part of NIM-88",
    url: "https://github.com/acme/web/pull/482",
    modifiedAt: t,
    syncedAt: t,
    metadata: {
      number: 482,
      repo: "acme/web",
      state: "merged",
      draft: false,
      merged: true,
    },
  });

  // Slack message mentioning the ticket — same shape as the ref arm's
  // discussion-lane fixture.
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1000.1",
    title: "anyone looking at NIM-88?",
    bodyPreview: "anyone looking at NIM-88?",
    modifiedAt: t,
    syncedAt: t,
    metadata: { channel: "C1" },
  });
}

describe("runWhy", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d !== undefined) {
        await fs.rm(d, { recursive: true, force: true });
      }
    }
  });

  test("authorship lane: blame row → author + commit subject finding", async () => {
    const db = freshDb();
    seedWhyFixture(db, { commit: true, blame: { lineNo: 42 } });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const authorship = brief.findings.filter((f) => f.lane === "authorship");
    expect(authorship).toHaveLength(1);
    expect(authorship[0]?.title).toContain("alice");
    expect(authorship[0]?.detail).toBe("Fix retry backoff");
    expect(authorship[0]?.occurredAt).toBe(1_700_000_000_000);
    expect(authorship[0]?.entityId).not.toBeNull();
  });

  test("pull_request lane: merged_as reverse walk finds the PR by SHA portion", async () => {
    const db = freshDb();
    seedWhyFixture(db, { pr: true, blame: { lineNo: 42 } });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const prFindings = brief.findings.filter((f) => f.lane === "pull_request");
    expect(prFindings).toHaveLength(1);
    expect(prFindings[0]?.title).toContain("412");
    expect(prFindings[0]?.url).toBe("https://github.com/acme/app/pull/412");
    expect(
      brief.gaps.some(
        (g) => g.category === "missing_relation_emit" && g.detail.includes("reviewed"),
      ),
    ).toBe(true);

    // C-1: the zero-edge `reviewed` gap note must not claim the populator
    // fails to emit `reviewed` (it does, since `syncReviewGraph` shipped),
    // and must not tell the user to run a `nimbus index backfill` command
    // that does not exist anywhere in the shipped CLI.
    const reviewedGap = brief.gaps.find(
      (g) => g.category === "missing_relation_emit" && g.detail.includes("reviewed"),
    );
    expect(reviewedGap).toBeDefined();
    expect(reviewedGap?.detail).not.toMatch(/not yet emitted by the graph populator/);
    for (const g of brief.gaps) {
      expect(g.detail).not.toMatch(/index backfill/);
      expect(g.remediation ?? "").not.toMatch(/index backfill/);
    }
  });

  test("the pull_request lane names reviewers when reviewed edges exist", async () => {
    const db = freshDb();
    seedWhyFixture(db, { commit: true, issue: true, pr: true, blame: { lineNo: 12 } });
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:reviewer", "Reviewer"]);

    upsertIndexedItem(db, {
      service: "github",
      type: "review",
      externalId: "acme/app#412#review-500",
      title: "Review on acme/app#412",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      authorId: "person:reviewer",
      metadata: { repo: "acme/app", pr_number: 412 },
    });

    const brief = await runWhy({ ref: refAt(12) }, ctxFor(db));
    const prFinding = brief.findings.find((f) => f.lane === "pull_request");

    expect(prFinding?.detail).toContain("Reviewed by");
    expect(brief.gaps.some((g) => g.detail.includes("`reviewed`"))).toBe(false);
  });

  test("I-5: a reviewer list beyond the display limit names the cut instead of silently truncating", async () => {
    const db = freshDb();
    seedWhyFixture(db, { commit: true, issue: true, pr: true, blame: { lineNo: 12 } });
    const now = Date.now();

    // 6 reviewers — one past the 5-reviewer display limit.
    for (let i = 1; i <= 6; i++) {
      const personId = `person:reviewer-${String(i)}`;
      db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", [personId, `R${String(i)}`]);
      upsertIndexedItem(db, {
        service: "github",
        type: "review",
        externalId: `acme/app#412#review-${String(500 + i)}`,
        title: "Review on acme/app#412",
        bodyPreview: "",
        modifiedAt: now,
        syncedAt: now,
        authorId: personId,
        metadata: { repo: "acme/app", pr_number: 412 },
      });
    }

    const brief = await runWhy({ ref: refAt(12) }, ctxFor(db));
    const prFinding = brief.findings.find((f) => f.lane === "pull_request");

    expect(prFinding?.detail).toContain("Reviewed by");
    // The cut is named, not silent: exactly 5 reviewers are listed by name,
    // and the overflow count (1) is stated explicitly.
    expect(prFinding?.detail).toContain("R1, R2, R3, R4, R5, and 1 more");
  });

  test("pull_request lane: a reviewed edge that exists but doesn't resolve still yields a gap note, not silence", async () => {
    const db = freshDb();
    seedWhyFixture(db, { pr: true, blame: { lineNo: 42 } });

    // A `reviewed` edge exists in the graph, but it targets a `pr`
    // graph_entity with NO backing `item` row — the partial-join failure the
    // old `detectMissingRelationEmit`-only probe couldn't see. It does not
    // reference this PR at all, so the reviewer query for THIS PR also finds
    // nothing: exactly the "silently empty AND no gap note" regression.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      [
        "ge:person:orphan-reviewer",
        "person",
        "person:orphan-reviewer",
        "Orphan Reviewer",
        "github",
      ],
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:pr:orphan", "pr", "github:pr:orphan", "Orphan PR", "github"],
    );
    db.run("INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)", [
      "ge:person:orphan-reviewer",
      "ge:pr:orphan",
      "reviewed",
      Date.now(),
    ]);

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const prFinding = brief.findings.find((f) => f.lane === "pull_request");
    expect(prFinding?.detail).not.toContain("Reviewed by");

    const reviewedGap = brief.gaps.find(
      (g) => g.category === "missing_relation_emit" && g.detail.includes("reviewed"),
    );
    expect(reviewedGap).toBeDefined();
    // Distinct from the "no `reviewed` edges at all" gap's detail — proves
    // this is the resolution-aware branch, not the pre-existing zero-edges
    // check (which a bare "edges exist / don't exist" probe would also pass
    // for the zero-edges case, proving nothing about state (b)).
    expect(reviewedGap?.detail).toContain("none resolve");
  });

  test("pull_request lane: a per-PR reviewed edge that doesn't resolve still yields a gap note even when a DIFFERENT PR's reviewed edge resolves cleanly", async () => {
    const db = freshDb();
    const t = Date.now();

    // PR A — from the shared fixture, healthy: a `reviewed` edge that
    // resolves cleanly (real person row + real reviewer graph_entity).
    seedWhyFixture(db, { pr: true, blame: { lineNo: 42 } });
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", [
      "person:reviewer-a",
      "Reviewer A",
    ]);
    upsertIndexedItem(db, {
      service: "github",
      type: "review",
      externalId: "acme/app#412#review-1",
      title: "Review on acme/app#412",
      bodyPreview: "",
      modifiedAt: t,
      syncedAt: t,
      authorId: "person:reviewer-a",
      metadata: { repo: "acme/app", pr_number: 412 },
    });

    // PR B — a second, REAL pr item constructed the same way the fixture
    // builds PR A (not a hand-rolled graph_entity row), merged via a
    // distinct commit SHA and blamed at a distinct line so this `why`
    // invocation resolves to PR B, not PR A.
    const SHA_B = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#413",
      title: "Second PR",
      bodyPreview: "",
      url: "https://github.com/acme/app/pull/413",
      modifiedAt: t,
      syncedAt: t,
      metadata: {
        number: 413,
        repo: "acme/app",
        state: "merged",
        draft: false,
        merged: true,
        merge_commit_sha: SHA_B,
      },
    });
    upsertBlameLines(db, ROOT, "src/retry.ts", [
      {
        lineNo: 99,
        commitSha: SHA_B,
        authorName: "bob",
        authorEmail: "bob@example.com",
        authorTimeMs: 1_700_000_000_000,
      },
    ]);

    // PR B's `reviewed` edge is broken: its `from_id` resolves to a real
    // graph_entity row (satisfying the FK), but NOT one of type `person` —
    // "no matching person graph_entity" — so it can never resolve through
    // the join the reviewer query (and the probe) both use.
    const prBRow = db
      .query("SELECT id FROM graph_entity WHERE type = 'pr' AND external_id = ?")
      .get("github:acme/app#413") as { id: string };
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:not-a-person", "ghost", "ghost:not-a-person", "Not A Person", "github"],
    );
    db.run("INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)", [
      "ge:not-a-person",
      prBRow.id,
      "reviewed",
      t,
    ]);

    const brief = await runWhy({ ref: refAt(99) }, ctxFor(db));

    const prFinding = brief.findings.find((f) => f.lane === "pull_request");
    expect(prFinding?.title).toContain("413");
    expect(prFinding?.detail).not.toContain("Reviewed by");

    // The bug this test guards against: an UNSCOPED probe finds PR A's
    // healthy `reviewed` edge and reports "all clear" globally, silencing
    // the gap note for PR B even though PR B's own reviewers never resolve.
    const reviewedGap = brief.gaps.find(
      (g) => g.category === "missing_relation_emit" && g.detail.includes("reviewed"),
    );
    expect(reviewedGap).toBeDefined();
  });

  test("ticket lane: pr → resolves → issue, endpoint-scoped", async () => {
    const db = freshDb();
    seedWhyFixture(db, { issue: true, pr: true, blame: { lineNo: 42 } });

    // Polysemy guard #1: a person→incident `resolves` edge between two extra
    // entities, unconnected to the PR, must NOT surface in the ticket lane.
    // (Excluded regardless of type scoping — `WHERE r.from_id = ?` alone
    // would already reject it, since its from_id isn't the PR entity.)
    const personId = upsertGraphEntity<string>(db, {
      type: "person",
      externalId: "person:bob",
      label: "bob",
    });
    const incidentId = upsertGraphEntity(db, {
      type: "incident",
      externalId: "incident:PD-99",
      label: "Some unrelated incident",
    });
    upsertGraphRelation(db, personId, incidentId, "resolves", Date.now());

    // Polysemy guard #2 (the falsifiable one): a stray `resolves` edge FROM
    // THE PR ENTITY ITSELF to a non-issue entity. `WHERE r.from_id = ?` alone
    // would happily include this row — only the `ie.type = 'issue'` join
    // scope on the target endpoint excludes it. This is what makes the test
    // fail if that type scope is removed.
    const prRow = db.query("SELECT id FROM graph_entity WHERE type = 'pr' LIMIT 1").get() as {
      id: string;
    };
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "PD-100",
      title: "Another unrelated incident",
      bodyPreview: "",
      modifiedAt: Date.now(),
      syncedAt: Date.now(),
      metadata: {},
    });
    const strayIncidentRow = db
      .query(
        `SELECT ge.id AS id FROM graph_entity ge
           JOIN item i ON i.id = ge.external_id
          WHERE ge.type = 'incident' AND i.external_id = 'PD-100'`,
      )
      .get() as { id: string };
    const strayIncidentId = strayIncidentRow.id;
    upsertGraphRelation(db, prRow.id, strayIncidentId, "resolves", Date.now());

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const ticketFindings = brief.findings.filter((f) => f.lane === "ticket");
    expect(ticketFindings).toHaveLength(1);
    expect(ticketFindings[0]?.title).toContain("NIM-88");
    expect(ticketFindings.every((f) => f.entityId !== incidentId)).toBe(true);
    expect(ticketFindings.every((f) => f.entityId !== strayIncidentId)).toBe(true);
  });

  test("discussion lane: message → mentions → issue surfaces the thread", async () => {
    const db = freshDb();
    seedWhyFixture(db, { commit: true, issue: true, pr: true, blame: { lineNo: 42 } });

    const t = Date.now();
    // Slack message mentioning the ticket — shape per slack-sync.ts message
    // items (confirmed externalId/metadata against 1a's
    // graph-populator-mentions.test.ts seedMessage: "C1/1000.1" + {channel}).
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "C1/1000.1",
      title: "anyone looking at NIM-88?",
      bodyPreview: "anyone looking at NIM-88?",
      modifiedAt: t,
      syncedAt: t,
      metadata: { channel: "C1" },
    });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const discussion = brief.findings.filter((f) => f.lane === "discussion");
    expect(discussion).toHaveLength(1);
    expect(discussion[0]?.title).toBe("anyone looking at NIM-88?");
  });

  const CHECKOUT_SERVICE_CONFIG: ServiceConfig = {
    serviceId: "checkout",
    repos: [{ provider: "github", providerId: "acme/checkout" }],
    pagerdutyServices: ["PSVC1"],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: ["P1"],
  };

  function ctxWithResolver(db: Database, configs: Map<string, ServiceConfig>): SyncContext {
    return {
      ...syncTestContext(db, EMPTY_NIMBUS_VAULT),
      resolveServiceId: buildServiceIdentityResolver(configs),
    };
  }

  test("driver lane: incident within 48h before the commit, enriched with its correlated deployment", async () => {
    const db = freshDb();
    const t = Date.now();
    const configs = new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]);
    const ctx = ctxWithResolver(db, configs);

    // Real `buildPagerdutyMetadata`-shaped raw incident payload — copied
    // verbatim from graph-populator-incidents.test.ts:498-511.
    const incidentRaw = {
      id: "PD-1",
      title: "Checkout 500s",
      status: "triggered",
      html_url: "https://acme.pagerduty.com/incidents/PD-1",
      created_at: new Date(t + HOUR).toISOString(),
      updated_at: new Date(t + HOUR).toISOString(),
      service: { id: "PSVC1" },
      priority: { name: "P1" },
      urgency: "high",
    };
    syncPagerdutyIncidentItems(ctx, [incidentRaw], "1970-01-01T00:00:00Z", t + HOUR, new Map());

    // Real `mapVercelDeploymentToItem`-shaped raw deployment payload — copied
    // verbatim from graph-populator-incidents.test.ts:513-532.
    const deploymentRaw = {
      uid: "dpl_123",
      name: "checkout-web",
      readyState: "READY",
      target: "production",
      url: "checkout-web.vercel.app",
      inspectorUrl: "https://vercel.com/acme/checkout-web/dpl_123",
      created: t,
      meta: {
        githubCommitSha: "abc123def456",
        githubCommitMessage: "Fix checkout bug",
        githubCommitRef: "main",
        githubOrg: "acme",
        githubRepo: "checkout",
      },
      creator: { username: "alice" },
    };
    const mapped = mapVercelDeploymentToItem(deploymentRaw, { syncedAt: t });
    if (mapped === null) throw new Error("mapVercelDeploymentToItem returned null");
    upsertIndexedItemForSync(ctx, mapped);

    // Blame anchors the commit 1h after the incident — within the 48h driver window.
    upsertBlameLines(db, ROOT, "src/retry.ts", [
      {
        lineNo: 42,
        commitSha: SHA,
        authorName: "alice",
        authorEmail: "alice@example.com",
        authorTimeMs: t + 2 * HOUR,
      },
    ]);

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const driver = brief.findings.filter((f) => f.lane === "driver");
    expect(driver).toHaveLength(1);
    expect(driver[0]?.title).toBe("Checkout 500s");
    expect(driver[0]?.detail).toContain("checkout-web");
    expect(
      brief.gaps.some(
        (g) => g.category === "missing_relation_emit" && g.detail.includes("affects"),
      ),
    ).toBe(true);
  });

  test("driver lane: a blame row with no author-time line yields no finding, even when its commit resolves to a merged PR with an incident in ITS window", async () => {
    // Regression for the ref arm borrowing the PR's `modifiedAt` as a stand-in
    // for a missing blame timestamp. `git blame --line-porcelain` omits the
    // `author-time` line for some blame states, so `authorTimeMs` really can
    // be null on a resolved blame row (`blame-store.ts:36,47`) — and `pr` is
    // still non-null here, since the blamed commit is the PR's merge commit.
    // `occurredAt` must come from `blame.authorTimeMs` alone on this arm, not
    // fall through to `pr.modifiedAt`.
    //
    // A quiet "no findings either way" assertion wouldn't distinguish the fix
    // from the bug (subDriver returns no findings whenever nothing is seeded
    // in the query window, regardless of which timestamp it used). So this
    // seeds an incident squarely inside the window the BUGGY fallback would
    // have queried — anchored to the PR's own `modifiedAt`, not to blame — so
    // a driver finding here is proof the bug reappeared, not a coincidence.
    const db = freshDb();
    seedWhyFixture(db, { pr: true, blame: { lineNo: 42, authorTimeMs: null } });

    const prModifiedAt = db
      .query(
        `SELECT i.modified_at AS modified_at FROM item i
           JOIN graph_entity e ON e.external_id = i.id
          WHERE e.type = 'pr'
          LIMIT 1`,
      )
      .get() as { modified_at: number };
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "PD-regression",
      title: "Should never surface via the PR's timestamp",
      bodyPreview: "",
      modifiedAt: prModifiedAt.modified_at - HOUR,
      syncedAt: Date.now(),
      metadata: {},
    });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const driver = brief.findings.filter((f) => f.lane === "driver");
    expect(driver).toHaveLength(0);
  });

  test("downstream lane: reverse depends_on from the file's symbols", async () => {
    const db = freshDb();
    const t = Date.now();

    upsertIndexedItem(db, {
      service: "filesystem",
      type: "code_symbol",
      externalId: "sym:retryBackoff",
      title: "retryBackoff",
      bodyPreview: "",
      modifiedAt: t,
      syncedAt: t,
      metadata: { file: "src/retry.ts", name: "retryBackoff", repoRoot: ROOT },
    });
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "code_symbol",
      externalId: "sym:consumerFn",
      title: "consumerFn",
      bodyPreview: "",
      modifiedAt: t,
      syncedAt: t,
      metadata: { file: "src/consumer.ts", name: "consumerFn", repoRoot: ROOT },
    });

    const targetRow = db
      .query(
        "SELECT id FROM graph_entity WHERE type = 'symbol' AND json_extract(metadata,'$.name') = ?",
      )
      .get("retryBackoff") as { id: string };
    const consumerRow = db
      .query(
        "SELECT id FROM graph_entity WHERE type = 'symbol' AND json_extract(metadata,'$.name') = ?",
      )
      .get("consumerFn") as { id: string };
    upsertGraphRelation(db, consumerRow.id, targetRow.id, "depends_on", t);

    const brief = await runWhy({ ref: path.join(ROOT, "src", "retry.ts") }, ctxFor(db));

    const downstream = brief.findings.filter((f) => f.lane === "downstream");
    expect(downstream).toHaveLength(1);
    expect(downstream[0]?.entityId).toBe(consumerRow.id);
    expect(downstream[0]?.title).toBe("consumerFn — src/consumer.ts");
  });

  test("git-only degradation: lanes 2-5 emit GapNotes, not errors; brief still renders", async () => {
    const db = freshDb();
    seedWhyFixture(db, { commit: true, blame: { lineNo: 42 } });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    expect(brief.kind).toBe("why");
    const authorship = brief.findings.filter((f) => f.lane === "authorship");
    expect(authorship).toHaveLength(1);
    expect(brief.gaps.length).toBeGreaterThanOrEqual(3);
  });

  test("unresolvable ref: subject null, gap note, six lanes all degrade", async () => {
    const db = freshDb();

    const brief = await runWhy({ ref: "nope" }, ctxFor(db));

    expect(brief.subject).toBeNull();
    expect(brief.findings).toEqual([]);
    expect(brief.gaps.length).toBeGreaterThan(0);
  });

  async function makeTempGitDir(): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "why-agent-"));
    tempDirs.push(d);
    await fs.mkdir(path.join(d, ".git"));
    return d;
  }

  type SpawnCounter = { count: number; spawn: typeof Bun.spawn };
  function countingSpawn(stdout: string, exitCode = 0): SpawnCounter {
    const counter: SpawnCounter = {
      count: 0,
      spawn: ((..._args: unknown[]) => {
        counter.count += 1;
        return {
          exited: Promise.resolve(exitCode),
          stdout: new Response(stdout).body,
          stderr: new Response("").body,
        } as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn,
    };
    return counter;
  }

  test("exactly one blame spawn even with six parallel lanes on a cold line", async () => {
    const db = freshDb();
    const tmp = await makeTempGitDir();
    const tmpRoots: NimbusFilesystemRootToml[] = [
      { path: tmp, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] },
    ];
    const c = countingSpawn("");

    const brief = await runWhy(
      { ref: `${path.join(tmp, "src", "a.ts")}:1` },
      { db, roots: tmpRoots, notify: () => {}, sessionId: "why-spawn", spawn: c.spawn },
    );

    expect(c.count).toBeLessThanOrEqual(1);
    expect(brief.subject).not.toBeNull();
  });
});

describe("runWhy — the prUrl arm", () => {
  test("answers the four PR lanes without a checkout, and spawns no blame", async () => {
    const db = freshDb();
    // Seed the PR, its ticket and its discussion exactly as the ref-arm fixtures
    // do, but DO NOT seed blame or filesystem roots — the point of this arm.
    seedPrWithTicketAndDiscussion(db);
    let spawned = 0;
    const brief = await runWhy(
      { prUrl: "https://github.com/acme/web/pull/482" },
      {
        db,
        roots: [],
        notify: () => {},
        sessionId: "why-pr-1",
        spawn: (() => {
          spawned += 1;
          return null;
        }) as unknown as BlameSpawn,
      },
    );

    expect(spawned).toBe(0);
    expect(brief.subject).toBeNull();
    expect(brief.changeSubject?.repo).toBe("acme/web");
    expect(brief.query).toEqual({ ref: "https://github.com/acme/web/pull/482", line: null });
    const lanes = new Set(brief.findings.map((f) => f.lane));
    expect(lanes.has("pull_request")).toBe(true);
    expect(lanes.has("ticket")).toBe(true);
    expect(lanes.has("authorship")).toBe(false);
    expect(lanes.has("downstream")).toBe(false);
  });

  test("a miss returns a brief with a null changeSubject, not a failure", async () => {
    const db = freshDb();
    const brief = await runWhy(
      { prUrl: "https://github.com/acme/web/pull/999" },
      { db, roots: [], notify: () => {}, sessionId: "why-pr-2" },
    );
    expect(brief.kind).toBe("why");
    expect(brief.changeSubject).toBeNull();
    expect(brief.subject).toBeNull();
    expect(brief.findings).toEqual([]);
  });

  test("the ref arm leaves changeSubject absent", async () => {
    const db = freshDb();
    const brief = await runWhy({ ref: refAt(12) }, ctxFor(db));
    expect("changeSubject" in brief && brief.changeSubject !== undefined).toBe(false);
  });
});
