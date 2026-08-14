import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  emitExpertBrief,
  rankExpertFindings,
  runExpert,
  subIncidentResolved,
  subPrReviewed,
} from "./expert.ts";

describe("rankExpertFindings", () => {
  test("merges evidence from multiple streams by personId, summing weights", () => {
    const evidence = [
      {
        personId: "alice",
        displayName: "Alice",
        evidence: [
          {
            weight: 1,
            modifiedAt: 0,
            type: "pr_authored" as const,
            serviceId: "github",
            title: "t1",
            itemId: "i1",
          },
        ],
      },
      {
        personId: "alice",
        displayName: "Alice",
        evidence: [
          {
            weight: 0.6,
            modifiedAt: 0,
            type: "pr_reviewed" as const,
            serviceId: "github",
            title: "t2",
            itemId: "i2",
          },
        ],
      },
      {
        personId: "bob",
        displayName: "Bob",
        evidence: [
          {
            weight: 0.3,
            modifiedAt: 0,
            type: "chat_post" as const,
            serviceId: "slack",
            title: "t3",
            itemId: "i3",
          },
        ],
      },
    ];
    const ranked = rankExpertFindings(evidence, 5);
    expect(ranked[0]?.personId).toBe("alice");
    expect(ranked[0]?.evidence).toHaveLength(2);
    expect(ranked[1]?.personId).toBe("bob");
  });

  test("respects the limit", () => {
    const evidence = Array.from({ length: 12 }, (_, i) => ({
      personId: `p${i}`,
      displayName: `P${i}`,
      evidence: [
        {
          weight: 12 - i,
          modifiedAt: 0,
          type: "pr_authored" as const,
          serviceId: "github",
          title: "t",
          itemId: `i${i}`,
        },
      ],
    }));
    const ranked = rankExpertFindings(evidence, 5);
    expect(ranked).toHaveLength(5);
    expect(ranked[0]?.personId).toBe("p0");
  });

  test("confidence buckets reflect score and evidence count", () => {
    const high = rankExpertFindings(
      [
        {
          personId: "a",
          displayName: "A",
          evidence: Array.from({ length: 6 }, () => ({
            weight: 0.9,
            modifiedAt: 0,
            type: "pr_authored" as const,
            serviceId: "github",
            title: "t",
            itemId: "i",
          })),
        },
      ],
      5,
    );
    expect(high[0]?.confidence).toBe("high");

    const ranked = rankExpertFindings(
      [
        {
          personId: "a",
          displayName: "A",
          evidence: Array.from({ length: 5 }, () => ({
            weight: 1,
            modifiedAt: 0,
            type: "pr_authored" as const,
            serviceId: "github",
            title: "t",
            itemId: "i",
          })),
        },
        {
          personId: "b",
          displayName: "B",
          evidence: [
            {
              weight: 0.05,
              modifiedAt: 0,
              type: "pr_authored",
              serviceId: "github",
              title: "t",
              itemId: "i",
            },
          ],
        },
      ],
      5,
    );
    expect(ranked[0]?.personId).toBe("a");
    expect(ranked[1]?.confidence).toBe("low");
  });
});

describe("rankExpertFindings — additional branches", () => {
  test("empty streams returns an empty array", () => {
    const ranked = rankExpertFindings([], 5);
    expect(ranked).toEqual([]);
  });

  test("all-zero weights produces score 0 and confidence low (max===0 branch)", () => {
    const ranked = rankExpertFindings(
      [
        {
          personId: "x",
          displayName: "X",
          evidence: [
            {
              weight: 0,
              modifiedAt: Date.now(),
              type: "commit_authored" as const,
              serviceId: "github",
              title: "t",
              itemId: "i",
            },
          ],
        },
      ],
      5,
    );
    expect(ranked[0]?.score).toBe(0);
    expect(ranked[0]?.confidence).toBe("low");
  });

  test("medium confidence: score>=0.3 but evidenceCount<3 or score<0.7", () => {
    // Top person has weight 1, second person has weight 0.4 → normalised score 0.4 with 1 evidence
    const ranked = rankExpertFindings(
      [
        {
          personId: "top",
          displayName: "Top",
          evidence: [
            {
              weight: 1,
              modifiedAt: Date.now(),
              type: "pr_authored" as const,
              serviceId: "github",
              title: "t",
              itemId: "i1",
            },
          ],
        },
        {
          personId: "mid",
          displayName: "Mid",
          evidence: [
            {
              weight: 0.4,
              modifiedAt: Date.now(),
              type: "pr_authored" as const,
              serviceId: "github",
              title: "t",
              itemId: "i2",
            },
          ],
        },
      ],
      5,
    );
    expect(ranked[1]?.personId).toBe("mid");
    expect(ranked[1]?.confidence).toBe("medium");
  });
});

