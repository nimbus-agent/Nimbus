import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRpcFixture, type RpcFixture } from "../../test/helpers/rpc-harness.ts";
import { insertPerson } from "../people/person-store.ts";
import { dispatchPeopleRpc, PeopleRpcError } from "./people-rpc.ts";

function seedItem(
  db: Database,
  args: {
    id: string;
    service: string;
    externalId: string;
    authorId: string | null;
    modifiedAt?: number;
    title?: string;
  },
): void {
  const mt = args.modifiedAt ?? 1_700_000_000_000;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [args.id, args.service, "doc", args.externalId, args.title ?? "doc", mt, mt, args.authorId],
  );
}

let graphEntitySeq = 0;
const nextGraphEntityId = (): string => {
  graphEntitySeq += 1;
  return `entity-${String(graphEntitySeq)}`;
};

/**
 * Neither `person.id` nor `item.id` joins to `graph_relation.from_id` directly — the real
 * populator upserts a `graph_entity` whose `external_id` is the person/item id and emits edges
 * FROM that entity's own primary key. Mirrors `index/negation-predicates.test.ts`'s seed helpers.
 */
function insertGraphEntity(db: Database, type: string, externalId: string, label: string): string {
  const id = nextGraphEntityId();
  db.query(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?1, ?2, ?3, ?4)`).run(
    id,
    type,
    externalId,
    label,
  );
  return id;
}

function insertGraphRelation(
  db: Database,
  fromEntityId: string,
  toEntityId: string,
  type: string,
  createdAt: number,
): void {
  db.query(
    `INSERT INTO graph_relation (from_id, to_id, type, weight, created_at)
     VALUES (?1, ?2, ?3, 1.0, ?4)`,
  ).run(fromEntityId, toEntityId, type, createdAt);
}

function seedPersonWithReview(db: Database, id: string, createdAt: number): void {
  seedPerson(db, { id });
  const personEntityId = insertGraphEntity(db, "person", id, id);
  const prEntityId = insertGraphEntity(db, "pr", `pr-${id}`, `pr-${id}`);
  insertGraphRelation(db, personEntityId, prEntityId, "reviewed", createdAt);
}

function seedPersonWithoutReview(db: Database, id: string): void {
  seedPerson(db, { id });
  insertGraphEntity(db, "person", id, id);
}

function seedPerson(
  db: Database,
  overrides: {
    id: string;
    displayName?: string | null;
    canonicalEmail?: string | null;
    githubLogin?: string | null;
    slackHandle?: string | null;
    linked?: boolean;
    metadata?: Record<string, unknown>;
  },
): void {
  insertPerson(db, {
    id: overrides.id,
    displayName: overrides.displayName ?? null,
    canonicalEmail: overrides.canonicalEmail ?? null,
    githubLogin: overrides.githubLogin ?? null,
    gitlabLogin: null,
    slackHandle: overrides.slackHandle ?? null,
    linearMemberId: null,
    jiraAccountId: null,
    notionUserId: null,
    bitbucketUuid: null,
    microsoftUserId: null,
    discordUserId: null,
    linked: overrides.linked ?? true,
    metadata: overrides.metadata ?? {},
  });
}

let fixture: RpcFixture;

beforeEach(() => {
  fixture = createRpcFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function call(method: string, params: unknown): { kind: "hit"; value: unknown } | { kind: "miss" } {
  return dispatchPeopleRpc({ method, params, localIndex: fixture.localIndex });
}

describe("dispatchPeopleRpc — routing", () => {
  test("unknown method returns miss", () => {
    const r = call("people.unknown", {});
    expect(r.kind).toBe("miss");
  });
});

describe("requireString — error paths", () => {
  test("missing params (undefined rec) -> -32602", () => {
    expect(() => call("people.get", null)).toThrow(PeopleRpcError);
    try {
      call("people.get", null);
    } catch (e) {
      expect(e).toBeInstanceOf(PeopleRpcError);
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });

  test("missing key -> -32602", () => {
    try {
      call("people.get", { wrong: "key" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("id");
    }
  });

  test("non-string value -> -32602", () => {
    try {
      call("people.get", { id: 42 });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });

  test("whitespace-only string -> -32602", () => {
    try {
      call("people.get", { id: "   " });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });
});

describe("optionalLimit — error paths", () => {
  test("non-number limit -> -32602", () => {
    try {
      call("people.list", { limit: "twenty" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("limit");
    }
  });

  test("non-finite (Infinity) -> -32602", () => {
    try {
      call("people.list", { limit: Number.POSITIVE_INFINITY });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });

  test("NaN -> -32602", () => {
    try {
      call("people.list", { limit: Number.NaN });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });

  test("missing key falls back to default (no throw)", () => {
    const r = call("people.list", {});
    expect(r.kind).toBe("hit");
  });

  test("undefined rec falls back to default", () => {
    const r = call("people.list", null);
    expect(r.kind).toBe("hit");
  });

  test("float limit is floored", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    seedPerson(fixture.db, { id: "p2", displayName: "B" });
    const r = call("people.list", { limit: 1.9 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(1);
  });
});

describe("people.get", () => {
  test("known id returns full record with item count", () => {
    seedPerson(fixture.db, {
      id: "p1",
      displayName: "Asaf",
      canonicalEmail: "asaf@example.com",
      githubLogin: "asaf",
      metadata: { source: "test" },
    });
    seedItem(fixture.db, { id: "github:i1", service: "github", externalId: "i1", authorId: "p1" });
    seedItem(fixture.db, { id: "github:i2", service: "github", externalId: "i2", authorId: "p1" });
    const r = call("people.get", { id: "p1" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as Record<string, unknown>;
    expect(v["id"]).toBe("p1");
    expect(v["displayName"]).toBe("Asaf");
    expect(v["canonicalEmail"]).toBe("asaf@example.com");
    expect(v["githubLogin"]).toBe("asaf");
    expect(v["itemCount"]).toBe(2);
    expect(v["metadata"]).toEqual({ source: "test" });
  });

  test("unknown id returns null", () => {
    const r = call("people.get", { id: "missing" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toBeNull();
  });

  test("trim is applied to id", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.get", { id: "  p1  " });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect((r.value as Record<string, unknown>)["id"]).toBe("p1");
  });
});

describe("people.list", () => {
  test("returns persons in id order with item counts", () => {
    seedPerson(fixture.db, { id: "p2", displayName: "Bea" });
    seedPerson(fixture.db, { id: "p1", displayName: "Alice" });
    seedItem(fixture.db, { id: "github:i1", service: "github", externalId: "i1", authorId: "p1" });
    const r = call("people.list", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list.map((p) => p["id"])).toEqual(["p1", "p2"]);
    expect(list[0]?.["itemCount"]).toBe(1);
    expect(list[1]?.["itemCount"]).toBe(0);
  });

  test("unlinkedOnly: true filters out linked persons", () => {
    seedPerson(fixture.db, { id: "p_linked", linked: true });
    seedPerson(fixture.db, { id: "p_unlinked", linked: false });
    const r = call("people.list", { unlinkedOnly: true });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]?.["id"]).toBe("p_unlinked");
  });

  test("unlinkedOnly: false is treated as full list", () => {
    seedPerson(fixture.db, { id: "p_linked", linked: true });
    seedPerson(fixture.db, { id: "p_unlinked", linked: false });
    const r = call("people.list", { unlinkedOnly: false });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(2);
  });

  test("metadata defaults to {} when person.metadata is empty", () => {
    seedPerson(fixture.db, { id: "p1" });
    const r = call("people.list", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list[0]?.["metadata"]).toEqual({});
  });
});

describe("people.list — notReviewed param validation", () => {
  test("non-boolean notReviewed -> -32602, never silently ignored", () => {
    try {
      call("people.list", { notReviewed: "yes" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PeopleRpcError);
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("notReviewed");
    }
  });

  test("null notReviewed reads as ABSENT, not an error", () => {
    seedPerson(fixture.db, { id: "p1" });
    const r = call("people.list", { notReviewed: null });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    // Plain path: bare array, unchanged from today.
    expect(Array.isArray(r.value)).toBe(true);
  });

  test("non-finite sinceMs -> -32602", () => {
    try {
      call("people.list", { notReviewed: true, sinceMs: Number.POSITIVE_INFINITY });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("sinceMs");
    }
  });

  test("non-number sinceMs -> -32602", () => {
    try {
      call("people.list", { notReviewed: true, sinceMs: "7d" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("sinceMs");
    }
  });

  test("null sinceMs reads as ABSENT, not an error", () => {
    // notReviewed true + no reviewed edges anywhere -> refusal, not a validation error.
    const r = call("people.list", { notReviewed: true, sinceMs: null });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { status?: string };
    expect(v.status).toBe("refused");
  });
});

describe("people.list — --not-reviewed", () => {
  test("refuses when no reviewed edges exist anywhere (empty substrate)", () => {
    seedPersonWithoutReview(fixture.db, "bob");
    const r = call("people.list", { notReviewed: true, sinceMs: 1 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as {
      status?: string;
      reason?: string;
      message?: string;
      remediation?: string;
    };
    expect(v.status).toBe("refused");
    expect(v.reason).toBe("missing_substrate");
    expect(typeof v.message).toBe("string");
    expect(typeof v.remediation).toBe("string");
    expect(v).not.toHaveProperty("explain");
  });

  test("refusal carries explain when requested", () => {
    seedPersonWithoutReview(fixture.db, "bob");
    const r = call("people.list", { notReviewed: true, sinceMs: 1, explain: true });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as {
      status?: string;
      explain?: { sql: string; params: unknown[]; substrate: unknown };
    };
    expect(v.status).toBe("refused");
    expect(typeof v.explain?.sql).toBe("string");
    expect(Array.isArray(v.explain?.params)).toBe(true);
    expect(v.explain?.substrate).toBeDefined();
  });

  test("returns only people with no reviewed edge in the window, wrapped with gaps and meta", () => {
    seedPersonWithReview(fixture.db, "alice", Date.now());
    seedPersonWithoutReview(fixture.db, "bob");
    const r = call("people.list", {
      notReviewed: true,
      sinceMs: Date.now() - 7 * 86_400_000,
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as {
      people: Array<{ id: string }>;
      gaps: { excludedNoGraphEntity: number };
      meta: { limit: number; total: number };
    };
    expect(v.people.map((p) => p.id)).toEqual(["bob"]);
    expect(v.gaps).toEqual({ excludedNoGraphEntity: 0 });
    // Important 4 (Task 4 fix round 1): the negation wrapper carries `meta`, matching the
    // `index.queryItems` items path — omitting it left a LIMIT-truncated answer with no
    // truncation signal beside it.
    expect(v.meta).toEqual({ limit: 100, total: 1 });
    expect(v).not.toHaveProperty("explain");
  });

  test("meta.total reflects a LIMIT-truncated result, not the full matching count", () => {
    seedPersonWithReview(fixture.db, "eve", Date.now()); // non-empty substrate
    for (let i = 0; i < 5; i += 1) {
      seedPersonWithoutReview(fixture.db, `p${String(i)}`);
    }
    const r = call("people.list", { notReviewed: true, sinceMs: 1, limit: 2 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as {
      people: Array<{ id: string }>;
      meta: { limit: number; total: number };
    };
    expect(v.people).toHaveLength(2);
    expect(v.meta).toEqual({ limit: 2, total: 2 });
  });

  // Important 1 (Task 4 fix round 1): `explain.sql` must be the COMPOSED statement that actually
  // shaped `people` — running it back against the same db must reproduce the SAME ids, never a
  // wider set that ignores `unlinkedOnly`/`limit`.
  test("explain.sql is the composed statement — running it directly reproduces the same ids", () => {
    seedPersonWithReview(fixture.db, "eve", Date.now()); // non-empty substrate, linked
    seedPersonWithoutReview(fixture.db, "bob");
    fixture.db.run("UPDATE person SET linked = 0 WHERE id = 'bob'");
    seedPersonWithoutReview(fixture.db, "carol"); // linked, graphed, no review
    const r = call("people.list", {
      notReviewed: true,
      sinceMs: 1,
      unlinkedOnly: true,
      limit: 5,
      explain: true,
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as {
      people: Array<{ id: string }>;
      explain: { sql: string; params: Array<string | number> };
    };
    expect(v.people.map((p) => p.id)).toEqual(["bob"]);
    const rows = fixture.db.query(v.explain.sql).all(...v.explain.params) as Array<{
      id: string;
    }>;
    expect(rows.map((row) => row.id)).toEqual(["bob"]);
  });

  // Important 3 (Task 4 fix round 1, controller ruling): a reviewed edge that exists but falls
  // OUTSIDE the query's own `--since` window must not make the probe pass — the probe must be
  // windowed the same way the query is, or a quiet recent window with only stale edges returns
  // every graphed person as a false "clean" answer instead of refusing.
  test("a reviewed edge OLDER than the window refuses rather than flooding false positives", () => {
    seedPersonWithReview(fixture.db, "alice", 500); // reviewed, but before the window starts
    seedPersonWithoutReview(fixture.db, "bob");
    const r = call("people.list", { notReviewed: true, sinceMs: 1_000 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { status?: string; reason?: string };
    expect(v.status).toBe("refused");
    expect(v.reason).toBe("missing_substrate");
  });

  test("a person with no graph entity is dropped from results but counted in gaps", () => {
    seedPersonWithReview(fixture.db, "alice", Date.now()); // non-empty substrate
    seedPersonWithoutReview(fixture.db, "bob");
    seedPerson(fixture.db, { id: "carol" }); // no graph_entity row at all
    const r = call("people.list", { notReviewed: true, sinceMs: 1 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { people: Array<{ id: string }>; gaps: { excludedNoGraphEntity: number } };
    expect(v.people.map((p) => p.id)).toEqual(["bob"]);
    expect(v.gaps).toEqual({ excludedNoGraphEntity: 1 });
  });

  test("unlinkedOnly composes with notReviewed", () => {
    seedPersonWithReview(fixture.db, "alice", Date.now()); // non-empty substrate
    seedPersonWithoutReview(fixture.db, "bob");
    fixture.db.run("UPDATE person SET linked = 0 WHERE id = 'bob'");
    seedPersonWithoutReview(fixture.db, "carol");
    fixture.db.run("UPDATE person SET linked = 1 WHERE id = 'carol'");
    const r = call("people.list", { notReviewed: true, sinceMs: 1, unlinkedOnly: true });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { people: Array<{ id: string }> };
    expect(v.people.map((p) => p.id)).toEqual(["bob"]);
  });

  // Important 2 (Task 4 fix round 1): `gaps` must be scoped to the SAME `unlinkedOnly` the query
  // used. Unscoped, this exact setup reports `dave` (linked, ungraphed) in the count even though
  // `dave` could never have appeared in an `unlinkedOnly: true` result set.
  test("gaps is scoped to unlinkedOnly — a LINKED person's exclusion is not counted", () => {
    seedPersonWithReview(fixture.db, "eve", Date.now()); // non-empty substrate
    seedPersonWithoutReview(fixture.db, "bob");
    fixture.db.run("UPDATE person SET linked = 0 WHERE id = 'bob'");
    seedPerson(fixture.db, { id: "carol" }); // no graph_entity row, linked (default)
    seedPerson(fixture.db, { id: "dave" }); // no graph_entity row, unlinked
    fixture.db.run("UPDATE person SET linked = 0 WHERE id = 'dave'");
    const r = call("people.list", { notReviewed: true, sinceMs: 1, unlinkedOnly: true });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { people: Array<{ id: string }>; gaps: { excludedNoGraphEntity: number } };
    expect(v.people.map((p) => p.id)).toEqual(["bob"]);
    // Only `dave` (unlinked, ungraphed) counts — `carol` (linked, ungraphed) is out of scope.
    expect(v.gaps).toEqual({ excludedNoGraphEntity: 1 });
  });

  test("no --since supplied defaults to sinceMs 0, meaning 'reviewed ever'", () => {
    seedPersonWithReview(fixture.db, "alice", 1); // reviewed at ts=1, long ago but > 0
    seedPersonWithoutReview(fixture.db, "bob");
    const r = call("people.list", { notReviewed: true });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { people: Array<{ id: string }> };
    expect(v.people.map((p) => p.id)).toEqual(["bob"]);
  });

  test("non-negation explain=true still returns the bare-array data, wrapped", () => {
    seedPerson(fixture.db, { id: "p1" });
    const r = call("people.list", { explain: true });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as {
      people: Array<{ id: string }>;
      explain: { sql: string; params: unknown[] };
    };
    expect(v.people.map((p) => p.id)).toEqual(["p1"]);
    expect(typeof v.explain.sql).toBe("string");
    expect(Array.isArray(v.explain.params)).toBe(true);
    expect(v).not.toHaveProperty("gaps");
  });

  test("plain call with no negation params returns the SAME bare array as before", () => {
    seedPerson(fixture.db, { id: "p1" });
    seedPerson(fixture.db, { id: "p2" });
    const r = call("people.list", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(Array.isArray(r.value)).toBe(true);
    const list = r.value as Array<{ id: string }>;
    expect(list.map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("people.unlinked", () => {
  test("returns only unlinked", () => {
    seedPerson(fixture.db, { id: "p_a", linked: false });
    seedPerson(fixture.db, { id: "p_b", linked: true });
    seedPerson(fixture.db, { id: "p_c", linked: false });
    const r = call("people.unlinked", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list.map((p) => p["id"]).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "p_a",
      "p_c",
    ]);
  });

  test("honors custom limit", () => {
    seedPerson(fixture.db, { id: "p_a", linked: false });
    seedPerson(fixture.db, { id: "p_b", linked: false });
    seedPerson(fixture.db, { id: "p_c", linked: false });
    const r = call("people.unlinked", { limit: 2 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(2);
  });
});

describe("people.search", () => {
  test("query filter matches displayName", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "Alice Wonder" });
    seedPerson(fixture.db, { id: "p2", displayName: "Bob Smith" });
    const r = call("people.search", { query: "alice" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list.map((p) => p["id"])).toEqual(["p1"]);
  });

  test("empty query falls back to list-all", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    seedPerson(fixture.db, { id: "p2", displayName: "B" });
    const r = call("people.search", { query: "" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(2);
  });

  test("missing query is treated as empty", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.search", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(1);
  });

  test("non-string query is treated as empty", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.search", { query: 42 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(1);
  });
});

describe("people.items", () => {
  test("returns items for a known person, ordered by modified_at DESC", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    seedItem(fixture.db, {
      id: "github:i_old",
      service: "github",
      externalId: "i_old",
      authorId: "p1",
      modifiedAt: 1_000,
    });
    seedItem(fixture.db, {
      id: "github:i_new",
      service: "github",
      externalId: "i_new",
      authorId: "p1",
      modifiedAt: 5_000,
    });
    seedItem(fixture.db, {
      id: "github:i_other",
      service: "github",
      externalId: "i_other",
      authorId: "p_other",
    });
    const r = call("people.items", { personId: "p1" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const items = r.value as Array<Record<string, unknown>>;
    expect(items.map((i) => i["id"])).toEqual(["i_new", "i_old"]);
  });

  test("returns empty array for a known person with no items", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.items", { personId: "p1" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual([]);
  });

  test("unknown personId throws -32602", () => {
    try {
      call("people.items", { personId: "missing" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("Unknown person id");
    }
  });

  test("custom limit is honored", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    for (let i = 0; i < 5; i++) {
      seedItem(fixture.db, {
        id: `github:i${i}`,
        service: "github",
        externalId: `i${i}`,
        authorId: "p1",
        modifiedAt: 1_000 + i,
      });
    }
    const r = call("people.items", { personId: "p1", limit: 2 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(2);
  });
});

describe("people.merge", () => {
  test("same id returns survivor without throwing", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.merge", { personIdA: "p1", personIdB: "p1" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { survivorId: string; person: Record<string, unknown> };
    expect(v.survivorId).toBe("p1");
    expect(v.person["id"]).toBe("p1");
  });

  test("unknown person id -> -32602", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    try {
      call("people.merge", { personIdA: "p1", personIdB: "missing" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("unknown person id");
    }
  });

  test("conflicting canonical emails -> -32602", () => {
    seedPerson(fixture.db, { id: "p1", canonicalEmail: "a@example.com" });
    seedPerson(fixture.db, { id: "p2", canonicalEmail: "b@example.com" });
    try {
      call("people.merge", { personIdA: "p1", personIdB: "p2" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("conflicting canonical emails");
    }
  });

  test("happy path merges handles and reassigns items (both emails null)", () => {
    seedPerson(fixture.db, {
      id: "p_keep",
      displayName: "Keeper",
      githubLogin: null,
      linked: false,
    });
    seedPerson(fixture.db, {
      id: "p_drop",
      displayName: "Other",
      githubLogin: "ghuser",
      linked: true,
    });
    seedItem(fixture.db, {
      id: "github:i1",
      service: "github",
      externalId: "i1",
      authorId: "p_drop",
    });
    const r = call("people.merge", { personIdA: "p_keep", personIdB: "p_drop" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { survivorId: string; person: Record<string, unknown> };
    expect(v.survivorId).toBe("p_keep");
    expect(v.person["githubLogin"]).toBe("ghuser");
    expect(v.person["canonicalEmail"]).toBeNull();
    expect(v.person["linked"]).toBe(true);
    expect(v.person["itemCount"]).toBe(1);

    const dropRow = fixture.db.query("SELECT id FROM person WHERE id = ?").get("p_drop") as {
      id: string;
    } | null;
    expect(dropRow).toBeNull();
  });

  test("UNIQUE-constraint conflict surfaces as -32603 (catchall)", () => {
    seedPerson(fixture.db, { id: "p_keep" });
    seedPerson(fixture.db, { id: "p_drop", canonicalEmail: "x@example.com" });
    try {
      call("people.merge", { personIdA: "p_keep", personIdB: "p_drop" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32603);
    }
  });
});
