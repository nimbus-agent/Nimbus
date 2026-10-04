/**
 * `person-store.ts` against the real migrated schema: every handle finder, the metadata parse
 * (including the malformed shapes a row can hold), per-field `updatePersonHandles`, the list/search
 * query builders, and the author count.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  buildPersonListSql,
  countItemsByAuthor,
  deletePersonById,
  findPersonByBitbucketUuid,
  findPersonByCanonicalEmail,
  findPersonByDiscordUserId,
  findPersonByGithubLogin,
  findPersonByGitlabLogin,
  findPersonByJiraAccountId,
  findPersonByLinearMemberId,
  findPersonByMicrosoftUserId,
  findPersonByNotionUserId,
  findPersonBySlackHandle,
  getPersonById,
  insertPerson,
  listPersons,
  normalizeEmail,
  searchPersons,
  updatePersonHandles,
} from "./person-store.ts";
import type { PersonRecord } from "./person-types.ts";

let db: Database;
beforeEach(() => {
  db = openMemoryIndexDatabase();
});
afterEach(() => {
  db.close();
});

const FULL = {
  id: "p-full",
  displayName: "Ada Lovelace",
  canonicalEmail: "ada@example.com",
  githubLogin: "ada-gh",
  gitlabLogin: "ada-gl",
  slackHandle: "ada.slack",
  linearMemberId: "lin-1",
  jiraAccountId: "jira-1",
  notionUserId: "notion-1",
  bitbucketUuid: "{bb-1}",
  microsoftUserId: "ms-1",
  discordUserId: "disc-1",
  linked: true,
  metadata: { team: "core" },
} as const;

function insertBare(id: string, extra: Partial<Parameters<typeof insertPerson>[1]> = {}): void {
  insertPerson(db, {
    id,
    displayName: null,
    canonicalEmail: null,
    githubLogin: null,
    gitlabLogin: null,
    slackHandle: null,
    linearMemberId: null,
    jiraAccountId: null,
    notionUserId: null,
    linked: true,
    metadata: {},
    ...extra,
  });
}

describe("finders", () => {
  const finders: Array<[string, (d: Database, v: string) => PersonRecord | null, string]> = [
    ["getPersonById", getPersonById, FULL.id],
    ["findPersonByCanonicalEmail", findPersonByCanonicalEmail, FULL.canonicalEmail],
    ["findPersonByGithubLogin", findPersonByGithubLogin, FULL.githubLogin],
    ["findPersonByGitlabLogin", findPersonByGitlabLogin, FULL.gitlabLogin],
    ["findPersonBySlackHandle", findPersonBySlackHandle, FULL.slackHandle],
    ["findPersonByLinearMemberId", findPersonByLinearMemberId, FULL.linearMemberId],
    ["findPersonByJiraAccountId", findPersonByJiraAccountId, FULL.jiraAccountId],
    ["findPersonByNotionUserId", findPersonByNotionUserId, FULL.notionUserId],
    ["findPersonByBitbucketUuid", findPersonByBitbucketUuid, FULL.bitbucketUuid],
    ["findPersonByMicrosoftUserId", findPersonByMicrosoftUserId, FULL.microsoftUserId],
    ["findPersonByDiscordUserId", findPersonByDiscordUserId, FULL.discordUserId],
  ];

  for (const [name, find, value] of finders) {
    test(`${name} returns the whole record on a hit and null on a miss`, () => {
      insertPerson(db, FULL);
      insertBare("p-other", { displayName: "Other" });
      expect(find(db, value)).toEqual({ ...FULL, metadata: { team: "core" } });
      expect(find(db, `${value}-absent`)).toBeNull();
    });
  }

  test("an insert that omits the three later handles stores them as null, and linked=false as 0", () => {
    insertBare("p-min", { linked: false });
    const rec = getPersonById(db, "p-min");
    expect(rec?.bitbucketUuid).toBeNull();
    expect(rec?.microsoftUserId).toBeNull();
    expect(rec?.discordUserId).toBeNull();
    expect(rec?.linked).toBe(false);
    expect(db.query("SELECT linked FROM person WHERE id = 'p-min'").get()).toEqual({ linked: 0 });
  });
});

describe("metadata parsing", () => {
  const shapes: Array<[string, string | null, Record<string, unknown> | null]> = [
    ["a JSON object", '{"a":1,"b":[2]}', { a: 1, b: [2] }],
    ["malformed JSON", "{oops", null],
    ["a JSON array", "[1,2]", null],
    ["JSON null", "null", null],
    ["a JSON number", "42", null],
    ["an empty string", "", null],
    ["SQL NULL", null, null],
  ];
  for (const [label, stored, expected] of shapes) {
    test(`a metadata column holding ${label} reads as ${JSON.stringify(expected)}`, () => {
      insertBare("p-meta");
      db.run("UPDATE person SET metadata = ? WHERE id = 'p-meta'", [stored]);
      expect(getPersonById(db, "p-meta")?.metadata).toEqual(expected);
    });
  }
});

describe("updatePersonHandles", () => {
  const fields: Array<
    [keyof Parameters<typeof updatePersonHandles>[2] & keyof PersonRecord, string]
  > = [
    ["displayName", "Grace"],
    ["canonicalEmail", "grace@example.com"],
    ["githubLogin", "grace-gh"],
    ["gitlabLogin", "grace-gl"],
    ["slackHandle", "grace.slack"],
    ["linearMemberId", "lin-9"],
    ["jiraAccountId", "jira-9"],
    ["notionUserId", "notion-9"],
    ["bitbucketUuid", "{bb-9}"],
    ["microsoftUserId", "ms-9"],
    ["discordUserId", "disc-9"],
  ];

  for (const [field, value] of fields) {
    test(`patching only ${field} changes only ${field}`, () => {
      insertPerson(db, FULL);
      updatePersonHandles(db, FULL.id, { [field]: value });
      const after = getPersonById(db, FULL.id);
      expect(after).toEqual({ ...FULL, metadata: { team: "core" }, [field]: value });
    });
  }

  test("null clears a handle; linked flips both ways; an empty patch is a no-op", () => {
    insertPerson(db, FULL);
    updatePersonHandles(db, FULL.id, {});
    expect(getPersonById(db, FULL.id)).toEqual({ ...FULL, metadata: { team: "core" } });
    updatePersonHandles(db, FULL.id, { githubLogin: null, linked: false });
    expect(getPersonById(db, FULL.id)?.githubLogin).toBeNull();
    expect(getPersonById(db, FULL.id)?.linked).toBe(false);
    updatePersonHandles(db, FULL.id, { linked: true });
    expect(getPersonById(db, FULL.id)?.linked).toBe(true);
    expect(getPersonById(db, FULL.id)?.slackHandle).toBe(FULL.slackHandle);
  });
});

describe("buildPersonListSql / listPersons", () => {
  test("no filters: no WHERE, and the limit is clamped into 1..500", () => {
    expect(buildPersonListSql({ limit: 20 })).toEqual({
      sql: "SELECT * FROM person  ORDER BY id LIMIT ?",
      vals: [20],
    });
    expect(buildPersonListSql({ limit: 0 }).vals).toEqual([1]);
    expect(buildPersonListSql({ limit: 10_000 }).vals).toEqual([500]);
  });

  test("unlinkedOnly and idInSql combine with AND, subquery values before the limit", () => {
    const built = buildPersonListSql({
      limit: 5,
      unlinkedOnly: true,
      idInSql: { sql: "SELECT id FROM person WHERE display_name = ?", vals: ["Bo"] },
    });
    expect(built.sql).toBe(
      "SELECT * FROM person WHERE linked = 0 AND id IN (SELECT id FROM person WHERE display_name = ?) ORDER BY id LIMIT ?",
    );
    expect(built.vals).toEqual(["Bo", 5]);
  });

  test("listPersons applies those filters to real rows", () => {
    insertBare("p-a", { displayName: "Bo", linked: false });
    insertBare("p-b", { displayName: "Bo", linked: true });
    insertBare("p-c", { displayName: "Cy", linked: false });
    expect(listPersons(db, { limit: 10 }).map((p) => p.id)).toEqual(["p-a", "p-b", "p-c"]);
    expect(listPersons(db, { limit: 10, unlinkedOnly: true }).map((p) => p.id)).toEqual([
      "p-a",
      "p-c",
    ]);
    expect(
      listPersons(db, {
        limit: 10,
        unlinkedOnly: true,
        idInSql: { sql: "SELECT id FROM person WHERE display_name = ?", vals: ["Bo"] },
      }).map((p) => p.id),
    ).toEqual(["p-a"]);
    expect(listPersons(db, { limit: 2 }).map((p) => p.id)).toEqual(["p-a", "p-b"]);
  });
});

describe("searchPersons", () => {
  test("an empty or blank query lists everyone (limit clamped into 1..100)", () => {
    insertBare("p-1");
    insertBare("p-2");
    expect(searchPersons(db, "   ", 10).map((p) => p.id)).toEqual(["p-1", "p-2"]);
    expect(searchPersons(db, "", 0).map((p) => p.id)).toEqual(["p-1"]);
  });

  test("matches case-insensitively on every handle column", () => {
    insertPerson(db, FULL);
    insertBare("p-noise", { displayName: "Noise" });
    for (const q of [
      "LOVELACE",
      "ADA@EXAMPLE",
      "ada-gh",
      "ADA-GL",
      "ada.SLACK",
      "LIN-1",
      "Jira-1",
      "NOTION-1",
      "BB-1",
      "MS-1",
      "DISC-1",
    ]) {
      expect(searchPersons(db, q, 10).map((p) => p.id)).toEqual([FULL.id]);
    }
    expect(searchPersons(db, "nobody-matches", 10)).toEqual([]);
  });

  test("the search limit is clamped to at most 100", () => {
    for (let i = 0; i < 105; i += 1) {
      insertBare(`p-${String(i).padStart(3, "0")}`, { displayName: `Match ${i}` });
    }
    expect(searchPersons(db, "match", 1_000)).toHaveLength(100);
  });
});

describe("countItemsByAuthor / deletePersonById / normalizeEmail", () => {
  test("counts only the author's items", () => {
    insertBare("p-auth");
    const ins = db.query(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id) VALUES (?, 'github', 'pr', ?, 't', 1, 1, ?)",
    );
    ins.run("github:1", "1", "p-auth");
    ins.run("github:2", "2", "p-auth");
    ins.run("github:3", "3", "p-else");
    ins.finalize();
    expect(countItemsByAuthor(db, "p-auth")).toBe(2);
    expect(countItemsByAuthor(db, "p-nobody")).toBe(0);
  });

  test("always returns a finite JS number, even from a handle that hands back bigint counts", () => {
    // A `safeIntegers` handle returns COUNT(*) as a bigint. Whatever the function makes of that, it
    // must not leak a bigint (or throw on Math.floor) to callers typed for `number`.
    const big = new Database(":memory:", { safeIntegers: true });
    try {
      big.run("CREATE TABLE item (author_id TEXT)");
      big.run("INSERT INTO item (author_id) VALUES ('p-auth'), ('p-auth')");
      // The premise: this handle really does return the count as a bigint.
      const raw = big.query("SELECT COUNT(*) AS c FROM item").get() as { c: unknown };
      expect(typeof raw.c).toBe("bigint");
      const n = countItemsByAuthor(big, "p-auth");
      expect(typeof n).toBe("number");
      expect(Number.isFinite(n)).toBe(true);
    } finally {
      big.close();
    }
  });

  test("deletePersonById removes only that person", () => {
    insertBare("p-x");
    insertBare("p-y");
    deletePersonById(db, "p-x");
    expect(getPersonById(db, "p-x")).toBeNull();
    expect(getPersonById(db, "p-y")?.id).toBe("p-y");
  });

  test("normalizeEmail trims and lower-cases", () => {
    expect(normalizeEmail("  Ada@Example.COM \n")).toBe("ada@example.com");
  });
});