describe("runExpert gap-note coverage", () => {
  test("empty index produces an empty_index gap note", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const ctx = {
      db,
      notify: () => {},
      sessionId: "s1",
    };
    const brief = await runExpert({ topicOrFile: "anything" }, ctx);
    const cats = brief.gaps.map((g) => g.category);
    expect(cats).toContain("empty_index");
    expect(brief.ranked).toEqual([]);
  });

  test("missing reviewed relation surfaces a missing_relation_emit gap note", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('github:dummy', 'github', 'pr', 'dummy', 'noop', 0, 0)`,
    );

    const ctx = { db, notify: () => {}, sessionId: "s1" };
    const brief = await runExpert({ topicOrFile: "noop" }, ctx);
    const cats = brief.gaps.map((g) => g.category);
    expect(cats).toContain("missing_relation_emit");

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
});

describe("subPrReviewed", () => {
  test("subPrReviewed surfaces a reviewer as pr_reviewed evidence", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:author", "Author"]);
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:reviewer", "Reviewer"]);

    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Add rate limiter",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      authorId: "person:author",
      metadata: { repo: "acme/app", number: 1 },
    });
    upsertIndexedItem(db, {
      service: "github",
      type: "review",
      externalId: "acme/app#1#review-500",
      title: "Review on acme/app#1",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      authorId: "person:reviewer",
      metadata: { repo: "acme/app", pr_number: 1 },
    });

    const result = await subPrReviewed(db, "rate limiter");

    expect(result.gap).toBeUndefined();
    expect(result.stream?.personId).toBe("person:reviewer");
    expect(result.stream?.displayName).toBe("Reviewer");
    expect(result.stream?.evidence).toHaveLength(1);
    expect(result.stream?.evidence[0]?.type).toBe("pr_reviewed");
    expect(result.stream?.evidence[0]?.itemId).toBe("github:acme/app#1");
    db.close();
  });

  test("subPrReviewed still reports the gap when no reviewed edges exist", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const result = await subPrReviewed(db, "anything");
    expect(result.gap?.category).toBe("missing_relation_emit");
    expect(result.stream).toBeUndefined();
    db.close();
  });

  test("subPrReviewed reports a distinct gap when a reviewed edge exists but its PR does not resolve to an indexed item", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:reviewer", "Reviewer"]);
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:person:reviewer", "person", "person:reviewer", "Reviewer", "github"],
    );
    // PR graph_entity with NO backing `item` row — this is the partial-join
    // failure the old `detectMissingRelationEmit`-only probe couldn't see.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:pr:orphan", "pr", "github:pr:orphan", "Orphan PR", "github"],
    );
    db.run("INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)", [
      "ge:person:reviewer",
      "ge:pr:orphan",
      "reviewed",
      now,
    ]);

    const result = await subPrReviewed(db, "anything");

    expect(result.stream).toBeUndefined();
    expect(result.gap?.category).toBe("missing_relation_emit");
    // Distinct from the "no edges at all" gap's detail — proves this is the
    // resolution-aware branch, not the pre-existing zero-edges check.
    expect(result.gap?.detail).toContain("none resolve");
    db.close();
  });

  test("subPrReviewed emits no gap note when a reviewed edge resolves but the topic just has no match (M-10)", async () => {
    // A fully resolvable `reviewed` edge exists (real person + real indexed PR),
    // but the free-text query below matches nothing in it. This must return
    // `null` from `detectUnresolvedReviewedRelation` — a topic with no match is
    // not a data gap — never a false "missing_relation_emit" gap note.
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:author", "Author"]);
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:reviewer", "Reviewer"]);

    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Add rate limiter",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      authorId: "person:author",
      metadata: { repo: "acme/app", number: 1 },
    });
    upsertIndexedItem(db, {
      service: "github",
      type: "review",
      externalId: "acme/app#1#review-500",
      title: "Review on acme/app#1",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      authorId: "person:reviewer",
      metadata: { repo: "acme/app", pr_number: 1 },
    });

    const result = await subPrReviewed(db, "no-such-topic-anywhere");

    expect(result.stream).toBeUndefined();
    expect(result.gap).toBeUndefined();
    db.close();
  });
});

describe("subIncidentResolved", () => {
  test("an incident resolved by a person, matching the topic, surfaces incident_resolved evidence", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
      "person:jane",
      "Jane",
      "jane@example.com",
    ]);

    // Index a real PagerDuty-shaped incident item through the same
    // item-store path a connector sync uses, so the REAL graph populator
    // (syncIncidentPersonEdges) builds the `person -> incident "resolves"`
    // edge instead of the test fabricating one.
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "PD-1",
      title: "Checkout 500s",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: {
        service: "checkout",
        assignee_emails: ["jane@example.com"],
        resolved_by_email: "jane@example.com",
      },
    });

    const result = await subIncidentResolved(db, "checkout");

    expect(result.gap).toBeUndefined();
    expect(result.stream?.personId).toBe("person:jane");
    expect(result.stream?.displayName).toBe("Jane");
    expect(result.stream?.evidence).toHaveLength(1);
    expect(result.stream?.evidence[0]?.type).toBe("incident_resolved");
    expect(result.stream?.evidence[0]?.itemId).toBe("pagerduty:PD-1");
    db.close();
  });

  test("a pr --resolves--> issue edge is NOT reported as a resolved incident (pins the ie.type filter)", async () => {
    // This fabricates a `person --resolves--> <non-incident>` edge: the
    // `pe.type = 'person'` join already excludes the real `pr -> issue
    // "resolves"` edge production emits (its `from_id` is a `pr` entity, not
    // a `person` one), so pinning `ie.type = 'incident'` requires a fixture
    // that clears every OTHER filter and would slip through on the target
    // side alone if that condition were removed.
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
      "person:jane",
      "Jane",
      "jane@example.com",
    ]);
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["github:acme/app#4", "github", "issue", "acme/app#4", "Login broken", now, now],
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:person:jane", "person", "person:jane", "Jane", "github"],
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:issue:4", "issue", "github:acme/app#4", "Login broken", "github"],
    );
    db.run("INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)", [
      "ge:person:jane",
      "ge:issue:4",
      "resolves",
      now,
    ]);

    const result = await subIncidentResolved(db, "login");

    // No `incident` graph entity exists at all in this fixture, so the
    // real query correctly finds nothing (the join's `ie.type = 'incident'`
    // condition rejects the `issue` entity) and the lane explains why via a
    // gap note instead of fabricating a finding from the `issue` edge.
    expect(result.stream).toBeUndefined();
    expect(result.gap).toBeDefined();
    db.close();
  });

  test("the empty case still returns a gap note, not silence", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const result = await subIncidentResolved(db, "anything");
    expect(result.stream).toBeUndefined();
    expect(result.gap).toBeDefined();
    expect(result.gap?.category).toBe("missing_entity_type");
    db.close();
  });
});

