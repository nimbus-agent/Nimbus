import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { mergePeople, resolvePersonForSync } from "./linker.ts";
import { NIMBUS_PERSON_NAMESPACE_UUID, uuidV5 } from "./person-id.ts";
import { getPersonById, insertPerson } from "./person-store.ts";
import type { PersonRecord, PersonSyncHints } from "./person-types.ts";

function openDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function personCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number }).n;
}

/** Every handle column, so a test can assert the ONE it expects set and all the rest null. */
const HANDLE_FIELDS = [
  "githubLogin",
  "gitlabLogin",
  "slackHandle",
  "linearMemberId",
  "jiraAccountId",
  "notionUserId",
  "bitbucketUuid",
  "microsoftUserId",
  "discordUserId",
] as const;
type HandleField = (typeof HANDLE_FIELDS)[number];

function insertFullPerson(
  db: Database,
  id: string,
  overrides: Partial<Omit<PersonRecord, "metadata">> = {},
): void {
  insertPerson(db, {
    id,
    displayName: "Old Name",
    canonicalEmail: null,
    githubLogin: "old-gh",
    gitlabLogin: "old-gl",
    slackHandle: "old-slack",
    linearMemberId: "old-linear",
    jiraAccountId: "old-jira",
    notionUserId: "old-notion",
    bitbucketUuid: "old-bb",
    microsoftUserId: "old-ms",
    discordUserId: "old-discord",
    linked: false,
    metadata: {},
    ...overrides,
  });
}

describe("resolvePersonForSync — no usable identity", () => {
  test("empty hints resolve to null and write nothing", () => {
    const db = openDb();
    expect(resolvePersonForSync(db, {})).toBeNull();
    expect(personCount(db)).toBe(0);
    db.close();
  });

  test("a display name alongside whitespace-only handles is not an identity", () => {
    const db = openDb();
    const hints: PersonSyncHints = { displayName: "Ghost", canonicalEmail: "  " };
    for (const f of HANDLE_FIELDS) hints[f] = " \t ";
    expect(resolvePersonForSync(db, hints)).toBeNull();
    expect(personCount(db)).toBe(0);
    db.close();
  });
});

describe("resolvePersonForSync — email arrives for a person known only by handle", () => {
  test("the handle-matched row gains the email and keeps every handle the hint omits", () => {
    const db = openDb();
    insertFullPerson(db, "p-existing", { githubLogin: "octo" });

    const id = resolvePersonForSync(db, {
      canonicalEmail: "  Octo@Example.COM ",
      githubLogin: "octo",
    });

    expect(id).toBe("p-existing");
    // No second row: the email attached to the existing person rather than minting one.
    expect(personCount(db)).toBe(1);
    const p = getPersonById(db, "p-existing");
    expect(p?.canonicalEmail).toBe("octo@example.com");
    expect(p?.linked).toBe(true);
    expect(p?.displayName).toBe("Old Name");
    expect(p?.githubLogin).toBe("octo");
    expect(p?.gitlabLogin).toBe("old-gl");
    expect(p?.slackHandle).toBe("old-slack");
    expect(p?.linearMemberId).toBe("old-linear");
    expect(p?.jiraAccountId).toBe("old-jira");
    expect(p?.notionUserId).toBe("old-notion");
    expect(p?.bitbucketUuid).toBe("old-bb");
    expect(p?.microsoftUserId).toBe("old-ms");
    expect(p?.discordUserId).toBe("old-discord");
    db.close();
  });

  test("hint values win over the handle-matched row's stored values", () => {
    const db = openDb();
    insertFullPerson(db, "p-existing", { githubLogin: "octo" });

    const id = resolvePersonForSync(db, {
      canonicalEmail: "octo@example.com",
      displayName: "New Name",
      githubLogin: "octo",
      gitlabLogin: "new-gl",
      slackHandle: "new-slack",
      linearMemberId: "new-linear",
      jiraAccountId: "new-jira",
      notionUserId: "new-notion",
      bitbucketUuid: "new-bb",
      microsoftUserId: "new-ms",
      discordUserId: "new-discord",
    });

    expect(id).toBe("p-existing");
    const p = getPersonById(db, "p-existing");
    expect(p).toEqual({
      id: "p-existing",
      displayName: "New Name",
      canonicalEmail: "octo@example.com",
      githubLogin: "octo",
      gitlabLogin: "new-gl",
      slackHandle: "new-slack",
      linearMemberId: "new-linear",
      jiraAccountId: "new-jira",
      notionUserId: "new-notion",
      bitbucketUuid: "new-bb",
      microsoftUserId: "new-ms",
      discordUserId: "new-discord",
      linked: true,
      metadata: {},
    });
    db.close();
  });

  test("the handle lookup walks past unmatched and absent handles to a later one", () => {
    const db = openDb();
    insertPerson(db, {
      id: "p-discord",
      displayName: null,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      discordUserId: "d-42",
      linked: false,
      metadata: {},
    });

    // github is absent, gitlab is present but matches nobody, slack..microsoft are absent, and
    // discord matches.
    const id = resolvePersonForSync(db, {
      canonicalEmail: "d@example.com",
      gitlabLogin: "unmatched-login",
      discordUserId: "d-42",
    });

    expect(id).toBe("p-discord");
    expect(personCount(db)).toBe(1);
    const p = getPersonById(db, "p-discord");
    expect(p?.canonicalEmail).toBe("d@example.com");
    expect(p?.gitlabLogin).toBe("unmatched-login");
    expect(p?.githubLogin).toBeNull();
    expect(p?.discordUserId).toBe("d-42");
    expect(p?.displayName).toBeNull();
    db.close();
  });
});

