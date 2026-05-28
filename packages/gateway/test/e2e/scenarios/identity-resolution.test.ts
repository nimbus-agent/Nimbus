import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import {
  countItemsByAuthor,
  insertPerson,
  searchPersons,
} from "../../../src/people/person-store.ts";

describe("identity resolution (local people + index)", () => {
  test("one person links GitHub + Linear; search + author counts need no network", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const personId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    insertPerson(db, {
      id: personId,
      displayName: "Jordan Reviewer",
      canonicalEmail: "jordan@payment.example",
      githubLogin: "jordan-r",
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: "linear-member-99",
      jiraAccountId: null,
      notionUserId: null,
      linked: true,
      metadata: {},
    });

    const now = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "pr-1",
      title: "payment-service: tighten auth",
      modifiedAt: now,
      syncedAt: now,
      authorId: personId,
    });
    upsertIndexedItem(db, {
      service: "linear",
      type: "issue",
      externalId: "lin-1",
      title: "POL-12 follow-up",
      modifiedAt: now - 1000,
      syncedAt: now,
      authorId: personId,
    });

    const candidates = searchPersons(db, "Jordan", 3);
    expect(candidates.length).toBe(1);
    const c = candidates[0];
    expect(c).toBeDefined();
    expect(c?.githubLogin).toBe("jordan-r");
    expect(c?.linearMemberId).toBe("linear-member-99");
    expect(countItemsByAuthor(db, personId)).toBe(2);
  });
});