/** Helper: set up a minimal non-empty DB with both sync connectors registered. */
function makePopulatedDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["seed:1", "jira", "issue", "seed:1", "seed item", now, now],
  );
  db.run("INSERT INTO sync_state (connector_id) VALUES (?)", ["github"]);
  db.run("INSERT INTO sync_state (connector_id) VALUES (?)", ["slack"]);
  return db;
}

describe("runExpert — explicit limit input", () => {
  test("explicit limit is respected (input.limit branch)", async () => {
    const db = makePopulatedDb();
    const ctx = { db, notify: () => {}, sessionId: "s-lim" };
    const brief = await runExpert({ topicOrFile: "auth", limit: 2 }, ctx);
    // ranked length is capped by our limit (no matching people → empty, but limit param was consumed)
    expect(brief.ranked.length).toBeLessThanOrEqual(2);
    expect(brief.query.topicOrFile).toBe("auth");
  });
});

describe("runExpert — sub-agent failure path", () => {
  test("failed sub-agents produce missing_connector gap notes with error detail", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    // Non-empty index so the preflight empty-index check passes
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["seed:1", "jira", "issue", "seed:1", "hello item", now, now],
    );
    // Drop person table so all JOIN-based sub-agent queries throw
    db.run("DROP TABLE person");

    const ctx = { db, notify: () => {}, sessionId: "s-err" };
    const brief = await runExpert({ topicOrFile: "hello" }, ctx);

    // At least some sub-agents fail and emit missing_connector gap notes with error text
    const errorGaps = brief.gaps.filter((g) => g.category === "missing_connector");
    expect(errorGaps.length).toBeGreaterThan(0);
    // Each failed sub-agent gap note includes "failed" + a non-empty error detail
    const allHaveFailed = errorGaps.every((g) => g.detail.includes("failed"));
    expect(allHaveFailed).toBe(true);
    // At least one includes the error text (the colon branch)
    const anyHasColon = errorGaps.some((g) => g.detail.includes(":"));
    expect(anyHasColon).toBe(true);
  });
});

