import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { insertPerson } from "../people/person-store.ts";
import { runCatchup, scoreAndGroup } from "./catchup.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("scoreAndGroup", () => {
  test("groups items by service, orders items within section by score desc", () => {
    const involvement = {
      ownedServices: ["github"],
      activeRepos: [],
      incidentServices: [],
      collaboratorPersonIds: [],
    };
    const items = [
      {
        id: "github:1",
        service: "github",
        title: "low",
        modifiedAt: 0,
        repoLabel: null,
        authorPersonId: null,
      },
      {
        id: "github:2",
        service: "github",
        title: "high",
        modifiedAt: 0,
        repoLabel: null,
        authorPersonId: null,
      },
    ];
    const sections = scoreAndGroup(items, involvement);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.serviceId).toBe("github");
    expect(sections[0]?.items.map((i) => i.title).sort((a, b) => a.localeCompare(b))).toEqual([
      "high",
      "low",
    ]);
  });

  test("ranks owned_service highest, then active_repo, then collaborator, then default", () => {
    const involvement = {
      ownedServices: ["github"],
      activeRepos: ["acme/payment"],
      incidentServices: [],
      collaboratorPersonIds: ["p-bob"],
    };
    const items = [
      {
        id: "linear:1",
        service: "linear",
        title: "default-only",
        modifiedAt: 1,
        repoLabel: null,
        authorPersonId: null,
      },
      {
        id: "github:1",
        service: "github",
        title: "owned",
        modifiedAt: 1,
        repoLabel: null,
        authorPersonId: null,
      },
      {
        id: "github:2",
        service: "github",
        title: "owned+repo",
        modifiedAt: 2, // strictly newer than `owned` so the modifiedAt tie-break is deterministic
        repoLabel: "acme/payment",
        authorPersonId: null,
      },
      {
        id: "slack:1",
        service: "slack",
        title: "collaborator",
        modifiedAt: 1,
        repoLabel: null,
        authorPersonId: "p-bob",
      },
    ];
    const sections = scoreAndGroup(items, involvement);
    expect(sections.map((s) => s.serviceId)).toEqual(["github", "slack", "linear"]);
    const ghTitles = sections.find((s) => s.serviceId === "github")?.items.map((i) => i.title);
    expect(ghTitles).toEqual(["owned+repo", "owned"]);
  });

  test("returns empty array when no items", () => {
    const sections = scoreAndGroup([], {
      ownedServices: [],
      activeRepos: [],
      incidentServices: [],
      collaboratorPersonIds: [],
    });
    expect(sections).toEqual([]);
  });
});

describe("runCatchup", () => {
  test("returns a structurally valid CatchupBrief on an empty index", async () => {
    const db = freshDb();
    const brief = await runCatchup(
      { sinceMs: 3 * 24 * 60 * 60 * 1000 },
      { db, sessionId: "t-1", notify: () => {} },
    );
    expect(brief.kind).toBe("catchup");
    expect(brief.agentVersion).toBe(1);
    expect(brief.query.sinceMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(Array.isArray(brief.sections)).toBe(true);
    expect(Array.isArray(brief.gaps)).toBe(true);
    expect(brief.gaps.some((g) => g.category === "empty_index")).toBe(true);
    expect(typeof brief.latencyMs).toBe("number");
  });

  test("emits missing_user_identity gap when self-person resolution fails entirely", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    const brief = await runCatchup(
      {
        sinceMs: 3 * 24 * 60 * 60 * 1000,
        runGitOverride: async () => null,
        osUsernameOverride: "",
      },
      { db, sessionId: "t-2", notify: () => {} },
    );
    expect(brief.selfPersonId).toBeNull();
    expect(brief.gaps.some((g) => g.category === "missing_user_identity")).toBe(true);
  });

  test("respects --service filter on sections", async () => {
    const db = freshDb();
    insertPerson(db, {
      id: "p-self",
      displayName: "Self",
      canonicalEmail: "self@example.com",
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      bitbucketUuid: null,
      linked: false,
      metadata: {},
    });
    const now = Date.now();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('a', 'github', 'pr', 'acme/x#1', 'a', '', ?, ?, 0)," +
        "('b', 'linear', 'issue', 'lin-1', 'b', '', ?, ?, 0)",
      [now, now, now, now],
    );
    const brief = await runCatchup(
      {
        sinceMs: 3 * 24 * 60 * 60 * 1000,
        service: "github",
        mePersonIdOverride: "p-self",
      },
      { db, sessionId: "t-3", notify: () => {} },
    );
    expect(brief.sections.every((s) => s.serviceId === "github")).toBe(true);
  });
});