type HandleCase = { field: HandleField; prefix: string };
const HANDLE_ONLY_CASES: HandleCase[] = [
  { field: "gitlabLogin", prefix: "gitlab" },
  { field: "slackHandle", prefix: "slack" },
  { field: "linearMemberId", prefix: "linear" },
  { field: "jiraAccountId", prefix: "jira" },
  { field: "notionUserId", prefix: "notion" },
  { field: "bitbucketUuid", prefix: "bitbucket" },
  { field: "microsoftUserId", prefix: "microsoft" },
  { field: "discordUserId", prefix: "discord" },
];

describe("resolvePersonForSync — handle-only person without a display name", () => {
  test.each(HANDLE_ONLY_CASES)(
    "$field: trimmed value becomes the display name and the only handle set",
    ({ field, prefix }: HandleCase) => {
      const db = openDb();
      const hints: PersonSyncHints = {};
      hints[field] = `  ${prefix}-value  `;
      const id = resolvePersonForSync(db, hints);

      expect(id).toBe(uuidV5(`${prefix}:${prefix}-value`, NIMBUS_PERSON_NAMESPACE_UUID));
      const p = getPersonById(db, id as string);
      expect(p?.displayName).toBe(`${prefix}-value`);
      expect(p?.canonicalEmail).toBeNull();
      expect(p?.linked).toBe(false);
      for (const f of HANDLE_FIELDS) {
        expect({ f, v: p?.[f] }).toEqual({ f, v: f === field ? `${prefix}-value` : null });
      }
      db.close();
    },
  );

  test("a later sighting of the same handle merges into the row without linking it", () => {
    const db = openDb();
    const first = resolvePersonForSync(db, { slackHandle: "U123" });
    const second = resolvePersonForSync(db, { slackHandle: "U123", displayName: "Slack Person" });
    expect(second).toBe(first);
    expect(personCount(db)).toBe(1);
    const p = getPersonById(db, first as string);
    expect(p?.displayName).toBe("Slack Person");
    expect(p?.linked).toBe(false);
    db.close();
  });
});

describe("mergePeople — edge cases", () => {
  test("merging a person into itself is a no-op that never reads the table", () => {
    const db = openDb();
    // The id does not exist; a lookup would throw "unknown person id".
    expect(mergePeople(db, "ghost", "ghost")).toBe("ghost");
    db.close();
  });

  test("an unknown id on either side throws and deletes nothing", () => {
    const db = openDb();
    insertFullPerson(db, "p-real");
    expect(() => mergePeople(db, "p-real", "p-missing")).toThrow("mergePeople: unknown person id");
    expect(() => mergePeople(db, "p-missing", "p-real")).toThrow("mergePeople: unknown person id");
    expect(getPersonById(db, "p-real")).not.toBeNull();
    db.close();
  });

  test("A's empty fields fill from B, and A's email links the survivor", () => {
    const db = openDb();
    insertPerson(db, {
      id: "p-a",
      displayName: null,
      canonicalEmail: "a@example.com",
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      linked: false,
      metadata: {},
    });
    insertFullPerson(db, "p-b", { linked: false });

    expect(mergePeople(db, "p-a", "p-b")).toBe("p-a");
    expect(getPersonById(db, "p-b")).toBeNull();
    expect(getPersonById(db, "p-a")).toEqual({
      id: "p-a",
      displayName: "Old Name",
      canonicalEmail: "a@example.com",
      githubLogin: "old-gh",
      gitlabLogin: "old-gl",
      slackHandle: "old-slack",
      linearMemberId: "old-linear",
      jiraAccountId: "old-jira",
      notionUserId: "old-notion",
      bitbucketUuid: "old-bb",
      microsoftUserId: "old-ms",
      discordUserId: "old-discord",
      // Both inputs were unlinked; a canonical email is what links the survivor.
      linked: true,
      metadata: {},
    });
    db.close();
  });

  test("with no email on either side, linked is the OR of the two inputs", () => {
    const db = openDb();
    insertFullPerson(db, "p-a", { linked: false, githubLogin: "a-gh" });
    insertFullPerson(db, "p-b", { linked: true, githubLogin: "b-gh" });
    mergePeople(db, "p-a", "p-b");
    const merged = getPersonById(db, "p-a");
    expect(merged?.linked).toBe(true);
    expect(merged?.canonicalEmail).toBeNull();
    // A's own value wins where both are set.
    expect(merged?.githubLogin).toBe("a-gh");

    insertFullPerson(db, "p-c", { linked: false, githubLogin: "c-gh" });
    insertFullPerson(db, "p-d", { linked: false, githubLogin: "d-gh" });
    mergePeople(db, "p-c", "p-d");
    expect(getPersonById(db, "p-c")?.linked).toBe(false);
    db.close();
  });
});