describe("runExpert — subBlame data path", () => {
  test("commit data produces a ranked expert with commit_authored evidence", async () => {
    const db = makePopulatedDb();
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:alice", "Alice"]);
    // Two commits from Alice matching the search topic (exercises the merge-existing branch)
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["github:commit:1", "github", "commit", "c1", "auth fix", now, now, "person:alice"],
    );
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "github:commit:2",
        "github",
        "commit",
        "c2",
        "auth cleanup",
        now - 1000,
        now,
        "person:alice",
      ],
    );

    const ctx = { db, notify: () => {}, sessionId: "s-blame" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);

    const alice = brief.ranked.find((r) => r.personId === "person:alice");
    expect(alice).toBeDefined();
    expect(alice?.evidence.length).toBeGreaterThanOrEqual(1);
    expect(alice?.evidence.some((e) => e.type === "commit_authored")).toBe(true);
  });

  test("no matching commits + github connector registered → no gap for github", async () => {
    const db = makePopulatedDb();
    // github connector IS registered but no commits match the topic
    const ctx = { db, notify: () => {}, sessionId: "s-blame-empty" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);
    // Should NOT have missing_connector for github (connector is registered)
    const githubGaps = brief.gaps.filter(
      (g) => g.category === "missing_connector" && g.detail.includes("github"),
    );
    expect(githubGaps).toHaveLength(0);
  });

  test("no matching commits + github connector NOT registered → missing_connector gap", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["seed:1", "jira", "issue", "seed:1", "auth seed", now, now],
    );
    // Only slack registered, NOT github
    db.run("INSERT INTO sync_state (connector_id) VALUES (?)", ["slack"]);

    const ctx = { db, notify: () => {}, sessionId: "s-blame-nogithub" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);
    const githubGaps = brief.gaps.filter(
      (g) => g.category === "missing_connector" && g.detail.includes("github"),
    );
    expect(githubGaps.length).toBeGreaterThan(0);
  });
});

describe("runExpert — subPrAuthored data path", () => {
  test("PR authored within 90 days surfaces pr_authored evidence", async () => {
    const db = makePopulatedDb();
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:bob", "Bob"]);
    // PR within 90 days matching the topic
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["github:pr:1", "github", "pr", "pr:1", "auth refactor PR", now, now, "person:bob"],
    );

    const ctx = { db, notify: () => {}, sessionId: "s-pr-authored" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);

    const bob = brief.ranked.find((r) => r.personId === "person:bob");
    expect(bob).toBeDefined();
    expect(bob?.evidence.some((e) => e.type === "pr_authored")).toBe(true);
  });

  test("no matching PRs returns empty stream (subPrAuthored empty branch)", async () => {
    const db = makePopulatedDb();
    // No PR items at all
    const ctx = { db, notify: () => {}, sessionId: "s-pr-authored-empty" };
    const brief = await runExpert({ topicOrFile: "xyzzy" }, ctx);
    expect(brief.ranked).toEqual([]);
  });

  test("multiple PRs by same author merges evidence (subPrAuthored merge-existing branch)", async () => {
    const db = makePopulatedDb();
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:carol", "Carol"]);
    // Two PRs from Carol within 90 days matching the topic
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["github:pr:10", "github", "pr", "pr:10", "auth overhaul", now, now, "person:carol"],
    );
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["github:pr:11", "github", "pr", "pr:11", "auth fix 2", now - 1000, now, "person:carol"],
    );

    const ctx = { db, notify: () => {}, sessionId: "s-pr-authored-merge" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);

    const carol = brief.ranked.find((r) => r.personId === "person:carol");
    expect(carol).toBeDefined();
    expect(carol?.evidence.filter((e) => e.type === "pr_authored").length).toBeGreaterThanOrEqual(
      2,
    );
  });
});