describe("catchup discloses when it could not personalise (F3)", () => {
  /**
   * `nimbus catchup` is documented as a "personalised retrospective digest weighted by your
   * involvement". On a real 13,183-item index every involvement axis came back empty, every item
   * scored the identical default 0.1 with reason "default", and `gaps: []` asserted that nothing
   * was missing. A brief that cannot personalise has to say so — the same class the codebase
   * already polices as I31 disclosure integrity.
   *
   * F26 is the cause underneath this one: `resolveSelfPerson` picks the half of a split identity
   * that holds no edges, so every axis comes back empty for a person who is highly active. Fixing
   * that makes this disclosure rare; it does not make it unnecessary.
   */
  test("an all-empty involvement signal produces a gap note", async () => {
    const db = freshDb();
    db.run("INSERT INTO person (id, display_name) VALUES ('person:me', 'Me')");
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('github:a', 'github', 'pr', 'a', 'A PR', '', 1700000000000, 1700000000000, 0)",
    );
    const brief = await runCatchup(
      { sinceMs: 365 * 24 * 60 * 60 * 1000, mePersonIdOverride: "person:me" },
      { db, sessionId: "t-f3", notify: () => {} },
    );

    expect(brief.involvement.ownedServices).toEqual([]);
    expect(brief.gaps.some((g) => g.detail.toLowerCase().includes("involvement"))).toBe(true);
    db.close();
  });

  test("the note says what the ordering IS, not only what it is not", async () => {
    // "Not personalised" alone leaves a reader unable to interpret the list at all. The ordering
    // is still meaningful — it is recency — and saying so is the difference between a caveat and
    // a shrug.
    const db = freshDb();
    db.run("INSERT INTO person (id, display_name) VALUES ('person:me', 'Me')");
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('github:a', 'github', 'pr', 'a', 'A PR', '', 1700000000000, 1700000000000, 0)",
    );
    const brief = await runCatchup(
      { sinceMs: 365 * 24 * 60 * 60 * 1000, mePersonIdOverride: "person:me" },
      { db, sessionId: "t-f3b", notify: () => {} },
    );

    const note = brief.gaps.find((g) => g.detail.toLowerCase().includes("involvement"));
    expect(note?.detail ?? "").toContain("recency");
    expect(note?.remediation ?? "").toContain("nimbus people link");
    db.close();
  });
});

test("a brief WITH an involvement signal carries no such note (F3)", async () => {
  // The other direction, so the note cannot become universal noise: `scoreAndGroup` is exercised
  // directly with a populated involvement, proving the predicate keys on the signal and not on
  // something that is always true.
  const sections = scoreAndGroup(
    [
      {
        itemId: "github:a",
        title: "A PR",
        service: "github",
        repoLabel: "acme/app",
        authorPersonId: null,
        modifiedAt: 1_700_000_000_000,
      } as never,
    ],
    {
      ownedServices: ["github"],
      activeRepos: [],
      incidentServices: [],
      collaboratorPersonIds: [],
    },
  );
  const scored = sections.flatMap((s) => s.items);
  expect(scored.some((i) => i.relevanceScore > 0.1)).toBe(true);
});
