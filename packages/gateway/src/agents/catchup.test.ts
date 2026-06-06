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
    expect(sections.length).toBe(1);
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