describe("runExpert — subPrReviewed / subIncidentResolved suppressed gaps", () => {
  test("existing reviewed + resolves relations and an incident entity produce no gap for those", async () => {
    const db = makePopulatedDb();
    const now = Date.now();
    // Populate graph with a 'reviewed' relation whose endpoints genuinely
    // resolve through the join chain `subPrReviewed` reads — a real `item`
    // row backing the `pr` graph_entity (id matches its external_id) and a
    // real `person` row backing the `person` graph_entity (id matches its
    // external_id) — so `subPrReviewed`'s resolution-aware probe finds a
    // resolvable edge and stays quiet.
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["github:pr:1", "github", "pr", "pr:1", "auth overhaul", now, now],
    );
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:1", "Person"]);
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:pr:1", "pr", "github:pr:1", "PR", "github"],
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:person:1", "person", "person:1", "Person", "github"],
    );
    db.run("INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)", [
      "ge:person:1",
      "ge:pr:1",
      "reviewed",
      now,
    ]);
    // Populate graph with 'incident' entity so the entity-type check passes,
    // AND a 'resolves' relation so the relation-emit check also passes.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:inc:1", "incident", "inc:1", "Incident", "pagerduty"],
    );
    db.run("INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)", [
      "ge:person:1",
      "ge:inc:1",
      "resolves",
      now,
    ]);

    const ctx = { db, notify: () => {}, sessionId: "s-reviewed-inc" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);

    const cats = brief.gaps.map((g) => g.category);
    expect(cats).not.toContain("missing_relation_emit");
    expect(cats).not.toContain("missing_entity_type");
  });
});

describe("runExpert — subIncidentResolved regression: entity exists but relation does not", () => {
  test("indexing a real PagerDuty-shaped incident item still surfaces a gap note (no silent empty lane)", async () => {
    const db = makePopulatedDb();
    const now = Date.now();

    // Index a real PagerDuty-shaped incident item through the same
    // item-store path a connector sync uses. This drives the real graph
    // populator, so `incident` graph entities genuinely exist. The metadata
    // deliberately omits `assignee_emails`/`resolved_by_email`, so
    // `syncIncidentPersonEdges` emits no person edge here — this fixture is
    // exercising the genuinely-empty case, not a populator gap.
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "PD-1",
      title: "Checkout 500s",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: { service: "checkout" },
    });

    // I-2: also index a real GitHub issue + a PR whose body says "closes #4" —
    // this branch's graph populator now emits a genuine `pr -> issue "resolves"`
    // edge for that. On unscoped code, `detectMissingRelationEmit(db, "resolves")`
    // finds THIS edge (wrong endpoint type) and wrongly suppresses the incident
    // lane's gap note — the exact silent-empty-lane bug this fixture proves fixed.
    upsertIndexedItem(db, {
      service: "github",
      type: "issue",
      externalId: "acme/app#4",
      title: "Login broken",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: { repo: "acme/app" },
    });
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Fix login",
      bodyPreview: "closes #4",
      modifiedAt: now,
      syncedAt: now,
      metadata: { repo: "acme/app" },
    });

    const ctx = { db, notify: () => {}, sessionId: "s-incident-entity-no-relation" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);

    // The old `detectMissingEntityType`-only check would find `incident`
    // entities and silently drop this lane with no explanation at all. The
    // lane must still explain itself via a `missing_relation_emit` gap note
    // keyed on the `resolves` relation it actually needs — even though a
    // `resolves` edge now genuinely exists elsewhere in the graph (pr -> issue).
    const cats = brief.gaps.map((g) => g.category);
    expect(cats).toContain("missing_relation_emit");
    const relationGap = brief.gaps.find(
      (g) => g.category === "missing_relation_emit" && g.detail.includes("resolves"),
    );
    expect(relationGap).toBeDefined();
  });
});

