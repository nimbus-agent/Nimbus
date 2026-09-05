import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { LocalIndex } from "../../index/local-index.ts";
import { insertPerson } from "../../people/person-store.ts";
import {
  defaultRunGitConfigUserEmail,
  resolveByGitEmail,
  resolveByOsUsername,
  resolveSelfPerson,
} from "./self-person.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

afterEach(() => {
  mock.restore();
});

describe("resolveByGitEmail", () => {
  test("returns null when git is unavailable", async () => {
    const out = await resolveByGitEmail(freshDb(), {
      runGit: async () => null,
    });
    expect(out).toBeNull();
  });

  test("returns null when git outputs an empty email", async () => {
    const out = await resolveByGitEmail(freshDb(), {
      runGit: async () => "",
    });
    expect(out).toBeNull();
  });

  test("returns null when no person matches the canonical email", async () => {
    const db = freshDb();
    insertPerson(db, {
      id: "p-1",
      displayName: "Alice",
      canonicalEmail: "alice@example.com",
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
    const out = await resolveByGitEmail(db, {
      runGit: async () => "bob@example.com",
    });
    expect(out).toBeNull();
  });

  test("returns the matching person id, normalising the email", async () => {
    const db = freshDb();
    insertPerson(db, {
      id: "p-2",
      displayName: "Alice",
      canonicalEmail: "alice@example.com",
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
    const out = await resolveByGitEmail(db, {
      runGit: async () => "  Alice@Example.COM  ",
    });
    expect(out).toBe("p-2");
  });
});

describe("resolveByOsUsername", () => {
  test("returns null when osUsername is empty", () => {
    const out = resolveByOsUsername(freshDb(), { osUsername: "" });
    expect(out).toBeNull();
  });

  test("returns null when no person has the github_login", () => {
    const out = resolveByOsUsername(freshDb(), { osUsername: "ghost" });
    expect(out).toBeNull();
  });

  test("returns the matching person id when github_login matches", () => {
    const db = freshDb();
    insertPerson(db, {
      id: "p-3",
      displayName: "Carol",
      canonicalEmail: null,
      githubLogin: "carol",
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      bitbucketUuid: null,
      linked: false,
      metadata: {},
    });
    const out = resolveByOsUsername(db, { osUsername: "carol" });
    expect(out).toBe("p-3");
  });
});

describe("resolveSelfPerson (orchestrator)", () => {
  test("override wins over all other tiers", async () => {
    const db = freshDb();
    const out = await resolveSelfPerson(db, {
      override: "p-override",
      runGit: async () => "anything@example.com",
      osUsername: "anyone",
    });
    expect(out.personId).toBe("p-override");
    expect(out.source).toBe("override");
  });

  test("falls back to git when override is undefined", async () => {
    const db = freshDb();
    insertPerson(db, {
      id: "p-git",
      displayName: "Dan",
      canonicalEmail: "dan@example.com",
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
    const out = await resolveSelfPerson(db, {
      runGit: async () => "dan@example.com",
      osUsername: "ignored",
    });
    expect(out.personId).toBe("p-git");
    expect(out.source).toBe("git");
  });

  test("falls back to OS username when git matches no person", async () => {
    const db = freshDb();
    insertPerson(db, {
      id: "p-os",
      displayName: "Erin",
      canonicalEmail: null,
      githubLogin: "erin",
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      bitbucketUuid: null,
      linked: false,
      metadata: {},
    });
    const out = await resolveSelfPerson(db, {
      runGit: async () => "ghost@example.com",
      osUsername: "erin",
    });
    expect(out.personId).toBe("p-os");
    expect(out.source).toBe("os");
  });

  test("returns null + 'unresolved' when all tiers miss", async () => {
    const out = await resolveSelfPerson(freshDb(), {
      runGit: async () => null,
      osUsername: "ghost",
    });
    expect(out.personId).toBeNull();
    expect(out.source).toBe("unresolved");
  });

  test("override is used verbatim — no validation that the person exists", async () => {
    const out = await resolveSelfPerson(freshDb(), {
      override: "person-does-not-exist",
      runGit: async () => null,
      osUsername: "",
    });
    expect(out.personId).toBe("person-does-not-exist");
    expect(out.source).toBe("override");
  });
});

describe("defaultRunGitConfigUserEmail — windows console hygiene", () => {
  // Rationale in `connectors/blame-index-sync.test.ts`: the detached Gateway has no console of
  // its own, so an unhidden console child pops a visible window on Windows.
  test("spawns git with windowsHide", async () => {
    const seen: Record<string, unknown>[] = [];
    const capturingSpawn = ((_cmd: readonly string[], opts: Record<string, unknown>) => {
      seen.push(opts);
      return { exited: Promise.resolve(0), stdout: new Response("me@example.com\n").body };
    }) as unknown as typeof Bun.spawn;

    await defaultRunGitConfigUserEmail(capturingSpawn);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.["windowsHide"]).toBe(true);
  });
});
