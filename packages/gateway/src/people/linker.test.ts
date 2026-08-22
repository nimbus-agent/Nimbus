import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { mergePeople, resolvePersonForSync } from "./linker.ts";
import {
  findPersonByBitbucketUuid,
  findPersonByGithubLogin,
  getPersonById,
} from "./person-store.ts";

function openDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("resolvePersonForSync", () => {
  test("creates unlinked handle-only row for GitHub login", () => {
    const db = openDb();
    const id = resolvePersonForSync(db, { githubLogin: "octocat", displayName: "octocat" });
    expect(id).not.toBeNull();
    const p = getPersonById(db, id as string);
    expect(p?.githubLogin).toBe("octocat");
    expect(p?.linked).toBe(false);
    expect(p?.canonicalEmail).toBeNull();
  });

  test("dedupes by GitHub login", () => {
    const db = openDb();
    const a = resolvePersonForSync(db, { githubLogin: "dup" });
    const b = resolvePersonForSync(db, { githubLogin: "dup" });
    expect(a).toBe(b);
  });

  test("Bitbucket uuid creates handle row and dedupes", () => {
    const db = openDb();
    const uuid = "a1b2c3d4e5f67890abcdef1234567890";
    const a = resolvePersonForSync(db, { bitbucketUuid: uuid, displayName: "BB" });
    const b = resolvePersonForSync(db, { bitbucketUuid: uuid, displayName: "BB2" });
    expect(a).toBe(b);
    expect(findPersonByBitbucketUuid(db, uuid)?.id ?? null).toBe(a);
  });

  test("Microsoft user id creates handle row", () => {
    const db = openDb();
    const id = resolvePersonForSync(db, { microsoftUserId: "ms-1", displayName: "M" });
    expect(id).not.toBeNull();
    const p = getPersonById(db, id as string);
    expect(p?.microsoftUserId).toBe("ms-1");
  });

  test("Discord user id creates handle row", () => {
    const db = openDb();
    const id = resolvePersonForSync(db, { discordUserId: "123456789", displayName: "D" });
    expect(id).not.toBeNull();
    const p = getPersonById(db, id as string);
    expect(p?.discordUserId).toBe("123456789");
  });

  test("email creates linked row and stable id", () => {
    const db = openDb();
    const id = resolvePersonForSync(db, {
      canonicalEmail: "User@Example.com",
      displayName: "U",
    });
    expect(id).not.toBeNull();
    const personId = id as string;
    const p = getPersonById(db, personId);
    expect(p?.linked).toBe(true);
    expect(p?.canonicalEmail).toBe("user@example.com");
    const again = resolvePersonForSync(db, {
      canonicalEmail: "user@example.com",
      githubLogin: "ghu",
    });
    expect(again).toBe(personId);
    expect(findPersonByGithubLogin(db, "ghu")?.id).toBe(personId);
  });
});

describe("mergePeople", () => {
  test("merges B into A and rewrites item.author_id", () => {
    const db = openDb();
    const idA = resolvePersonForSync(db, { githubLogin: "auser" });
    const idB = resolvePersonForSync(db, { githubLogin: "buser" });
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "github:x",
        "github",
        "pr",
        "x",
        "t",
        "t",
        null,
        null,
        Date.now(),
        idB as string,
        "{}",
        Date.now(),
        0,
      ],
    );
    const survivor = mergePeople(db, idA as string, idB as string);
    expect(survivor).toBe(idA as string); // NOSONAR S4325: idA is string|null; toBe's expected param is typed string
    expect(getPersonById(db, idB as string)).toBeNull();
    const row = db.query("SELECT author_id FROM item WHERE id = ?").get("github:x") as {
      author_id: string | null;
    };
    expect(row.author_id).toBe(idA);
  });

  test("rejects conflicting emails", () => {
    const db = openDb();
    const idA = resolvePersonForSync(db, { canonicalEmail: "a@a.com" });
    const idB = resolvePersonForSync(db, { canonicalEmail: "b@b.com" });
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    expect(() => mergePeople(db, idA as string, idB as string)).toThrow(
      /conflicting canonical emails/,
    );
  });
});

describe("automated senders do not become people (F7)", () => {
  test("a newsletter address alone creates no person", () => {
    const db = openDb();
    expect(resolvePersonForSync(db, { canonicalEmail: "newsletter@first-backer.com" })).toBeNull();
    db.close();
  });

  test("an ordinary address still does", () => {
    const db = openDb();
    expect(resolvePersonForSync(db, { canonicalEmail: "asaf@example.com" })).not.toBeNull();
    db.close();
  });

  test("a no-reply address WITH another identity is kept", () => {
    // A real account that happens to send from a no-reply address is still a collaborator, and
    // dropping it would lose someone the graph needs. Email-only is the case this filters.
    const db = openDb();
    expect(
      resolvePersonForSync(db, {
        canonicalEmail: "no-reply@github.com",
        githubLogin: "octocat",
      }),
    ).not.toBeNull();
    db.close();
  });
});