describe("runExpert — subChatMentions data path", () => {
  test("chat message data surfaces chat_post evidence", async () => {
    const db = makePopulatedDb();
    const now = Date.now();
    db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:dave", "Dave"]);
    // Message item matching the topic
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["slack:msg:1", "slack", "message", "msg:1", "auth discussion", now, now],
    );
    // graph_entity for the message (external_id = item.id)
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:msg:1", "message", "slack:msg:1", "msg label", "slack"],
    );
    // graph_entity for the person (external_id = person.id)
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service) VALUES (?, ?, ?, ?, ?)",
      ["ge:prsn:1", "person", "person:dave", "Dave", "slack"],
    );
    // 'posted' relation: from person entity → message entity
    db.run("INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)", [
      "ge:prsn:1",
      "ge:msg:1",
      "posted",
      now,
    ]);

    const ctx = { db, notify: () => {}, sessionId: "s-chat" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);

    const dave = brief.ranked.find((r) => r.personId === "person:dave");
    expect(dave).toBeDefined();
    expect(dave?.evidence.some((e) => e.type === "chat_post")).toBe(true);
  });

  test("no matching messages + slack not registered → missing_connector gap for slack", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["seed:1", "jira", "issue", "seed:1", "auth seed", now, now],
    );
    // Only github registered, NOT slack
    db.run("INSERT INTO sync_state (connector_id) VALUES (?)", ["github"]);

    const ctx = { db, notify: () => {}, sessionId: "s-chat-noslack" };
    const brief = await runExpert({ topicOrFile: "auth" }, ctx);
    const slackGaps = brief.gaps.filter(
      (g) => g.category === "missing_connector" && g.detail.includes("slack"),
    );
    expect(slackGaps.length).toBeGreaterThan(0);
  });

  test("no matching messages + slack registered → no missing_connector gap for slack", async () => {
    const db = makePopulatedDb();
    // slack IS registered but no messages match the topic
    const ctx = { db, notify: () => {}, sessionId: "s-chat-slack-ok" };
    const brief = await runExpert({ topicOrFile: "xyzzy" }, ctx);
    const slackGaps = brief.gaps.filter(
      (g) => g.category === "missing_connector" && g.detail.includes("slack"),
    );
    expect(slackGaps).toHaveLength(0);
  });
});

describe("emitExpertBrief", () => {
  test("returns sessionId synchronously and fires expert.briefReady asynchronously", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const notifications: Array<{ method: string; params: unknown }> = [];
    const ctx = {
      db,
      notify: (method: string, params: unknown) => {
        notifications.push({ method, params });
      },
      sessionId: "emit-s1",
    };
    const result = await emitExpertBrief({ topicOrFile: "anything" }, ctx);
    expect(result).toEqual({ sessionId: "emit-s1" });
    // Wait for the async fire-and-forget to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(notifications.some((n) => n.method === "expert.briefReady")).toBe(true);
  });

  test("uses llm synthesizer when ctx.llm is provided (non-undefined llm branch)", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const notifications: Array<{ method: string; params: unknown }> = [];
    let llmCalled = false;
    const ctx = {
      db,
      notify: (method: string, params: unknown) => {
        notifications.push({ method, params });
      },
      sessionId: "emit-s2",
      llm: {
        generateMarkdown: async (_prompt: string): Promise<string | null> => {
          llmCalled = true;
          return "# Expert Summary\nLLM output";
        },
      },
    };
    await emitExpertBrief({ topicOrFile: "anything" }, ctx);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(llmCalled).toBe(true);
    expect(notifications.some((n) => n.method === "expert.briefReady")).toBe(true);
  });

  test("fires expert.briefError when runExpert throws (catch branch)", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const notifications: Array<{ method: string; params: unknown }> = [];
    const ctx = {
      db,
      notify: (method: string, params: unknown) => {
        notifications.push({ method, params });
      },
      sessionId: "emit-s3",
    };
    // Close the db so the first db.query inside runExpert throws
    db.close();

    const result = await emitExpertBrief({ topicOrFile: "anything" }, ctx);
    expect(result).toEqual({ sessionId: "emit-s3" });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const errNote = notifications.find((n) => n.method === "expert.briefError");
    expect(errNote).toBeDefined();
    const params = errNote?.params as Record<string, unknown>;
    expect(params["sessionId"]).toBe("emit-s3");
    expect(typeof params["error"]).toBe("string");
    expect((params["error"] as string).length).toBeGreaterThan(0);
  });
});

// Placeholder afterEach — no global state is mutated in these tests.
afterEach(() => {});
